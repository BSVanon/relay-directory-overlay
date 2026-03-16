import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, PublicKey } from '@bsv/sdk'
import { loadIdentity, deriveChild, deriveChildPub, buildShipScript } from '../lib/wallet.js'

describe('wallet', () => {
  const testKey = PrivateKey.fromRandom()
  const testWif = testKey.toWif()

  describe('loadIdentity', () => {
    it('loads identity from WIF', () => {
      const identity = loadIdentity(testWif)
      assert.equal(identity.identityPubHex, testKey.toPublicKey().toString())
      assert.ok(identity.identityKey)
      assert.ok(identity.identityPub)
    })

    it('throws on invalid WIF', () => {
      assert.throws(() => loadIdentity('notawif'))
    })
  })

  describe('BRC-42 derivation', () => {
    it('derives a child key different from identity', () => {
      const child = deriveChild(testKey, '2-SHIP-1')
      assert.notEqual(child.childPubHex, testKey.toPublicKey().toString())
      assert.ok(child.childKey)
      assert.ok(child.childPub)
    })

    it('derivation is deterministic', () => {
      const child1 = deriveChild(testKey, '2-SHIP-1')
      const child2 = deriveChild(testKey, '2-SHIP-1')
      assert.equal(child1.childPubHex, child2.childPubHex)
    })

    it('different invoices produce different keys', () => {
      const ship = deriveChild(testKey, '2-SHIP-1')
      const slap = deriveChild(testKey, '2-SLAP-1')
      assert.notEqual(ship.childPubHex, slap.childPubHex)
    })

    it('public derivation matches private derivation', () => {
      const fromPriv = deriveChild(testKey, '2-SHIP-1')
      const fromPub = deriveChildPub(testKey.toPublicKey(), '2-SHIP-1')
      assert.equal(fromPriv.childPubHex, fromPub.toString())
    })
  })

  describe('buildShipScript', () => {
    it('builds a valid BRC-48 script', () => {
      const child = deriveChild(testKey, '2-SHIP-1')
      const script = buildShipScript({
        identityPubHex: testKey.toPublicKey().toString(),
        domain: 'example.com',
        topic: 'oracle:rates:bsv',
        lockingPub: child.childPub
      })

      const chunks = script.chunks
      // 4 push data + OP_DROP + OP_2DROP + OP_DROP + push(pubkey) + OP_CHECKSIG
      assert.ok(chunks.length >= 9, `expected >= 9 chunks, got ${chunks.length}`)

      // Verify field content
      assert.equal(Buffer.from(chunks[0].data).toString('utf8'), 'SHIP')
      assert.equal(Buffer.from(chunks[1].data).toString('utf8'), testKey.toPublicKey().toString())
      assert.equal(Buffer.from(chunks[2].data).toString('utf8'), 'example.com')
      assert.equal(Buffer.from(chunks[3].data).toString('utf8'), 'oracle:rates:bsv')

      // Verify opcodes
      assert.equal(chunks[4].op, 0x75) // OP_DROP
      assert.equal(chunks[5].op, 0x6d) // OP_2DROP
      assert.equal(chunks[6].op, 0x75) // OP_DROP
      assert.equal(chunks[8].op, 0xac) // OP_CHECKSIG

      // Verify locking pubkey
      const lockingPubHex = Buffer.from(chunks[7].data).toString('hex')
      assert.equal(lockingPubHex, child.childPubHex)
    })
  })
})
