-- Hive Warehouse Schema v1
-- Swarm & Bee LLC — 2026-03-12
-- Run: wrangler d1 execute honey-db --file=migrations/001_schema.sql

-- ═══════════════════════════════════════════
-- CELLS — every verified pair gets a row
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cells (
    cell_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    task_type TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('royal_jelly','honey','pollen','propolis')),
    score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
    domain TEXT NOT NULL DEFAULT 'cre',
    cluster TEXT,
    r2_bucket TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    byte_offset INTEGER,
    message_preview TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    times_sold INTEGER DEFAULT 0,
    last_sold_at TEXT,
    reserved_for TEXT
);

CREATE INDEX IF NOT EXISTS idx_cells_task_tier ON cells(task_type, tier);
CREATE INDEX IF NOT EXISTS idx_cells_domain ON cells(domain);
CREATE INDEX IF NOT EXISTS idx_cells_score ON cells(score DESC);
CREATE INDEX IF NOT EXISTS idx_cells_fingerprint ON cells(fingerprint);
CREATE INDEX IF NOT EXISTS idx_cells_tier ON cells(tier);
CREATE INDEX IF NOT EXISTS idx_cells_reserved ON cells(reserved_for) WHERE reserved_for IS NOT NULL;

-- ═══════════════════════════════════════════
-- HONEYCARDS — quality cards per task type
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS honeycards (
    card_id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    domain TEXT NOT NULL,
    card_json TEXT NOT NULL,
    cell_count INTEGER NOT NULL,
    avg_score REAL NOT NULL,
    tier_distribution TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_honeycards_domain ON honeycards(domain);

-- ═══════════════════════════════════════════
-- ORDERS — customer purchases
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    tier_minimum TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    actual_quantity INTEGER,
    price_cents INTEGER NOT NULL,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('stripe','usdc','free')),
    payment_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','fulfilling','delivered','failed')),
    delivery_r2_key TEXT,
    delivery_honeycard TEXT,
    delivery_merkle_root TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    fulfilled_at TEXT,
    delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- ═══════════════════════════════════════════
-- DELIVERIES — track which cells went where
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (cell_id) REFERENCES cells(cell_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_order_cell ON deliveries(order_id, cell_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_cell ON deliveries(cell_id);

-- ═══════════════════════════════════════════
-- API KEYS — developer authentication
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_keys (
    key_hash TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    name TEXT,
    tier TEXT NOT NULL DEFAULT 'explorer' CHECK(tier IN ('explorer','pro','enterprise')),
    rate_limit INTEGER NOT NULL DEFAULT 60,
    monthly_pair_limit INTEGER NOT NULL DEFAULT 100,
    pairs_used_this_month INTEGER NOT NULL DEFAULT 0,
    month_reset TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_api_keys_customer ON api_keys(customer_id);

-- ═══════════════════════════════════════════
-- AUDIT LOG — every operation recorded
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
