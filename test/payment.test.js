import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { loadIdentity, deriveChild } from '../lib/wallet.js'
import { createPaymentVerifier, clearIssuedPrefixes } from '../lib/payment.js'
import { startServer } from '../server.js'

describe('BRC-105 payment', () => {
  // ── Unit tests for the verifier ──
  describe('createPaymentVerifier', () => {
    const testKey = PrivateKey.fromRandom()
    let verifier

    before(() => {
      verifier = createPaymentVerifier(testKey)
    })

    beforeEach(() => {
      clearIssuedPrefixes()
    })

    it('rejects unknown derivation prefix', async () => {
      const result = await verifier({ derivationPrefix: 'unknown', transaction: 'ff' }, 100)
      assert.equal(result.valid, false)
      assert.ok(result.reason.includes('unknown'))
    })

    it('rejects missing fields', async () => {
      const result = await verifier({}, 100)
      assert.equal(result.valid, false)
      assert.ok(result.reason.includes('missing'))
    })
  })

  // ── Integration tests with real server ──
  describe('HTTP payment flow', () => {
    let paidServer, freeServer, tmpDir1, tmpDir2, paidPort, freePort, identity

    before(async () => {
      tmpDir1 = await mkdtemp(join(tmpdir(), 'overlay-pay-1-'))
      tmpDir2 = await mkdtemp(join(tmpdir(), 'overlay-pay-2-'))
      paidPort = 16360 + Math.floor(Math.random() * 500)
      freePort = paidPort + 1

      const key = PrivateKey.fromRandom()
      identity = loadIdentity(key.toWif())

      // Paid server — set pricing env vars AND the WIF for verifier
      process.env.OVERLAY_PRICE_SUBMIT = '100'
      process.env.OVERLAY_PRICE_LOOKUP = '10'
      process.env.OVERLAY_WIF = key.toWif()
      paidServer = await startServer({ port: paidPort, dbPath: join(tmpDir1, 'test.db'), peerUrls: [] })
      delete process.env.OVERLAY_PRICE_SUBMIT
      delete process.env.OVERLAY_PRICE_LOOKUP
      delete process.env.OVERLAY_WIF

      // Free server
      freeServer = await startServer({ port: freePort, dbPath: join(tmpDir2, 'test.db'), peerUrls: [] })
    })

    after(async () => {
      paidServer.server.close()
      freeServer.server.close()
      await paidServer.store.close()
      await freeServer.store.close()
      await rm(tmpDir1, { recursive: true, force: true })
      await rm(tmpDir2, { recursive: true, force: true })
    })

    it('free server accepts without payment', async () => {
      const res = await fetch(`http://127.0.0.1:${freePort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(res.status, 200)
    })

    it('paid server returns 402 with BRC-105 headers', async () => {
      const res = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-bsv-payment-version'), '1.0')
      assert.equal(res.headers.get('x-bsv-payment-satoshis-required'), '10')
      assert.ok(res.headers.get('x-bsv-payment-derivation-prefix'))
      const body = await res.json()
      assert.equal(body.satoshisRequired, 10)
      assert.ok(body.derivationPrefix)
    })

    it('paid server accepts valid payment transaction', async () => {
      // Step 1: Get the 402 challenge
      const challengeRes = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(challengeRes.status, 402)
      const challenge = await challengeRes.json()

      // Step 2: Build a payment tx to the derived address
      const { childKey } = deriveChild(identity.identityKey, challenge.derivationPrefix)
      const paymentAddress = childKey.toPublicKey().toAddress()

      // Build a fake-funded payment tx paying 10 sats to the derived address
      const p2pkh = new P2PKH()
      const payerKey = PrivateKey.fromRandom()
      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), satoshis: 50000 })

      const paymentTx = new Transaction()
      paymentTx.addInput({
        sourceTransaction: fundingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(payerKey, 'all', false, 50000)
      })
      paymentTx.addOutput({ lockingScript: p2pkh.lock(paymentAddress), satoshis: 10 })
      paymentTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), change: true })
      await paymentTx.fee(new (await import('@bsv/sdk')).SatoshisPerKilobyte(1000))
      await paymentTx.sign()

      // Step 3: Retry with payment
      const payRes = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-payment': JSON.stringify({
            derivationPrefix: challenge.derivationPrefix,
            transaction: paymentTx.toHex()
          })
        },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(payRes.status, 200)
      const data = await payRes.json()
      assert.equal(data.type, 'topic-summary')
    })

    it('paid server rejects payment with wrong derivation prefix', async () => {
      const res = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-payment': JSON.stringify({
            derivationPrefix: 'bogus-prefix',
            transaction: 'deadbeef'
          })
        },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(res.status, 402)
      const data = await res.json()
      assert.equal(data.code, 'ERR_PAYMENT_INVALID')
      assert.ok(data.description.includes('unknown'))
    })

    it('paid server rejects replay of consumed prefix', async () => {
      // Get a fresh challenge
      const c = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      const challenge = await c.json()

      // Build and submit valid payment
      const { childKey } = deriveChild(identity.identityKey, challenge.derivationPrefix)
      const paymentAddress = childKey.toPublicKey().toAddress()
      const p2pkh = new P2PKH()
      const payerKey = PrivateKey.fromRandom()
      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), satoshis: 50000 })
      const paymentTx = new Transaction()
      paymentTx.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: 0, unlockingScriptTemplate: p2pkh.unlock(payerKey, 'all', false, 50000) })
      paymentTx.addOutput({ lockingScript: p2pkh.lock(paymentAddress), satoshis: 10 })
      paymentTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), change: true })
      await paymentTx.fee(new (await import('@bsv/sdk')).SatoshisPerKilobyte(1000))
      await paymentTx.sign()

      const paymentHeader = JSON.stringify({ derivationPrefix: challenge.derivationPrefix, transaction: paymentTx.toHex() })

      // First use — should succeed
      const r1 = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bsv-payment': paymentHeader },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(r1.status, 200)

      // Replay — should fail
      const r2 = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bsv-payment': paymentHeader },
        body: JSON.stringify({ query: { list: 'topics' } })
      })
      assert.equal(r2.status, 402)
      const data = await r2.json()
      assert.ok(data.description.includes('consumed'))
    })

    it('paid server rejects insufficient payment amount', async () => {
      // Get a challenge for /submit (100 sats)
      const c = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawTx: 'ff' })
      })
      assert.equal(c.status, 402)
      const challenge = await c.json()
      assert.equal(challenge.satoshisRequired, 100)

      // Pay only 5 sats instead of 100
      const { childKey } = deriveChild(identity.identityKey, challenge.derivationPrefix)
      const paymentAddress = childKey.toPublicKey().toAddress()
      const p2pkh = new P2PKH()
      const payerKey = PrivateKey.fromRandom()
      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), satoshis: 50000 })
      const paymentTx = new Transaction()
      paymentTx.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: 0, unlockingScriptTemplate: p2pkh.unlock(payerKey, 'all', false, 50000) })
      paymentTx.addOutput({ lockingScript: p2pkh.lock(paymentAddress), satoshis: 5 }) // underpay
      paymentTx.addOutput({ lockingScript: p2pkh.lock(payerKey.toPublicKey().toAddress()), change: true })
      await paymentTx.fee(new (await import('@bsv/sdk')).SatoshisPerKilobyte(1000))
      await paymentTx.sign()

      const r = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-payment': JSON.stringify({ derivationPrefix: challenge.derivationPrefix, transaction: paymentTx.toHex() })
        },
        body: JSON.stringify({ rawTx: 'ff' })
      })
      assert.equal(r.status, 402)
      const data = await r.json()
      assert.ok(data.description.includes('insufficient'))
    })

    it('paid server rejects invalid payment JSON', async () => {
      const res = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bsv-payment': 'not-json' },
        body: JSON.stringify({ rawTx: 'ff' })
      })
      assert.equal(res.status, 400)
      const data = await res.json()
      assert.equal(data.code, 'ERR_INVALID_PAYMENT')
    })

    it('status is always free', async () => {
      const res = await fetch(`http://127.0.0.1:${paidPort}/status`)
      assert.equal(res.status, 200)
    })
  })
})
