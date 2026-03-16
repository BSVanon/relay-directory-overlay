import { Transaction, PublicKey } from '@bsv/sdk'
import { deriveChildPub } from './wallet.js'
import { verifyTxBroadcast } from './chain.js'

/**
 * SHIP Topic Manager for relay mesh topics.
 *
 * Admission logic per BRC-22/88:
 * 1. Parse the output script as BRC-48 (push data fields + OP_DROP + OP_2DROP + pubkey + OP_CHECKSIG)
 * 2. Verify field 1 is "SHIP"
 * 3. Verify field 2 is a valid compressed pubkey hex (identity key)
 * 4. Verify field 3 is a non-empty domain string
 * 5. Verify field 4 is a valid relay mesh topic (colon-separated namespace)
 * 6. Verify the locking pubkey is correctly derived from the identity key via BRC-42 (invoice '2-SHIP-1')
 * 7. If valid, admit the output
 *
 * @param {object} store — the overlay data store
 */
export class ShipTopicManager {
  /**
   * @param {object} store
   * @param {object} [opts]
   * @param {boolean} [opts.skipChainCheck=false] — skip on-chain verification globally (for testing)
   */
  constructor (store, { skipChainCheck = false } = {}) {
    this._store = store
    this._skipChainCheck = skipChainCheck
  }

  /**
   * Evaluate whether a transaction output should be admitted to the SHIP overlay.
   *
   * @param {object} opts
   * @param {string} opts.txHex — full transaction hex
   * @param {number} opts.outputIndex — which output to evaluate
   * @returns {{ admitted: boolean, entry?: object, reason?: string }}
   */
  evaluate ({ txHex, outputIndex }) {
    let tx
    try {
      tx = Transaction.fromHex(txHex)
    } catch {
      return { admitted: false, reason: 'invalid_tx' }
    }

    const output = tx.outputs[outputIndex]
    if (!output) {
      return { admitted: false, reason: 'output_not_found' }
    }

    // Parse BRC-48 fields from the locking script
    const parsed = parseShipFields(output.lockingScript)
    if (!parsed) {
      return { admitted: false, reason: 'invalid_ship_format' }
    }

    const { protocol, identityPubHex, domain, topic, lockingPubHex } = parsed

    // Verify protocol identifier
    if (protocol !== 'SHIP') {
      return { admitted: false, reason: 'not_ship_token' }
    }

    // Verify identity key is a valid compressed pubkey
    let identityPub
    try {
      identityPub = PublicKey.fromString(identityPubHex)
    } catch {
      return { admitted: false, reason: 'invalid_identity_key' }
    }

    // Verify domain is non-empty
    if (!domain || domain.length === 0) {
      return { admitted: false, reason: 'empty_domain' }
    }

    // Verify topic follows colon-separated namespace convention
    if (!isValidTopic(topic)) {
      return { admitted: false, reason: 'invalid_topic' }
    }

    // Verify BRC-42 derivation: the locking pubkey must be derivable from identityPub + '2-SHIP-1'
    const expectedPub = deriveChildPub(identityPub, '2-SHIP-1')
    if (expectedPub.toString() !== lockingPubHex) {
      return { admitted: false, reason: 'derivation_mismatch' }
    }

    const txid = tx.id('hex')

    // Extract outputScript hex for BRC-36 compliance
    const outputScriptHex = output.lockingScript?.toHex?.() || ''

    return {
      admitted: true,
      entry: {
        txid,
        outputIndex,
        identityPubHex,
        domain,
        topic,
        lockingPubHex,
        satoshis: output.satoshis ?? 1,
        outputScript: outputScriptHex,
        rawTx: txHex
      }
    }
  }

  /**
   * Admit an output into the SHIP overlay store after verifying
   * the transaction exists on-chain (broadcast or confirmed).
   *
   * @param {object} entry — from evaluate().entry
   * @param {object} [opts]
   * @param {boolean} [opts.skipChainCheck=false] — skip on-chain verification (for testing or sync)
   * @returns {Promise<{stored: boolean, reason?: string}>}
   */
  async admit (entry, { skipChainCheck = false } = {}) {
    if (!skipChainCheck && !this._skipChainCheck) {
      const chainStatus = await verifyTxBroadcast(entry.txid)
      if (!chainStatus.valid) {
        return { stored: false, reason: chainStatus.reason }
      }
    }
    await this._store.putShipEntry(entry)
    return { stored: true }
  }

  /**
   * Handle a spent output — revoke the advertisement.
   *
   * @param {string} txid
   * @param {number} outputIndex
   * @returns {Promise<boolean>} — true if an entry was revoked
   */
  async revoke (txid, outputIndex) {
    return this._store.deleteShipEntry(txid, outputIndex)
  }
}

/**
 * Parse BRC-48 SHIP fields from a locking script.
 *
 * Expected pattern:
 *   <"SHIP"> <identityPubHex> <domain> <topic> OP_DROP OP_2DROP OP_DROP <pubkey> OP_CHECKSIG
 *
 * @param {LockingScript} script
 * @returns {object|null}
 */
function parseShipFields (script) {
  try {
    const chunks = script.chunks
    // Minimum: 4 push data + OP_DROP + OP_2DROP + OP_DROP + push(pubkey) + OP_CHECKSIG = 9 chunks
    if (chunks.length < 9) return null

    // Extract 4 push data fields
    const fields = []
    for (let i = 0; i < 4; i++) {
      const chunk = chunks[i]
      if (!chunk.data) return null
      fields.push(Buffer.from(chunk.data).toString('utf8'))
    }

    // Verify OP_DROP OP_2DROP OP_DROP sequence
    if (chunks[4].op !== OP_DROP) return null
    if (chunks[5].op !== OP_2DROP) return null
    if (chunks[6].op !== OP_DROP) return null

    // Extract locking pubkey
    const pubChunk = chunks[7]
    if (!pubChunk.data || pubChunk.data.length !== 33) return null
    const lockingPubHex = Buffer.from(pubChunk.data).toString('hex')

    // Verify OP_CHECKSIG
    if (chunks[8].op !== OP_CHECKSIG) return null

    return {
      protocol: fields[0],
      identityPubHex: fields[1],
      domain: fields[2],
      topic: fields[3],
      lockingPubHex
    }
  } catch {
    return null
  }
}

// Opcode constants
const OP_DROP = 0x75
const OP_2DROP = 0x6d
const OP_CHECKSIG = 0xac

/**
 * Validate a relay mesh topic string.
 * Must be non-empty and follow colon-separated namespace (at least one colon).
 */
function isValidTopic (topic) {
  if (!topic || topic.length === 0 || topic.length > 256) return false
  return topic.includes(':')
}
