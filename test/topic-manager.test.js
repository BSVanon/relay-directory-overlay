import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadIdentity, deriveChild, buildShipTx } from '../lib/wallet.js'
import { ShipTopicManager } from '../lib/ship-topic-manager.js'
import { OverlayStore } from '../lib/store.js'

describe('ShipTopicManager', () => {
  let store, manager, tmpDir
  let identity, shipTxResult

  // Build a valid SHIP token for testing
  async function buildTestShipToken (topic = 'oracle:rates:bsv') {
    // We need a funded UTXO — create a fake funding tx
    const { Transaction, P2PKH } = await import('@bsv/sdk')
    const fundingKey = identity.identityKey
    const fundingPub = identity.identityPub
    const p2pkh = new P2PKH()

    // Create a dummy funding tx with 100,000 sats
    const fundingTx = new Transaction()
    fundingTx.addOutput({
      lockingScript: p2pkh.lock(fundingPub.toAddress()),
      satoshis: 100000
    })
    const fundingTxHex = fundingTx.toHex()

    return buildShipTx({
      identityKey: identity.identityKey,
      domain: 'test.example.com',
      topic,
      utxos: [{ txHex: fundingTxHex, outputIndex: 0, satoshis: 100000 }]
    })
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-test-'))
    store = new OverlayStore(join(tmpDir, 'test.db'))
    await store.open()
    manager = new ShipTopicManager(store)

    const key = PrivateKey.fromRandom()
    identity = loadIdentity(key.toWif())
  })

  afterEach(async () => {
    await store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('admits a valid SHIP token', async () => {
    const shipTx = await buildTestShipToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })

    assert.equal(result.admitted, true)
    assert.equal(result.entry.topic, 'oracle:rates:bsv')
    assert.equal(result.entry.domain, 'test.example.com')
    assert.equal(result.entry.identityPubHex, identity.identityPubHex)
  })

  it('rejects invalid tx hex', () => {
    const result = manager.evaluate({ txHex: 'deadbeef', outputIndex: 0 })
    assert.equal(result.admitted, false)
    // SDK may parse partial hex — rejection reason depends on parse result
    assert.ok(['invalid_tx', 'output_not_found', 'invalid_ship_format'].includes(result.reason))
  })

  it('rejects wrong output index', async () => {
    const shipTx = await buildTestShipToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: 99 })
    assert.equal(result.admitted, false)
    assert.equal(result.reason, 'output_not_found')
  })

  it('rejects a token with wrong BRC-42 derivation', async () => {
    const { Transaction } = await import('@bsv/sdk')
    const { buildShipScript } = await import('../lib/wallet.js')
    const wrongKey = PrivateKey.fromRandom()
    const wrongPub = wrongKey.toPublicKey()

    // Build BRC-48 script using our helper but with a non-derived locking key
    const script = buildShipScript({
      identityPubHex: identity.identityPubHex,
      domain: 'test.example.com',
      topic: 'oracle:rates:bsv',
      lockingPub: wrongPub // wrong — not derived from identity via BRC-42
    })

    const tx = new Transaction()
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    const result = manager.evaluate({ txHex: tx.toHex(), outputIndex: 0 })
    assert.equal(result.admitted, false)
    assert.equal(result.reason, 'derivation_mismatch')
  })

  it('admits and stores via store', async () => {
    const shipTx = await buildTestShipToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    assert.equal(result.admitted, true)

    await manager.admit(result.entry, { skipChainCheck: true })

    const entries = await store.findByTopic('oracle:rates:bsv')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].topic, 'oracle:rates:bsv')
  })

  it('stores outputScript and rawTx in admitted entry', async () => {
    const shipTx = await buildTestShipToken('oracle:rates:eth')
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    assert.ok(result.entry.outputScript)
    assert.ok(result.entry.rawTx)
    await manager.admit(result.entry, { skipChainCheck: true })

    const entries = await store.findByTopic('oracle:rates:eth')
    assert.equal(entries.length, 1)
    assert.ok(entries[0].outputScript.length > 0)
    assert.ok(entries[0].rawTx.length > 0)
  })

  it('revokes an admitted entry', async () => {
    const shipTx = await buildTestShipToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    await manager.admit(result.entry, { skipChainCheck: true })

    const revoked = await manager.revoke(result.entry.txid, result.entry.outputIndex)
    assert.equal(revoked, true)

    const entries = await store.findByTopic('oracle:rates:bsv')
    assert.equal(entries.length, 0)
  })

  it('rejects topic without colon namespace', async () => {
    const { Transaction } = await import('@bsv/sdk')
    const { buildShipScript } = await import('../lib/wallet.js')
    const { childPub } = deriveChild(identity.identityKey, '2-SHIP-1')

    const script = buildShipScript({
      identityPubHex: identity.identityPubHex,
      domain: 'test.example.com',
      topic: 'notopic', // no colon — should be rejected
      lockingPub: childPub
    })

    const tx = new Transaction()
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    const result = manager.evaluate({ txHex: tx.toHex(), outputIndex: 0 })
    assert.equal(result.admitted, false)
    assert.equal(result.reason, 'invalid_topic')
  })
})
