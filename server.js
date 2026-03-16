import { createServer } from 'node:http'
import { OverlayStore } from './lib/store.js'
import { ShipTopicManager } from './lib/ship-topic-manager.js'
import { TopicLookupService } from './lib/lookup.js'
import { OverlaySync } from './lib/sync.js'
import { createPaymentGate, createPaymentVerifier, loadPricing } from './lib/payment.js'
import { loadIdentity } from './lib/wallet.js'
import { applyCors, handleSubmit, handleRevoke, handleLookup, handleStatus } from './lib/handlers.js'

const DEFAULT_PORT = parseInt(process.env.OVERLAY_PORT || '3360', 10)
const DEFAULT_DB_PATH = process.env.OVERLAY_DB_PATH || './data/directory.db'

/**
 * Start the Relay Directory Overlay HTTP server.
 *
 * Endpoints:
 *   POST /submit   — BRC-22 transaction submission for SHIP token admission
 *   POST /revoke   — explicit spend notification (Phase 1 — no auto-detect)
 *   POST /lookup   — BRC-24 query resolution
 *   GET  /status   — overlay health check
 */
export async function startServer ({ port = DEFAULT_PORT, dbPath = DEFAULT_DB_PATH, peerUrls = null } = {}) {
  const peers = peerUrls || (process.env.OVERLAY_PEERS || '').split(',').filter(Boolean)
  const store = new OverlayStore(dbPath)
  await store.open()

  const topicManager = new ShipTopicManager(store)
  const lookupService = new TopicLookupService(store)
  const sync = new OverlaySync({ peerUrls: peers })
  const pricing = loadPricing()

  // Wire payment verifier if identity key is available and any endpoint is priced
  let verifyPayment = null
  const anyPriced = pricing.submit > 0 || pricing.lookup > 0 || pricing.revoke > 0
  if (anyPriced && process.env.OVERLAY_WIF) {
    const { identityKey } = loadIdentity(process.env.OVERLAY_WIF)
    verifyPayment = createPaymentVerifier(identityKey)
  } else if (anyPriced) {
    console.warn('[Overlay] Pricing is set but OVERLAY_WIF is missing — payment verification disabled')
  }

  const submitGate = createPaymentGate({ satoshis: pricing.submit, description: 'SHIP token listing fee', verifyPayment })
  const lookupGate = createPaymentGate({ satoshis: pricing.lookup, description: 'Directory lookup fee', verifyPayment })
  const revokeGate = createPaymentGate({ satoshis: pricing.revoke, description: 'Revocation fee', verifyPayment })

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname

    try {
      if (req.method === 'POST' && path === '/submit') {
        if (await submitGate(req, res)) await handleSubmit(req, res, topicManager, sync)
      } else if (req.method === 'POST' && path === '/revoke') {
        if (await revokeGate(req, res)) await handleRevoke(req, res, topicManager, sync)
      } else if (req.method === 'POST' && path === '/lookup') {
        if (await lookupGate(req, res)) await handleLookup(req, res, lookupService, store)
      } else if (req.method === 'GET' && path === '/status') {
        await handleStatus(res, store)
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not_found' }))
      }
    } catch (err) {
      console.error('[Overlay] Request error:', err.message)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'internal_error', message: err.message }))
    }
  })

  server.listen(port, () => {
    console.log(`[Overlay] Relay Directory Overlay running on port ${port}`)
    console.log(`[Overlay] DB: ${dbPath}`)
  })

  if (sync.peerCount > 0) {
    console.log(`[Overlay] Sync: ${sync.peerCount} peer(s) configured`)
  }
  if (pricing.submit > 0 || pricing.lookup > 0 || pricing.revoke > 0) {
    console.log(`[Overlay] Pricing: submit=${pricing.submit} lookup=${pricing.lookup} revoke=${pricing.revoke} sats`)
  }

  return { server, store, topicManager, lookupService, sync }
}

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
}
