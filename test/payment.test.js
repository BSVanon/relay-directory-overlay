import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { startServer } from '../server.js'

describe('BRC-105 payment middleware', () => {
  let paidServer, freeServer, tmpDir1, tmpDir2, paidPort, freePort, identity

  before(async () => {
    tmpDir1 = await mkdtemp(join(tmpdir(), 'overlay-pay-1-'))
    tmpDir2 = await mkdtemp(join(tmpdir(), 'overlay-pay-2-'))
    paidPort = 16360 + Math.floor(Math.random() * 500)
    freePort = paidPort + 1

    // Set pricing env vars for the paid server
    process.env.OVERLAY_PRICE_SUBMIT = '100'
    process.env.OVERLAY_PRICE_LOOKUP = '10'
    paidServer = await startServer({ port: paidPort, dbPath: join(tmpDir1, 'test.db'), peerUrls: [] })
    delete process.env.OVERLAY_PRICE_SUBMIT
    delete process.env.OVERLAY_PRICE_LOOKUP

    // Free server (default pricing = 0)
    freeServer = await startServer({ port: freePort, dbPath: join(tmpDir2, 'test.db'), peerUrls: [] })

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
  })

  after(async () => {
    paidServer.server.close()
    freeServer.server.close()
    await paidServer.store.close()
    await freeServer.store.close()
    await rm(tmpDir1, { recursive: true, force: true })
    await rm(tmpDir2, { recursive: true, force: true })
  })

  async function buildTestToken (topic = 'oracle:rates:bsv') {
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(identity.identityPub.toAddress()), satoshis: 100000 })
    return buildShipTx({
      identityKey: identity.identityKey,
      domain: 'test.example.com',
      topic,
      utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
    })
  }

  // ── Free server (default) ──

  it('free server accepts submit without payment', async () => {
    const shipTx = await buildTestToken()
    const res = await fetch(`http://127.0.0.1:${freePort}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.status, 'success')
  })

  // ── Paid server ──

  it('paid server returns 402 for submit without payment', async () => {
    const shipTx = await buildTestToken('pay:test:submit')
    const res = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    assert.equal(res.status, 402)
    const data = await res.json()
    assert.equal(data.status, 'payment_required')
    assert.equal(data.satoshisRequired, 100)
    assert.ok(data.derivationPrefix)
  })

  it('paid server returns BRC-105 headers on 402', async () => {
    const res = await fetch(`http://127.0.0.1:${paidPort}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { list: 'topics' } })
    })
    assert.equal(res.status, 402)
    assert.ok(res.headers.get('x-bsv-payment-version'))
    assert.equal(res.headers.get('x-bsv-payment-satoshis-required'), '10')
    assert.ok(res.headers.get('x-bsv-payment-derivation-prefix'))
  })

  it('paid server accepts submit with payment header (stub verification)', async () => {
    const shipTx = await buildTestToken('pay:test:accepted')
    const res = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bsv-payment': JSON.stringify({ derivationPrefix: 'test', transaction: 'stub' })
      },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.status, 'success')
  })

  it('paid server rejects invalid payment header JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${paidPort}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bsv-payment': 'not-valid-json'
      },
      body: JSON.stringify({ rawTx: 'ff', outputIndex: 0 })
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.code, 'ERR_INVALID_PAYMENT')
  })

  it('status endpoint is always free (no payment gate)', async () => {
    const res = await fetch(`http://127.0.0.1:${paidPort}/status`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.status, 'ok')
  })
})
