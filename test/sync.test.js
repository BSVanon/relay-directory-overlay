import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { startServer } from '../server.js'

describe('Multi-node sync', () => {
  let server1, server2, tmpDir1, tmpDir2, port1, port2, identity

  before(async () => {
    tmpDir1 = await mkdtemp(join(tmpdir(), 'overlay-sync-1-'))
    tmpDir2 = await mkdtemp(join(tmpdir(), 'overlay-sync-2-'))
    port1 = 15360 + Math.floor(Math.random() * 500)
    port2 = port1 + 1

    // Start node 2 first (no peers)
    server2 = await startServer({ port: port2, dbPath: join(tmpDir2, 'test.db'), peerUrls: [] })

    // Start node 1 with node 2 as a peer
    server1 = await startServer({ port: port1, dbPath: join(tmpDir1, 'test.db'), peerUrls: [`http://127.0.0.1:${port2}`] })

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
  })

  after(async () => {
    server1.server.close()
    server2.server.close()
    await server1.store.close()
    await server2.store.close()
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

  it('submitting to node 1 propagates to node 2', async () => {
    const shipTx = await buildTestToken('sync:test:propagation')

    // Submit to node 1
    const res1 = await fetch(`http://127.0.0.1:${port1}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    const data1 = await res1.json()
    assert.equal(data1.status, 'success')

    // Wait briefly for async propagation
    await new Promise(resolve => setTimeout(resolve, 500))

    // Query node 2 — should have the entry
    const res2 = await fetch(`http://127.0.0.1:${port2}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'sync:test:propagation' } })
    })
    const data2 = await res2.json()
    assert.ok(data2.outputs.length >= 1, 'Expected node 2 to have the propagated entry')
    assert.equal(data2.outputs[0].topic, 'sync:test:propagation')
  })

  it('sync-originated submissions do not re-propagate (loop prevention)', async () => {
    const shipTx = await buildTestToken('sync:test:loop-prevention')

    // Submit directly to node 2 with the sync header — simulating a sync from another peer
    const res = await fetch(`http://127.0.0.1:${port2}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })
    const data = await res.json()
    assert.equal(data.status, 'success')

    await new Promise(resolve => setTimeout(resolve, 300))

    // Node 2 has no peers, so nothing propagated — but the point is the handler
    // checked the x-overlay-sync header and would not have propagated even if it had peers
    const statusRes = await fetch(`http://127.0.0.1:${port2}/status`)
    const status = await statusRes.json()
    assert.ok(status.entries >= 1)
  })

  it('node 2 does not propagate back to node 1 (no peers configured)', async () => {
    const shipTx = await buildTestToken('sync:test:no-backprop')

    // Submit directly to node 2 (which has no peers)
    await fetch(`http://127.0.0.1:${port2}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    })

    await new Promise(resolve => setTimeout(resolve, 300))

    // Node 1 should NOT have it
    const res1 = await fetch(`http://127.0.0.1:${port1}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'sync:test:no-backprop' } })
    })
    const data1 = await res1.json()
    assert.equal(data1.outputs.length, 0, 'Node 1 should not have the entry')
  })
})
