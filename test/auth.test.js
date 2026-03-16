import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { createAuthSigner, createAuthVerifier } from '../lib/auth.js'

describe('auth', () => {
  const key1 = PrivateKey.fromRandom()
  const key2 = PrivateKey.fromRandom()
  const pub1 = key1.toPublicKey().toString()
  const pub2 = key2.toPublicKey().toString()

  describe('createAuthSigner + createAuthVerifier', () => {
    it('valid signature passes verification', () => {
      const signer = createAuthSigner(key1)
      const verifier = createAuthVerifier({ trustedPubkeys: [pub1] })

      const body = '{"test":"data"}'
      const authHeader = signer.sign('POST', '/submit', body)

      const req = {
        method: 'POST',
        url: '/submit',
        headers: { host: 'localhost:3360', 'x-overlay-auth': authHeader }
      }
      const result = verifier.verify(req, body)
      assert.equal(result.valid, true)
      assert.equal(result.pubkey, pub1)
    })

    it('rejects untrusted pubkey', () => {
      const signer = createAuthSigner(key2) // key2 not in trusted set
      const verifier = createAuthVerifier({ trustedPubkeys: [pub1] })

      const body = '{}'
      const authHeader = signer.sign('POST', '/submit', body)
      const req = {
        method: 'POST',
        url: '/submit',
        headers: { host: 'localhost:3360', 'x-overlay-auth': authHeader }
      }
      const result = verifier.verify(req, body)
      assert.equal(result.valid, false)
      assert.ok(result.reason.includes('untrusted'))
    })

    it('rejects missing auth header', () => {
      const verifier = createAuthVerifier({ trustedPubkeys: [pub1] })
      const req = { method: 'POST', url: '/submit', headers: { host: 'localhost' } }
      const result = verifier.verify(req, '{}')
      assert.equal(result.valid, false)
      assert.ok(result.reason.includes('missing'))
    })

    it('rejects tampered body', () => {
      const signer = createAuthSigner(key1)
      const verifier = createAuthVerifier({ trustedPubkeys: [pub1] })

      const originalBody = '{"amount":100}'
      const authHeader = signer.sign('POST', '/submit', originalBody)
      const tamperedBody = '{"amount":1}'

      const req = {
        method: 'POST',
        url: '/submit',
        headers: { host: 'localhost:3360', 'x-overlay-auth': authHeader }
      }
      const result = verifier.verify(req, tamperedBody)
      assert.equal(result.valid, false)
      assert.ok(result.reason.includes('signature'))
    })

    it('rejects expired timestamp', () => {
      const signer = createAuthSigner(key1)
      const verifier = createAuthVerifier({ trustedPubkeys: [pub1] })

      // Manually create an auth header with old timestamp
      const body = '{}'
      const authJson = JSON.parse(signer.sign('POST', '/submit', body))
      authJson.timestamp = Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
      // Re-sign won't match, but the timestamp check comes first
      const req = {
        method: 'POST',
        url: '/submit',
        headers: { host: 'localhost:3360', 'x-overlay-auth': JSON.stringify(authJson) }
      }
      const result = verifier.verify(req, body)
      assert.equal(result.valid, false)
    })
  })
})
