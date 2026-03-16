import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { loadIdentity, buildShipTx } from '../lib/wallet.js'
import { DirectoryClient } from '../lib/client.js'
import { startServer } from '../server.js'

describe('DirectoryClient', () => {
  let serverCtx, tmpDir, port, identity, client

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-client-test-'))
    port = 14360 + Math.floor(Math.random() * 1000)
    serverCtx = await startServer({ port, dbPath: join(tmpDir, 'test.db') })

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
    client = new DirectoryClient(`http://127.0.0.1:${port}`)

    // Seed with a test SHIP token
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(identity.identityPub.toAddress()), satoshis: 100000 })
    const shipTx = await buildShipTx({
      identityKey: identity.identityKey,
      domain: 'test.example.com',
      topic: 'oracle:rates:bsv',
      utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
    })
    await client.submit(shipTx.txHex, shipTx.shipOutputIndex)
  })

  after(async () => {
    serverCtx.server.close()
    await serverCtx.store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('status returns healthy overlay', async () => {
    const s = await client.status()
    assert.equal(s.status, 'ok')
    assert.equal(s.entries, 1)
  })

  it('findByTopic returns matching bridges', async () => {
    const results = await client.findByTopic('oracle:rates:bsv')
    assert.equal(results.length, 1)
    assert.equal(results[0].topic, 'oracle:rates:bsv')
    assert.equal(results[0].domain, 'test.example.com')
  })

  it('findByTopic returns empty for unknown topic', async () => {
    const results = await client.findByTopic('oracle:rates:nonexistent')
    assert.equal(results.length, 0)
  })

  it('findByBridge returns topics for known bridge', async () => {
    const results = await client.findByBridge(identity.identityPubHex)
    assert.equal(results.length, 1)
    assert.equal(results[0].topic, 'oracle:rates:bsv')
  })

  it('listTopics returns topic summaries', async () => {
    const topics = await client.listTopics()
    assert.ok(topics.length >= 1)
    const bsv = topics.find(t => t.topic === 'oracle:rates:bsv')
    assert.ok(bsv)
    assert.equal(bsv.count, 1)
  })

  it('listAll returns all entries', async () => {
    const all = await client.listAll()
    assert.ok(all.length >= 1)
  })
})
