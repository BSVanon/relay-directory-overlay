#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadIdentity, deriveChild, buildShipTx } from './lib/wallet.js'

const CONFIG_DIR = process.env.OVERLAY_CONFIG_DIR || './config'
const CONFIG_PATH = join(CONFIG_DIR, 'overlay.json')

const command = process.argv[2]

const commands = {
  init: cmdInit,
  status: cmdStatus,
  'publish-ship': cmdPublishShip,
  'publish-slap': cmdPublishSlap,
  help: cmdHelp
}

const handler = commands[command]
if (!handler) {
  cmdHelp()
  process.exit(command ? 1 : 0)
}

await handler()

// ─── Commands ──────────────────────────────────────────────

async function cmdInit () {
  if (existsSync(CONFIG_PATH)) {
    console.log('Config already exists at', CONFIG_PATH)
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    console.log(`  Identity: ${config.identityPubHex}`)
    console.log(`  Address:  ${config.address}`)
    return
  }

  await mkdir(CONFIG_DIR, { recursive: true })

  const key = PrivateKey.fromRandom()
  const pub = key.toPublicKey()
  const address = pub.toAddress()

  const wif = key.toWif()

  const config = {
    identityPubHex: pub.toString(),
    address,
    domain: process.env.OVERLAY_DOMAIN || 'localhost',
    overlayPort: parseInt(process.env.OVERLAY_PORT || '3360', 10),
    dbPath: process.env.OVERLAY_DB_PATH || './data/directory.db'
  }

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')

  console.log('Overlay identity created:')
  console.log(`  Pubkey:  ${config.identityPubHex}`)
  console.log(`  Address: ${config.address}`)
  console.log(`  Config:  ${CONFIG_PATH}`)
  console.log()
  console.log(`  WIF: ${wif}`)
  console.log()
  console.log('IMPORTANT: Save this WIF securely. It is NOT stored in config.')
  console.log('Set it as an environment variable before running commands:')
  console.log(`  export OVERLAY_WIF="${wif}"`)
  console.log()
  console.log('Or in the systemd unit: Environment=OVERLAY_WIF=<wif>')
  console.log()
  console.log(`Fund ${config.address} with ~50,000 sats before publishing SHIP tokens.`)
}

async function cmdStatus () {
  const config = await loadConfig()
  const { identityPubHex, address, domain } = config

  console.log('Relay Directory Overlay')
  console.log(`  Identity: ${identityPubHex}`)
  console.log(`  Address:  ${address}`)
  console.log(`  Domain:   ${domain}`)

  // Derive SHIP key info (only if WIF available)
  if (config.wif) {
    const identity = loadIdentity(config.wif)
    const shipChild = deriveChild(identity.identityKey, '2-SHIP-1')
    console.log(`  SHIP key: ${shipChild.childPubHex}`)
  } else {
    console.log('  SHIP key: (set OVERLAY_WIF to display)')
  }

  // Check if overlay server is running
  const port = config.overlayPort || 3360
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    const data = await res.json()
    console.log(`  Server:   running (${data.topics} topics, ${data.entries} entries)`)
  } catch {
    console.log('  Server:   not running')
  }
}

async function cmdPublishShip () {
  const topic = process.argv[3]
  if (!topic) {
    console.log('Usage: node cli.js publish-ship <topic>')
    console.log('Example: node cli.js publish-ship oracle:rates:bsv')
    process.exit(1)
  }

  if (!topic.includes(':')) {
    console.log('Error: topic must use colon-separated namespace (e.g. oracle:rates:bsv)')
    process.exit(1)
  }

  const config = await loadConfig()
  if (!config.wif) {
    console.log('Error: OVERLAY_WIF environment variable is required for publishing.')
    console.log('  export OVERLAY_WIF="<your-wif>"')
    process.exit(1)
  }
  const identity = loadIdentity(config.wif)

  console.log(`Publishing SHIP token for topic: ${topic}`)
  console.log(`  Identity: ${identity.identityPubHex}`)
  console.log(`  Domain:   ${config.domain}`)

  // Fetch UTXOs for funding
  const utxos = await fetchUtxos(config.address)
  if (utxos.length === 0) {
    console.log('Error: no UTXOs available. Fund the overlay address first.')
    console.log(`  Address: ${config.address}`)
    process.exit(1)
  }

  console.log(`  UTXOs:    ${utxos.length} (${utxos.reduce((s, u) => s + u.satoshis, 0)} sats)`)

  // Fetch raw tx hex for each UTXO
  const fundingUtxos = []
  for (const utxo of utxos) {
    const txHex = await fetchTxHex(utxo.tx_hash)
    if (!txHex) {
      console.log(`  Warning: could not fetch tx ${utxo.tx_hash}, skipping`)
      continue
    }
    fundingUtxos.push({
      txHex,
      outputIndex: utxo.tx_pos,
      satoshis: utxo.value
    })
  }

  if (fundingUtxos.length === 0) {
    console.log('Error: could not fetch any UTXO raw transactions')
    process.exit(1)
  }

  // Build SHIP token transaction
  const result = await buildShipTx({
    identityKey: identity.identityKey,
    domain: config.domain,
    topic,
    utxos: fundingUtxos
  })

  console.log(`  SHIP tx:  ${result.txid}`)

  // Broadcast
  const broadcast = await broadcastTx(result.txHex)
  if (!broadcast.success) {
    console.log(`  Broadcast failed: ${broadcast.error}`)
    process.exit(1)
  }

  console.log('  Broadcast: success')

  // Submit to local overlay
  const port = config.overlayPort || 3360
  try {
    const submitRes = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex: result.txHex, outputIndex: result.shipOutputIndex })
    })
    const submitData = await submitRes.json()
    if (submitData.status === 'success' && Object.keys(submitData.topics || {}).length > 0) {
      const admittedTopics = Object.keys(submitData.topics).join(', ')
      console.log(`  Overlay:   admitted (${admittedTopics})`)
    } else if (submitData.status === 'error') {
      console.log(`  Overlay:   rejected (${submitData.code}: ${submitData.description})`)
    } else {
      console.log('  Overlay:   no outputs admitted')
    }
  } catch {
    console.log('  Overlay:   server not running — submit manually later')
  }

  console.log()
  console.log('SHIP token published. The overlay directory now advertises:')
  console.log(`  Bridge ${identity.identityPubHex.slice(0, 16)}... hosts "${topic}" at ${config.domain}`)
}

async function cmdPublishSlap () {
  const provider = process.argv[3] || 'relay-topic-lookup'

  const config = await loadConfig()
  if (!config.wif) {
    console.log('Error: OVERLAY_WIF environment variable is required for publishing.')
    console.log('  export OVERLAY_WIF="<your-wif>"')
    process.exit(1)
  }

  const { buildSlapTx } = await import('./lib/slap.js')
  const identity = loadIdentity(config.wif)

  console.log(`Publishing SLAP token for provider: ${provider}`)
  console.log(`  Identity: ${identity.identityPubHex}`)
  console.log(`  Domain:   ${config.domain}`)

  const utxos = await fetchUtxos(config.address)
  if (utxos.length === 0) {
    console.log('Error: no UTXOs available. Fund the overlay address first.')
    console.log(`  Address: ${config.address}`)
    process.exit(1)
  }

  const fundingUtxos = []
  for (const utxo of utxos) {
    const txHex = await fetchTxHex(utxo.tx_hash)
    if (!txHex) continue
    fundingUtxos.push({ txHex, outputIndex: utxo.tx_pos, satoshis: utxo.value })
  }

  if (fundingUtxos.length === 0) {
    console.log('Error: could not fetch any UTXO raw transactions')
    process.exit(1)
  }

  const result = await buildSlapTx({
    identityKey: identity.identityKey,
    domain: config.domain,
    provider,
    utxos: fundingUtxos
  })

  console.log(`  SLAP tx:  ${result.txid}`)

  const broadcast = await broadcastTx(result.txHex)
  if (!broadcast.success) {
    console.log(`  Broadcast failed: ${broadcast.error}`)
    process.exit(1)
  }

  console.log('  Broadcast: success')
  console.log()
  console.log(`SLAP token published. This overlay advertises lookup service "${provider}" at ${config.domain}`)
}

function cmdHelp () {
  console.log('Relay Directory Overlay CLI')
  console.log()
  console.log('Commands:')
  console.log('  init            Generate overlay identity and config')
  console.log('  status          Show overlay identity and server status')
  console.log('  publish-ship    Publish a SHIP token for a relay mesh topic')
  console.log('  publish-slap    Publish a SLAP token to advertise this overlay')
  console.log('  help            Show this help')
  console.log()
  console.log('Examples:')
  console.log('  node cli.js init')
  console.log('  node cli.js publish-ship oracle:rates:bsv')
  console.log('  node cli.js publish-slap relay-topic-lookup')
}

// ─── Helpers ──────────────────────────────────────────────

async function loadConfig () {
  if (!existsSync(CONFIG_PATH)) {
    console.log('No config found. Run: node cli.js init')
    process.exit(1)
  }
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  // Allow env var override for WIF (preferred over plaintext config)
  if (process.env.OVERLAY_WIF) {
    config.wif = process.env.OVERLAY_WIF
    const identity = loadIdentity(config.wif)
    config.identityPubHex = identity.identityPubHex
    config.address = identity.identityPub.toAddress()
  }
  return config
}

async function fetchUtxos (address) {
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

async function fetchTxHex (txid) {
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function broadcastTx (txHex) {
  try {
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: txHex }),
      signal: AbortSignal.timeout(15000)
    })
    if (res.ok) {
      const txid = await res.text()
      return { success: true, txid: txid.replace(/"/g, '') }
    }
    const err = await res.text()
    return { success: false, error: err }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
