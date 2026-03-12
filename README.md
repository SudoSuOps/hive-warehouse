# Hive Warehouse

The intelligence supply chain for Swarm & Bee AI.

Verified pairs in. Verified pairs out. Cryptographic proof at every step.

## What This Is

The Honey Warehouse connects 810K+ verified CRE intelligence pairs (stored in Cloudflare R2) to customers via a catalog API, fulfillment engine, and delivery verification system. Every pair is Hive-stamped, quality-scored, and Merkle-rooted.

## Architecture

```
swarmandbee.ai/honey          ← Browse, preview, purchase
        │
api.swarmandbee.com/honey/    ← Catalog + Fulfillment API (CF Workers)
        │
Honey Index (Cloudflare D1)   ← 810K pairs indexed: cell_id, task, tier, score
        │
R2 Verified Buckets            ← sb-cre-verified, sb-medical-verified
```

## Stack

- **Runtime**: Cloudflare Workers (edge, zero cold start)
- **Database**: Cloudflare D1 (SQLite at edge)
- **Storage**: Cloudflare R2 (verified buckets)
- **Payments**: Stripe + USDC on-chain
- **Auth**: API keys (hashed, rate-limited)
- **Verification**: hive/verify.py (open source)

Everything on Cloudflare. No external dependencies.

## Quick Start

```bash
# Install deps
npm install

# Run locally
npx wrangler dev

# Deploy
npx wrangler deploy

# Populate the index
npx wrangler d1 execute honey-db --file=migrations/001_schema.sql
python3 scripts/populate_index.py
```

## API Endpoints

### Public (no auth)
```
GET  /honey/catalog                    → All task types with tier counts
GET  /honey/catalog/:task_type         → Detail + 3 free samples
GET  /honey/catalog/:task_type/samples → Random samples (rate limited)
GET  /honey/catalog/:task_type/honeycard → Full HoneyCard JSON
GET  /honey/stats                      → Aggregate stats
```

### Authenticated (API key required)
```
POST /honey/order                      → Create order
GET  /honey/order/:id                  → Order status
GET  /honey/order/:id/download         → Signed R2 download URL
POST /honey/order/:id/verify           → Verify delivery Merkle root
GET  /honey/orders                     → List my orders
```

### Admin
```
POST /honey/admin/populate             → Populate index from R2
GET  /honey/admin/stats                → Internal metrics
```

## Pricing

| Tier | Per Pair | Monthly | Included | Max Quality |
|------|----------|---------|----------|-------------|
| Explorer | - | Free | 100 Cell/mo | Cell |
| Pro | $0.20 | $99/mo | 1,000 Honey/mo | Honey |
| Enterprise | Custom | Custom | Custom | Genesis |

## Verification

Customers verify deliveries independently:
```bash
pip install swarm-hive
python3 -m hive.verify delivery pairs.jsonl --honeycard HONEYCARD.json
```

## License

Proprietary. Swarm & Bee LLC © 2026.
