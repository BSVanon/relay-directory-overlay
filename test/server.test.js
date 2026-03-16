import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { startServer } from '../server.js'

describe('HTTP server', () => {
  let serverCtx, tmpDir, port, identity

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-server-test-'))
    port = 13360 + Math.floor(Math.random() * 1000)
    serverCtx = await startServer({ port, dbPath: join(tmpDir, 'test.db') })

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
  })

  after(async () => {
    serverCtx.server.close()
    await serverCtx.store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  function url (path) {
    return `http://127.0.0.1:${port}${path}`
  }

  async function buildTestToken (topic = 'oracle:rates:bsv') {
    const { Transaction, P2PKH } = await import('@bsv/sdk')
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({
      lockingScript: p2pkh.lock(identity.identityPub.toAddress()),
      satoshis: 100000
    })
    return buildShipTx({
      identityKey: identity.identityKey,
      domain: 'test.example.com',
      topic,
      utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
    })
  }

  // ── Status ──

  it('GET /status returns ok', async () => {
    const res = await fetch(url('/status'))
    const data = await res.json()
    assert.equal(data.status, 'ok')
    assert.equal(data.service, 'relay-directory-overlay')
  })

  // ── Submit (BRC-22) ──

  it('POST /submit admits with simplified body (txHex + outputIndex)', async () => {
    const shipTx = await buildTestToken()
    const res = await fetch(url('/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    const data = await res.json()
    assert.equal(data.status, 'success')
    assert.ok(data.topics['oracle:rates:bsv'])
    assert.ok(data.topics['oracle:rates:bsv'].includes(shipTx.shipOutputIndex))
  })

  it('POST /submit admits with BRC-22 canonical body (rawTx)', async () => {
    const shipTx = await buildTestToken('oracle:rates:eth')
    const res = await fetch(url('/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, topics: ['SHIP'] })
    })
    const data = await res.json()
    assert.equal(data.status, 'success')
    assert.ok(data.topics['oracle:rates:eth'])
  })

  it('POST /submit rejects missing tx', async () => {
    const res = await fetch(url('/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.status, 'error')
    assert.equal(data.code, 'ERR_MISSING_TX')
  })

  // ── Lookup (BRC-24) ──

  it('POST /lookup by topic returns BRC-36 style outputs', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'relay-topic-lookup', query: { topic: 'oracle:rates:bsv' } })
    })
    const data = await res.json()
    assert.equal(data.type, 'output-list')
    assert.ok(Array.isArray(data.outputs))
    assert.ok(data.outputs.length >= 1)
    // Verify BRC-36 fields
    const out = data.outputs[0]
    assert.ok(out.txid)
    assert.equal(typeof out.vout, 'number')
    assert.equal(typeof out.satoshis, 'number')
    // Verify overlay metadata
    assert.equal(out.topic, 'oracle:rates:bsv')
    assert.ok(out.domain)
    assert.ok(out.identityPubHex)
  })

  it('POST /lookup by bridge returns outputs', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'relay-topic-lookup', query: { bridge: identity.identityPubHex } })
    })
    const data = await res.json()
    assert.equal(data.type, 'output-list')
    assert.ok(data.outputs.length >= 1)
  })

  it('POST /lookup list topics returns summary', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { list: 'topics' } })
    })
    const data = await res.json()
    assert.equal(data.type, 'topic-summary')
    assert.ok(Array.isArray(data.results))
    assert.ok(data.results.length >= 2)
    const bsvTopic = data.results.find(t => t.topic === 'oracle:rates:bsv')
    assert.ok(bsvTopic)
    assert.equal(bsvTopic.count, 1)
  })

  it('POST /lookup list all returns BRC-36 outputs', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { list: 'all' } })
    })
    const data = await res.json()
    assert.equal(data.type, 'output-list')
    assert.ok(data.outputs.length >= 2)
  })

  it('POST /lookup rejects unsupported provider', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nonexistent', query: { topic: 'test:foo' } })
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.code, 'ERR_LOOKUP_SERVICE_NOT_SUPPORTED')
  })

  it('POST /lookup rejects unsupported query', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { unknown: true } })
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'ERR_UNSUPPORTED_QUERY')
  })

  it('POST /lookup rejects missing query', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'ERR_MISSING_QUERY')
  })

  // ── Revoke ──

  it('POST /revoke removes an entry when valid spend proof provided', async () => {
    const lookupBefore = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'oracle:rates:bsv' } })
    })
    const beforeData = await lookupBefore.json()
    assert.ok(beforeData.outputs.length >= 1)
    const entry = beforeData.outputs[0]

    // Build a minimal raw tx that has an input referencing the SHIP outpoint.
    // We only need the serialized bytes to contain the right sourceTXID and vout.
    // Format: version(4) + inputCount(1) + prevTxid(32 LE) + prevVout(4 LE) + scriptLen(1) + script(0) + sequence(4) + outputCount(1) + value(8) + scriptLen(1) + script(0) + locktime(4)
    const txidLE = Buffer.from(entry.txid, 'hex').reverse()
    const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(entry.vout)
    const spendingTxHex = Buffer.concat([
      Buffer.from('01000000', 'hex'),   // version
      Buffer.from('01', 'hex'),          // 1 input
      txidLE,                             // prev txid (little-endian)
      voutBuf,                            // prev vout
      Buffer.from('0100', 'hex'),        // script length 1, script OP_0
      Buffer.from('ffffffff', 'hex'),    // sequence
      Buffer.from('01', 'hex'),          // 1 output
      Buffer.from('0100000000000000', 'hex'), // 1 satoshi
      Buffer.from('0100', 'hex'),        // script length 1, script OP_0
      Buffer.from('00000000', 'hex')     // locktime
    ]).toString('hex')

    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spendingTxHex,
        spentTxid: entry.txid,
        spentOutputIndex: entry.vout
      })
    })
    const data = await res.json()
    assert.equal(data.revoked, true)

    const lookupAfter = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'oracle:rates:bsv' } })
    })
    const afterData = await lookupAfter.json()
    assert.equal(afterData.outputs.length, 0)
  })

  it('POST /revoke rejects when spending tx does not consume the outpoint', async () => {
    // Submit a fresh token to have something to revoke
    const shipTx = await buildTestToken('oracle:rates:jpy')
    await fetch(url('/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })

    // Build a spending tx referencing a WRONG outpoint
    const wrongTxid = 'aa'.repeat(32)
    const txidLE = Buffer.from(wrongTxid, 'hex').reverse()
    const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(99)
    const fakeTxHex = Buffer.concat([
      Buffer.from('01000000', 'hex'),
      Buffer.from('01', 'hex'),
      txidLE,
      voutBuf,
      Buffer.from('0100', 'hex'),
      Buffer.from('ffffffff', 'hex'),
      Buffer.from('01', 'hex'),
      Buffer.from('0100000000000000', 'hex'),
      Buffer.from('0100', 'hex'),
      Buffer.from('00000000', 'hex')
    ]).toString('hex')

    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spendingTxHex: fakeTxHex,
        spentTxid: shipTx.txid,
        spentOutputIndex: shipTx.shipOutputIndex
      })
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.reason, 'spending_tx_does_not_consume_outpoint')
  })

  it('POST /revoke rejects missing fields', async () => {
    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 400)
  })

  it('POST /revoke rejects invalid spending tx hex', async () => {
    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spendingTxHex: 'notavalidtx',
        spentTxid: 'aa'.repeat(32),
        spentOutputIndex: 0
      })
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.reason, 'invalid_spending_tx')
  })

  // ── Misc ──

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(url('/nonexistent'))
    assert.equal(res.status, 404)
  })
})
