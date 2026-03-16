import { PrivateKey, PublicKey, Transaction, P2PKH, Hash, Signature, LockingScript, OP, SatoshisPerKilobyte } from '@bsv/sdk'

// BRC-42: "anyone" counterparty — public key for scalar 1 (generator point G)
const ANYONE_PUBKEY = PublicKey.fromString('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
// BRC-42: "anyone" private key — scalar 1
const ANYONE_PRIVKEY = new PrivateKey(1)

/**
 * Load identity key from WIF.
 * @param {string} wif
 * @returns {{ identityKey: PrivateKey, identityPub: PublicKey, identityPubHex: string }}
 */
export function loadIdentity (wif) {
  const identityKey = PrivateKey.fromWif(wif)
  const identityPub = identityKey.toPublicKey()
  return {
    identityKey,
    identityPub,
    identityPubHex: identityPub.toString()
  }
}

/**
 * BRC-42 key derivation. Derives a child private key from the identity key
 * using the "anyone" counterparty and a BRC-43 invoice number.
 *
 * @param {PrivateKey} identityKey
 * @param {string} invoice — e.g. '2-SHIP-1' or '2-SLAP-1'
 * @returns {{ childKey: PrivateKey, childPub: PublicKey, childPubHex: string }}
 */
export function deriveChild (identityKey, invoice) {
  const childKey = identityKey.deriveChild(ANYONE_PUBKEY, invoice)
  const childPub = childKey.toPublicKey()
  return {
    childKey,
    childPub,
    childPubHex: childPub.toString()
  }
}

/**
 * Derive the public child key given the identity public key (for verification).
 * Anyone can compute this — no private key needed.
 *
 * @param {PublicKey} identityPub
 * @param {string} invoice
 * @returns {PublicKey}
 */
export function deriveChildPub (identityPub, invoice) {
  return identityPub.deriveChild(ANYONE_PRIVKEY, invoice)
}

/**
 * Build a BRC-48 SHIP token output script.
 *
 * Format: <"SHIP"> <identityPubHex> <domain> <topic> OP_DROP OP_2DROP <childPubkey> OP_CHECKSIG
 *
 * @param {object} opts
 * @param {string} opts.identityPubHex — compressed identity public key hex
 * @param {string} opts.domain — HTTPS domain hosting the overlay/bridge
 * @param {string} opts.topic — relay mesh topic (e.g. 'oracle:rates:bsv')
 * @param {PublicKey} opts.lockingPub — BRC-42 derived public key for locking
 * @returns {LockingScript}
 */
export function buildShipScript ({ identityPubHex, domain, topic, lockingPub }) {
  const fields = [
    Array.from(Buffer.from('SHIP', 'utf8')),
    Array.from(Buffer.from(identityPubHex, 'utf8')),
    Array.from(Buffer.from(domain, 'utf8')),
    Array.from(Buffer.from(topic, 'utf8'))
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
 * Build a complete SHIP token transaction.
 *
 * @param {object} opts
 * @param {PrivateKey} opts.identityKey — identity private key (for funding inputs)
 * @param {string} opts.domain
 * @param {string} opts.topic
 * @param {Array<{txHex: string, outputIndex: number, satoshis: number}>} opts.utxos — funding UTXOs
 * @returns {Promise<{txHex: string, txid: string, shipOutputIndex: number}>}
 */
export async function buildShipTx ({ identityKey, domain, topic, utxos }) {
  const identityPub = identityKey.toPublicKey()
  const identityPubHex = identityPub.toString()

  // BRC-42 derive the SHIP locking key
  const { childKey, childPub } = deriveChild(identityKey, '2-SHIP-1')

  // Build the BRC-48 locking script
  const shipScript = buildShipScript({ identityPubHex, domain, topic, lockingPub: childPub })

  // Build transaction
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

  // SHIP token output — 1 satoshi
  tx.addOutput({ lockingScript: shipScript, satoshis: 1 })

  // Change output
  tx.addOutput({ lockingScript: changeLock, change: true })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  return {
    txHex: tx.toHex(),
    txid: tx.id('hex'),
    shipOutputIndex: 0
  }
}

/**
 * Build a transaction that spends (revokes) a SHIP token.
 *
 * @param {object} opts
 * @param {PrivateKey} opts.identityKey
 * @param {string} opts.shipTxHex — the transaction containing the SHIP token
 * @param {number} opts.shipOutputIndex — which output is the SHIP token
 * @returns {Promise<{txHex: string, txid: string}>}
 */
export async function buildRevokeTx ({ identityKey, shipTxHex, shipOutputIndex }) {
  const identityPub = identityKey.toPublicKey()
  const { childKey } = deriveChild(identityKey, '2-SHIP-1')

  const tx = new Transaction()
  const sourceTransaction = Transaction.fromHex(shipTxHex)
  const p2pkh = new P2PKH()
  const changeAddress = identityPub.toAddress()
  const changeLock = p2pkh.lock(changeAddress)

  // The SHIP output is locked with <childPub> OP_CHECKSIG (simple P2PK)
  // Unlocking script is just the signature from childKey
  tx.addInput({
    sourceTransaction,
    sourceOutputIndex: shipOutputIndex,
    unlockingScriptTemplate: {
      sign: async (tx, inputIndex) => {
        const preimage = tx.inputs[inputIndex].sourceSatoshis
        const sig = tx.sign(childKey, 'all', inputIndex, sourceTransaction.outputs[shipOutputIndex].lockingScript, preimage)
        return sig
      },
      estimateLength: () => 73
    }
  })

  // Send the 1 sat to change (minus fee it will be dust, but we try)
  tx.addOutput({ lockingScript: changeLock, change: true })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  return {
    txHex: tx.toHex(),
    txid: tx.id('hex')
  }
}

// Helper: create a push data chunk for LockingScript
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
