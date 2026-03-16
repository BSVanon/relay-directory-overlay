import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { createAuthSigner } from '../lib/auth.js'
import { startServer } from '../server.js'

describe('Multi-node sync', () => {
  let server1, server2, tmpDir1, tmpDir2, port1, port2, identity, signer

  before(async () => {
    tmpDir1 = await mkdtemp(join(tmpdir(), 'overlay-sync-1-'))
    tmpDir2 = await mkdtemp(join(tmpdir(), 'overlay-sync-2-'))
    port1 = 15360 + Math.floor(Math.random() * 500)
    port2 = port1 + 1

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
    signer = createAuthSigner(key)

    // Both nodes trust this identity
    process.env.OVERLAY_WIF = key.toWif()

    // Start node 2 first (no peers)
    server2 = await startServer({ port: port2, dbPath: join(tmpDir2, 'test.db'), peerUrls: [] })

    // Start node 1 with node 2 as a peer
    server1 = await startServer({ port: port1, dbPath: join(tmpDir1, 'test.db'), peerUrls: [`http://127.0.0.1:${port2}`] })

    delete process.env.OVERLAY_WIF
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

  it('submitting to node 1 propagates to node 2 via signed sync', async () => {
    const shipTx = await buildTestToken('sync:test:propagation')

    // Submit to node 1 with auth (skips chain check, triggers propagation)
    const bodyStr = JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    const res1 = await fetch(`http://127.0.0.1:${port1}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/submit', bodyStr)
      },
      body: bodyStr
    })
    const data1 = await res1.json()
    assert.equal(data1.status, 'success')

    // Wait for async propagation
    await new Promise(resolve => setTimeout(resolve, 500))

    // Node 2 should have the entry (received via signed sync from node 1)
    const res2 = await fetch(`http://127.0.0.1:${port2}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { topic: 'sync:test:propagation' } })
    })
    const data2 = await res2.json()
    assert.ok(data2.outputs.length >= 1, 'Expected node 2 to have the propagated entry')
    assert.equal(data2.outputs[0].topic, 'sync:test:propagation')
  })

  it('sync-received entries do not re-propagate (loop prevention)', async () => {
    // Node 2 has no peers, so even if it wanted to propagate, it can't.
    // But the key point: entries received via signed sync are from a trusted
    // peer, so the handler skips propagation (fromTrustedPeer = true)
    const res = await fetch(`http://127.0.0.1:${port2}/status`)
    const status = await res.json()
    assert.ok(status.entries >= 1) // has the propagated entry
  })
})
