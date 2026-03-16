import crypto from 'node:crypto'

/**
 * BRC-105 payment middleware for the overlay.
 *
 * Configurable per-endpoint pricing with HTTP 402 flow:
 *   1. Request arrives without payment → 402 with price + derivation prefix
 *   2. Client retries with x-bsv-payment header → verify + proceed
 *
 * PHASE 3 LIMITATION: Payment verification is stubbed. The middleware
 * generates correct 402 responses and parses payment headers, but does
 * not yet verify the transaction against a real wallet (requires
 * wallet-toolbox internalizeAction or SPV Gateway integration).
 * The verification hook is clearly marked for future wiring.
 */

/**
 * Create payment middleware for a specific endpoint.
 *
 * @param {object} opts
 * @param {number} opts.satoshis — price in satoshis (0 = free)
 * @param {string} [opts.description] — human-readable description of what's being paid for
 * @param {function} [opts.verifyPayment] — async (paymentData, satoshisRequired) => { valid, txid? }
 * @returns {function} middleware — async (req, res) => boolean (true = paid or free, false = 402 sent)
 */
export function createPaymentGate ({ satoshis, description = '', verifyPayment = null }) {
  return async function paymentGate (req, res) {
    // Free endpoint — always pass
    if (satoshis <= 0) return true

    // Check for existing payment header
    const paymentHeader = req.headers['x-bsv-payment']
    if (paymentHeader) {
      let paymentData
      try {
        paymentData = JSON.parse(paymentHeader)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({
          status: 'error',
          code: 'ERR_INVALID_PAYMENT',
          description: 'x-bsv-payment header contains invalid JSON'
        }))
        return false
      }

      // Verify the payment
      if (verifyPayment) {
        const result = await verifyPayment(paymentData, satoshis)
        if (result.valid) return true

        res.writeHead(402)
        res.end(JSON.stringify({
          status: 'error',
          code: 'ERR_PAYMENT_INVALID',
          description: result.reason || 'Payment verification failed'
        }))
        return false
      }

      // STUB: No verifier configured — accept any payment header for now
      // TODO: Wire to wallet-toolbox internalizeAction or SPV Gateway
      console.warn('[Payment] No verifyPayment function configured — accepting payment on trust')
      return true
    }

    // No payment provided — return 402
    const derivationPrefix = crypto.randomBytes(16).toString('base64')

    res.writeHead(402, {
      'x-bsv-payment-version': '1.0',
      'x-bsv-payment-satoshis-required': String(satoshis),
      'x-bsv-payment-derivation-prefix': derivationPrefix
    })
    res.end(JSON.stringify({
      status: 'payment_required',
      satoshisRequired: satoshis,
      derivationPrefix,
      description: description || `Payment of ${satoshis} satoshis required`
    }))
    return false
  }
}

/**
 * Load pricing configuration from environment or defaults.
 *
 * Env vars:
 *   OVERLAY_PRICE_SUBMIT  — sats to charge for /submit (default: 0 = free)
 *   OVERLAY_PRICE_LOOKUP  — sats to charge for /lookup (default: 0 = free)
 *   OVERLAY_PRICE_REVOKE  — sats to charge for /revoke (default: 0 = free)
 *
 * @returns {{ submit: number, lookup: number, revoke: number }}
 */
export function loadPricing () {
  return {
    submit: parseInt(process.env.OVERLAY_PRICE_SUBMIT || '0', 10),
    lookup: parseInt(process.env.OVERLAY_PRICE_LOOKUP || '0', 10),
    revoke: parseInt(process.env.OVERLAY_PRICE_REVOKE || '0', 10)
  }
}
