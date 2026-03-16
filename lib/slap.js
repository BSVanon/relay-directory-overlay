import { Transaction, PublicKey, LockingScript, OP, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk'
import { deriveChild, deriveChildPub } from './wallet.js'

/**
 * SLAP (Services Lookup Availability Protocol) support.
 *
 * SLAP tokens advertise that this overlay node offers a specific lookup service.
 * Format follows BRC-88:
 *   Field 1: "SLAP"
 *   Field 2: Identity key hex of the overlay operator
 *   Field 3: Domain name of the overlay node
 *   Field 4: Provider name (e.g. "relay-topic-lookup")
 *   Locking: BRC-42 derived key (invoice '2-SLAP-1') + OP_CHECKSIG
 */

const SLAP_INVOICE = '2-SLAP-1'

/**
 * Build a BRC-48 SLAP token output script.
 */
export function buildSlapScript ({ identityPubHex, domain, provider, lockingPub }) {
  const fields = [
    Array.from(Buffer.from('SLAP', 'utf8')),
    Array.from(Buffer.from(identityPubHex, 'utf8')),
    Array.from(Buffer.from(domain, 'utf8')),
    Array.from(Buffer.from(provider, 'utf8'))
  ]

  const lockingPubBytes = Array.from(lockingPub.encode(true))

  return new LockingScript([
    pushData(fields[0]),
    pushData(fields[1]),
    pushData(fields[2]),
    pushData(fields[3]),
    { op: OP.OP_DROP },
    { op: OP.OP_2DROP },
    { op: OP.OP_DROP },
    pushData(lockingPubBytes),
    { op: OP.OP_CHECKSIG }
  ])
}

/**
 * Build a complete SLAP token transaction.
 *
 * @param {object} opts
 * @param {PrivateKey} opts.identityKey
 * @param {string} opts.domain
 * @param {string} opts.provider — e.g. 'relay-topic-lookup'
 * @param {Array<{txHex, outputIndex, satoshis}>} opts.utxos
 * @returns {Promise<{txHex, txid, slapOutputIndex}>}
 */
export async function buildSlapTx ({ identityKey, domain, provider, utxos }) {
  const identityPub = identityKey.toPublicKey()
  const identityPubHex = identityPub.toString()

  const { childPub } = deriveChild(identityKey, SLAP_INVOICE)

  const slapScript = buildSlapScript({ identityPubHex, domain, provider, lockingPub: childPub })

  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const changeAddress = identityPub.toAddress()
  const changeLock = p2pkh.lock(changeAddress)

  for (const utxo of utxos) {
    const sourceTransaction = Transaction.fromHex(utxo.txHex)
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: utxo.outputIndex,
      unlockingScriptTemplate: p2pkh.unlock(identityKey, 'all', false, utxo.satoshis, changeLock)
    })
  }

  tx.addOutput({ lockingScript: slapScript, satoshis: 1 })
  tx.addOutput({ lockingScript: changeLock, change: true })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  return {
    txHex: tx.toHex(),
    txid: tx.id('hex'),
    slapOutputIndex: 0
  }
}

/**
 * Parse SLAP token fields from a locking script.
 * @returns {object|null} — { protocol, identityPubHex, domain, provider, lockingPubHex }
 */
export function parseSlapFields (script) {
  try {
    const chunks = script.chunks
    if (chunks.length < 9) return null

    const fields = []
    for (let i = 0; i < 4; i++) {
      const chunk = chunks[i]
      if (!chunk.data) return null
      fields.push(Buffer.from(chunk.data).toString('utf8'))
    }

    if (chunks[4].op !== 0x75) return null  // OP_DROP
    if (chunks[5].op !== 0x6d) return null  // OP_2DROP
    if (chunks[6].op !== 0x75) return null  // OP_DROP

    const pubChunk = chunks[7]
    if (!pubChunk.data || pubChunk.data.length !== 33) return null
    const lockingPubHex = Buffer.from(pubChunk.data).toString('hex')

    if (chunks[8].op !== 0xac) return null  // OP_CHECKSIG

    return {
      protocol: fields[0],
      identityPubHex: fields[1],
      domain: fields[2],
      provider: fields[3],
      lockingPubHex
    }
  } catch {
    return null
  }
}

/**
 * Validate a SLAP token: correct format and BRC-42 derivation.
 */
export function validateSlapToken (txHex, outputIndex) {
  let tx
  try {
    tx = Transaction.fromHex(txHex)
  } catch {
    return { valid: false, reason: 'invalid_tx' }
  }

  const output = tx.outputs[outputIndex]
  if (!output) return { valid: false, reason: 'output_not_found' }

  const parsed = parseSlapFields(output.lockingScript)
  if (!parsed) return { valid: false, reason: 'invalid_slap_format' }
  if (parsed.protocol !== 'SLAP') return { valid: false, reason: 'not_slap_token' }

  let identityPub
  try {
    identityPub = PublicKey.fromString(parsed.identityPubHex)
  } catch {
    return { valid: false, reason: 'invalid_identity_key' }
  }

  if (!parsed.domain) return { valid: false, reason: 'empty_domain' }
  if (!parsed.provider) return { valid: false, reason: 'empty_provider' }

  const expectedPub = deriveChildPub(identityPub, SLAP_INVOICE)
  if (expectedPub.toString() !== parsed.lockingPubHex) {
    return { valid: false, reason: 'derivation_mismatch' }
  }

  return {
    valid: true,
    entry: {
      txid: tx.id('hex'),
      outputIndex,
      identityPubHex: parsed.identityPubHex,
      domain: parsed.domain,
      provider: parsed.provider,
      lockingPubHex: parsed.lockingPubHex
    }
  }
}

function pushData (data) {
  const len = data.length
  let op
  if (len < OP.OP_PUSHDATA1) {
    op = len
  } else if (len <= 0xff) {
    op = OP.OP_PUSHDATA1
  } else if (len <= 0xffff) {
    op = OP.OP_PUSHDATA2
  } else {
    op = OP.OP_PUSHDATA4
  }
  return { op, data }
}
