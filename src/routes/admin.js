/**
 * Admin Routes — Internal operations
 */

import { jsonResponse } from '../index.js';
import { hashKey } from '../middleware/auth.js';

export async function handleAdmin(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // GET /honey/admin/stats
  if (path === '/honey/admin/stats' && method === 'GET') {
    return getAdminStats(env);
  }

  // POST /honey/admin/api-key
  if (path === '/honey/admin/api-key' && method === 'POST') {
    return createApiKey(request, env);
  }

  // GET /honey/admin/inventory
  if (path === '/honey/admin/inventory' && method === 'GET') {
    return getInventory(env);
  }

  return jsonResponse(404, { error: 'Admin endpoint not found' });
}

async function getAdminStats(env) {
  const cells = await env.DB.prepare('SELECT COUNT(*) as cnt FROM cells').first();
  const orders = await env.DB.prepare('SELECT COUNT(*) as cnt, SUM(price_cents) as revenue FROM orders WHERE status = "delivered"').first();
  const customers = await env.DB.prepare('SELECT COUNT(DISTINCT customer_id) as cnt FROM api_keys WHERE active = 1').first();
  const deliveries = await env.DB.prepare('SELECT COUNT(*) as cnt FROM deliveries').first();

  const topSold = await env.DB.prepare(`
    SELECT task_type, SUM(actual_quantity) as sold
    FROM orders WHERE status = 'delivered'
    GROUP BY task_type ORDER BY sold DESC LIMIT 10
  `).all();

  return jsonResponse(200, {
    cells_indexed: cells?.cnt || 0,
    total_orders: orders?.cnt || 0,
    total_revenue_cents: orders?.revenue || 0,
    total_revenue_display: `$${((orders?.revenue || 0) / 100).toFixed(2)}`,
    active_customers: customers?.cnt || 0,
    pairs_delivered: deliveries?.cnt || 0,
    top_sold_tasks: topSold.results,
  });
}

async function createApiKey(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { customer_id, name, tier } = body;
  if (!customer_id) return jsonResponse(400, { error: 'customer_id required' });

  const validTiers = ['explorer', 'pro', 'enterprise'];
  const keyTier = validTiers.includes(tier) ? tier : 'explorer';

  const limits = {
    explorer: { rate: 60, monthly: 100 },
    pro: { rate: 300, monthly: 1000 },
    enterprise: { rate: 1000, monthly: 100000 },
  };

  // Generate raw key
  const rawKey = `sb_${keyTier}_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = await hashKey(rawKey);

  await env.DB.prepare(`
    INSERT INTO api_keys (key_hash, customer_id, name, tier, rate_limit, monthly_pair_limit, month_reset)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    keyHash, customer_id, name || null, keyTier,
    limits[keyTier].rate, limits[keyTier].monthly,
    new Date().toISOString().slice(0, 7)
  ).run();

  // Audit log
  await env.DB.prepare(`
    INSERT INTO audit_log (action, entity_type, entity_id, actor, detail)
    VALUES ('create', 'api_key', ?, 'admin', ?)
  `).bind(keyHash.slice(0, 16), `tier=${keyTier}, customer=${customer_id}`).run();

  return jsonResponse(201, {
    message: 'API key created. Store this key securely — it cannot be retrieved again.',
    api_key: rawKey,
    tier: keyTier,
    rate_limit: limits[keyTier].rate,
    monthly_pair_limit: limits[keyTier].monthly,
    customer_id,
  });
}

async function getInventory(env) {
  const byTaskTier = await env.DB.prepare(`
    SELECT task_type, tier, COUNT(*) as total,
           SUM(times_sold) as sold,
           COUNT(*) - SUM(CASE WHEN times_sold > 0 THEN 1 ELSE 0 END) as unsold
    FROM cells
    GROUP BY task_type, tier
    ORDER BY task_type, tier
  `).all();

  return jsonResponse(200, {
    inventory: byTaskTier.results,
  });
}
