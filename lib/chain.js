/**
 * On-chain verification via WhatsOnChain API.
 *
 * Provides tx existence checks, confirmation status, and raw tx fetching.
 * Used by /submit (verify SHIP tx is on-chain), /revoke (verify spend tx),
 * and payment verification (verify payment tx is broadcast).
 *
 * WoC is the default provider. The module is designed to swap providers
 * (e.g. ARC, direct node RPC) by changing the fetch functions.
 */

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const DEFAULT_TIMEOUT = 15000

/**
 * Fetch transaction details from WoC.
 * @param {string} txid
 * @returns {Promise<{exists: boolean, confirmed: boolean, confirmations: number, blockHash?: string, hex?: string}>}
 */
export async function getTxStatus (txid) {
  try {
    const res = await fetch(`${WOC_BASE}/tx/${txid}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (!res.ok) {
      return { exists: false, confirmed: false, confirmations: 0 }
    }
    const data = await res.json()
    const confirmations = data.confirmations || 0
    return {
      exists: true,
      confirmed: confirmations > 0,
      confirmations,
      blockHash: data.blockhash || null
    }
  } catch {
    // Network error — can't verify, treat as not found
    return { exists: false, confirmed: false, confirmations: 0, error: 'network_error' }
  }
}

/**
 * Fetch raw transaction hex from WoC.
 * @param {string} txid
 * @returns {Promise<string|null>}
 */
export async function getTxHex (txid) {
  try {
    const res = await fetch(`${WOC_BASE}/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * Verify a transaction is at least broadcast (exists in mempool or confirmed).
 * @param {string} txid
 * @returns {Promise<{valid: boolean, confirmed: boolean, reason?: string}>}
 */
export async function verifyTxBroadcast (txid) {
  const status = await getTxStatus(txid)
  if (status.error) {
    return { valid: false, confirmed: false, reason: 'chain_verification_unavailable' }
  }
  if (!status.exists) {
    return { valid: false, confirmed: false, reason: 'transaction_not_found_on_chain' }
  }
  return { valid: true, confirmed: status.confirmed }
}

/**
 * Verify a transaction is confirmed (at least 1 block).
 * @param {string} txid
 * @returns {Promise<{valid: boolean, confirmations: number, reason?: string}>}
 */
export async function verifyTxConfirmed (txid) {
  const status = await getTxStatus(txid)
  if (status.error) {
    return { valid: false, confirmations: 0, reason: 'chain_verification_unavailable' }
  }
  if (!status.exists) {
    return { valid: false, confirmations: 0, reason: 'transaction_not_found_on_chain' }
  }
  if (!status.confirmed) {
    return { valid: false, confirmations: 0, reason: 'transaction_unconfirmed' }
  }
  return { valid: true, confirmations: status.confirmations }
}
