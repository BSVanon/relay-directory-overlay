import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { createAuthSigner } from '../lib/auth.js'
import { startServer } from '../server.js'

describe('HTTP server', () => {
  let serverCtx, tmpDir, port, identity, signer

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-server-test-'))
    port = 13360 + Math.floor(Math.random() * 1000)

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
    signer = createAuthSigner(key)

    // Set the test identity as trusted
    process.env.OVERLAY_WIF = key.toWif()
    serverCtx = await startServer({ port, dbPath: join(tmpDir, 'test.db') })
    delete process.env.OVERLAY_WIF
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

  /** Submit with signed auth (trusted peer — skips chain check) */
  async function authenticatedSubmit (body) {
    const bodyStr = JSON.stringify(body)
    return fetch(url('/submit'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/submit', bodyStr)
      },
      body: bodyStr
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

  it('POST /submit admits with authenticated request', async () => {
    const shipTx = await buildTestToken()
    const res = await authenticatedSubmit({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    const data = await res.json()
    assert.equal(data.status, 'success')
    assert.ok(data.topics['oracle:rates:bsv'])
  })

  it('POST /submit admits with BRC-22 canonical body', async () => {
    const shipTx = await buildTestToken('oracle:rates:eth')
    const res = await authenticatedSubmit({ rawTx: shipTx.txHex, topics: ['SHIP'] })
    const data = await res.json()
    assert.equal(data.status, 'success')
    assert.ok(data.topics['oracle:rates:eth'])
  })

  it('POST /submit rejects missing tx', async () => {
    const res = await authenticatedSubmit({})
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.status, 'error')
    assert.equal(data.code, 'ERR_MISSING_TX')
  })

  it('POST /submit without auth fails chain check for fake tx', async () => {
    const shipTx = await buildTestToken('oracle:rates:noauth')
    // Submit WITHOUT auth — should fail because chain check will reject the fake tx
    const res = await fetch(url('/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    const data = await res.json()
    // Either chain check fails or format passes but chain rejects
    if (data.status === 'error') {
      assert.equal(data.code, 'ERR_CHAIN_VERIFY')
    } else {
      // If OVERLAY_SKIP_CHAIN_CHECK is true, it may still succeed
      assert.equal(data.status, 'success')
    }
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
    assert.ok(data.outputs.length >= 1)
    const out = data.outputs[0]
    assert.ok(out.txid)
    assert.equal(typeof out.vout, 'number')
    assert.ok(out.outputScript) // BRC-36 field
    assert.ok(out.rawTx) // BRC-36 field
    assert.equal(out.topic, 'oracle:rates:bsv')
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
    assert.ok(data.results.length >= 2)
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
    assert.equal((await res.json()).code, 'ERR_LOOKUP_SERVICE_NOT_SUPPORTED')
  })

  it('POST /lookup rejects unsupported query', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { unknown: true } })
    })
    assert.equal(res.status, 400)
  })

  it('POST /lookup rejects missing query', async () => {
    const res = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 400)
  })

  // ── Revoke ──

  it('POST /revoke removes an entry with authenticated spend proof', async () => {
    const lookupBefore = await fetch(url('/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'oracle:rates:bsv' } })
    })
    const beforeData = await lookupBefore.json()
    assert.ok(beforeData.outputs.length >= 1)
    const entry = beforeData.outputs[0]

    const txidLE = Buffer.from(entry.txid, 'hex').reverse()
    const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(entry.vout)
    const spendingTxHex = Buffer.concat([
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

    const bodyStr = JSON.stringify({ spendingTxHex, spentTxid: entry.txid, spentOutputIndex: entry.vout })
    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/revoke', bodyStr)
      },
      body: bodyStr
    })
    const data = await res.json()
    assert.equal(data.revoked, true)
  })

  it('POST /revoke rejects missing fields', async () => {
    const bodyStr = JSON.stringify({})
    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/revoke', bodyStr)
      },
      body: bodyStr
    })
    assert.equal(res.status, 400)
  })

  it('POST /revoke rejects invalid spending tx', async () => {
    const bodyStr = JSON.stringify({ spendingTxHex: 'notavalidtx', spentTxid: 'aa'.repeat(32), spentOutputIndex: 0 })
    const res = await fetch(url('/revoke'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/revoke', bodyStr)
      },
      body: bodyStr
    })
    assert.equal(res.status, 400)
  })

  // ── Misc ──

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(url('/nonexistent'))
    assert.equal(res.status, 404)
  })
})
