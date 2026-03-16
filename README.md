# Relay Directory Overlay

A SHIP/SLAP overlay for the [Federated SPV Relay Mesh](https://github.com/zcoolz/relay-federation). Makes the mesh self-describing — any app can discover what data topics exist, who publishes them, and which bridges carry them.

## What It Does

The relay mesh carries ephemeral signed data envelopes between bridges. But there's no built-in way to discover what data is available. This overlay fills that gap using the BSV overlay services architecture (BRC-22/24/88):

- Bridge operators publish **SHIP tokens** on-chain to advertise the topics they carry
- Apps query the overlay to find bridges for a topic (e.g. "who carries `oracle:rates:bsv`?")
- The overlay answers with bridge endpoints, identity keys, and domains

No new protocol — standard BSV overlay patterns applied to relay mesh discovery.

## Prerequisites

- **Node.js** >= 20
- **npm** >= 9
- **BSV** — a small amount of satoshis for publishing SHIP/SLAP tokens (~500 sats per token)

## Quick Start

```bash
# Clone and install
git clone https://github.com/BSVanon/relay-directory-overlay.git
cd relay-directory-overlay
npm install

# Generate identity
node cli.js init
# Save the WIF it prints — it is NOT stored in config

# Set environment
cp .env.example .env
# Edit .env: set OVERLAY_WIF and OVERLAY_DOMAIN

# Run tests
npm test

# Start the server
node server.js
```

## CLI Commands

All commands that touch the wallet require `OVERLAY_WIF` set as an environment variable.

### `init`

Generate a new overlay identity (keypair + config).

```bash
node cli.js init
```

Creates `config/overlay.json` with public identity info. Prints the WIF once — save it securely.

### `status`

Show overlay identity and server status.

```bash
export OVERLAY_WIF="<your-wif>"
node cli.js status
```

Output:
```
Relay Directory Overlay
  Identity: 03cd06c1...
  Address:  1EbWuv...
  Domain:   vmi2946361.contaboserver.net
  SHIP key: 02b2af5f...
  Server:   running (1 topics, 1 entries)
```

### `publish-ship <topic>`

Publish a SHIP token advertising that your bridge carries a specific data topic.

```bash
export OVERLAY_WIF="<your-wif>"
node cli.js publish-ship oracle:rates:bsv
```

This:
1. Derives a BRC-42 signing key from your identity (invoice `2-SHIP-1`)
2. Builds a BRC-48 token output: `<SHIP> <identity> <domain> <topic> OP_DROP OP_2DROP OP_DROP <derivedKey> OP_CHECKSIG`
3. Funds from your overlay address UTXOs
4. Broadcasts to mainnet via WhatsOnChain
5. Submits to the local overlay server for indexing

Cost: ~250 sats per token.

### `publish-slap [provider]`

Publish a SLAP token advertising that this node offers a lookup service.

```bash
export OVERLAY_WIF="<your-wif>"
node cli.js publish-slap relay-topic-lookup
```

Same flow as SHIP but for lookup service discovery (BRC-88 SLAP).

### `help`

```bash
node cli.js help
```

## HTTP API

### `POST /submit`

Submit a SHIP token for admission into the directory.

**BRC-22 canonical body:**
```json
{
  "rawTx": "<hex>",
  "topics": ["SHIP"]
}
```

**Simplified body:**
```json
{
  "txHex": "<hex>",
  "outputIndex": 0
}
```

**Response:**
```json
{
  "status": "success",
  "topics": {
    "oracle:rates:bsv": [0]
  }
}
```

The topic manager validates:
- BRC-48 script format (4 push data fields + OP_DROP + OP_2DROP + OP_DROP + pubkey + OP_CHECKSIG)
- Identity key is a valid compressed secp256k1 pubkey
- Topic uses colon-separated namespace
- Locking pubkey matches BRC-42 derivation from the identity key (invoice `2-SHIP-1`)

### `POST /lookup`

Query the directory. Follows BRC-24 with provider routing.

**Request:**
```json
{
  "provider": "relay-topic-lookup",
  "query": { "topic": "oracle:rates:bsv" }
}
```

**Query shapes:**

| Query | What it returns |
|---|---|
| `{ "topic": "oracle:rates:bsv" }` | Bridges carrying this topic |
| `{ "bridge": "02abc..." }` | Topics a bridge carries |
| `{ "list": "topics" }` | All topics with counts |
| `{ "list": "all" }` | Full directory dump |

**Response (topic/bridge/all):**
```json
{
  "type": "output-list",
  "outputs": [
    {
      "txid": "abc...",
      "vout": 0,
      "satoshis": 1,
      "topic": "oracle:rates:bsv",
      "domain": "vmi2946361.contaboserver.net",
      "identityPubHex": "03cd06c1...",
      "lockingPubHex": "02b2af5f..."
    }
  ]
}
```

**Response (list topics):**
```json
{
  "type": "topic-summary",
  "results": [
    { "topic": "oracle:rates:bsv", "count": 1 }
  ]
}
```

### `POST /revoke`

Remove a SHIP token from the directory. Requires the spending transaction as proof.

```json
{
  "spendingTxHex": "<hex of tx that spends the SHIP token>",
  "spentTxid": "<txid of the SHIP token tx>",
  "spentOutputIndex": 0
}
```

### `GET /status`

Health check. Always free.

```json
{
  "service": "relay-directory-overlay",
  "status": "ok",
  "topics": 1,
  "entries": 1
}
```

## Payment (BRC-105)

Endpoints can be priced via environment variables:

```
OVERLAY_PRICE_SUBMIT=0    # sats per listing (default: free)
OVERLAY_PRICE_LOOKUP=0    # sats per query (default: free)
OVERLAY_PRICE_REVOKE=0    # sats per revocation (default: free)
```

When pricing is non-zero and `OVERLAY_WIF` is set, the server:
1. Returns HTTP 402 with `x-bsv-payment-satoshis-required` and `x-bsv-payment-derivation-prefix`
2. Derives a payment address from the overlay identity using BRC-42
3. Client retries with `x-bsv-payment` header containing a transaction paying to that address
4. Server verifies the output, prevents replay, and proceeds

**Current limitation:** Payment verification checks transaction structure (correct address, sufficient amount, prefix not replayed) but does not confirm the transaction is broadcast or confirmed on-chain. Deploy with pricing at 0 until on-chain settlement verification is added.

## Multi-Node Sync

Configure peer overlay nodes for directory replication:

```
OVERLAY_PEERS=http://peer1:3360,http://peer2:3360
```

When a SHIP token is admitted on one node, it propagates to all configured peers. Loop prevention via `x-overlay-sync` header ensures entries don't bounce between mutual peers.

## Client SDK

```javascript
import { DirectoryClient } from './lib/client.js'

const client = new DirectoryClient('http://vmi2946361.contaboserver.net:3360')

// Find bridges carrying a topic
const bridges = await client.findByTopic('oracle:rates:bsv')

// Find topics a bridge carries
const topics = await client.findByBridge('03cd06c1...')

// List all topics
const allTopics = await client.listTopics()

// Check overlay health
const status = await client.status()
```

The client handles 402 payment challenges gracefully — returns a `paymentRequired` object instead of throwing.

## Production Deployment

### systemd

```ini
[Unit]
Description=Relay Directory Overlay
After=network-online.target
Wants=network-online.target

[Service]
User=root
WorkingDirectory=/opt/relay-overlay
EnvironmentFile=/opt/relay-overlay/.env
ExecStart=/usr/bin/node /opt/relay-overlay/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Deployment steps

```bash
# Clone
git clone https://github.com/BSVanon/relay-directory-overlay.git /opt/relay-overlay
cd /opt/relay-overlay
npm install

# Identity
node cli.js init
# Save the WIF securely

# Configure
cp .env.example .env
# Edit: set OVERLAY_WIF, OVERLAY_DOMAIN

# Firewall
sudo ufw allow 3360/tcp comment 'mesh-directory overlay'

# Service
sudo cp mesh-directory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mesh-directory
sudo systemctl start mesh-directory

# Verify
curl -s http://127.0.0.1:3360/status

# Fund the overlay address (~50,000 sats)
# Then publish:
export OVERLAY_WIF="<your-wif>"
node cli.js publish-ship oracle:rates:bsv
node cli.js publish-slap relay-topic-lookup
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OVERLAY_WIF` | Yes (for CLI) | — | Identity private key in WIF format |
| `OVERLAY_DOMAIN` | Yes | localhost | Public domain of this overlay node |
| `OVERLAY_PORT` | No | 3360 | HTTP server port |
| `OVERLAY_DB_PATH` | No | ./data/directory.db | LevelDB path |
| `OVERLAY_PEERS` | No | — | Comma-separated peer overlay URLs |
| `OVERLAY_CORS_ORIGINS` | No | * | Comma-separated allowed origins |
| `OVERLAY_PRICE_SUBMIT` | No | 0 | Sats per /submit |
| `OVERLAY_PRICE_LOOKUP` | No | 0 | Sats per /lookup |
| `OVERLAY_PRICE_REVOKE` | No | 0 | Sats per /revoke |

## Architecture

```
lib/
├── wallet.js              # WIF identity, BRC-42 derivation, BRC-48 SHIP tx building
├── ship-topic-manager.js  # BRC-22 admission: parse BRC-48, verify derivation, admit/revoke
├── store.js               # LevelDB with topic and bridge indexes
├── lookup.js              # BRC-24 query resolution
├── handlers.js            # HTTP handlers (BRC-22/24 shapes, CORS, sync awareness)
├── client.js              # Consumer SDK for querying the overlay
├── sync.js                # Multi-node propagation with loop prevention
├── slap.js                # SLAP token build, parse, validate
└── payment.js             # BRC-105 payment gates with BRC-42 derived verification
server.js                  # Routing and wiring (96 lines)
cli.js                     # Operator commands: init, status, publish-ship, publish-slap
```

## Standards Reference

| Standard | Usage |
|---|---|
| [BRC-22](https://github.com/bitcoin-sv/BRCs/blob/master/overlays/0022.md) | Transaction submission / overlay admission |
| [BRC-24](https://github.com/bitcoin-sv/BRCs/blob/master/overlays/0024.md) | Lookup services / query resolution |
| [BRC-42](https://github.com/bitcoin-sv/BRCs/blob/master/key-derivation/0042.md) | Key derivation for SHIP/SLAP signing and payment addresses |
| [BRC-43](https://github.com/bitcoin-sv/BRCs/blob/master/key-derivation/0043.md) | Invoice numbering (security levels, protocol IDs) |
| [BRC-48](https://github.com/bitcoin-sv/BRCs/blob/master/scripts/0048.md) | Pay to Push Drop — SHIP/SLAP token output script |
| [BRC-88](https://github.com/bitcoin-sv/BRCs/blob/master/overlays/0088.md) | SHIP/SLAP synchronization architecture |
| [BRC-105](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0105.md) | HTTP micropayment framework |

## Known Limitations (v0.1.0)

- **No BRC-31 authentication** — endpoints are open HTTP. Suitable for single-operator deployment. Multi-operator trust requires BRC-31 mutual authentication (future work).
- **On-chain verification depends on WhatsOnChain** — tx broadcast/confirmation checks use WoC API. If WoC is unavailable, submissions and payments are rejected rather than accepted on trust.

## License

Open BSV License version 4 — see [LICENSE.txt](LICENSE.txt)
