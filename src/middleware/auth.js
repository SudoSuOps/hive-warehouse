/**
 * Auth Middleware — API key authentication
 * Keys are stored as SHA-256 hashes in D1.
 */

export async function authenticate(request, env) {
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!apiKey) {
    return { ok: false, error: 'API key required. Pass via X-API-Key header.' };
  }

  // Hash the key for lookup
  const keyHash = await hashKey(apiKey);

  const row = await env.DB.prepare(`
    SELECT key_hash, customer_id, tier, rate_limit, monthly_pair_limit,
           pairs_used_this_month, month_reset, active
    FROM api_keys WHERE key_hash = ?
  `).bind(keyHash).first();

  if (!row) {
    return { ok: false, error: 'Invalid API key' };
  }

  if (!row.active) {
    return { ok: false, error: 'API key is deactivated' };
  }

  // Reset monthly counter if needed
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (row.month_reset !== currentMonth) {
    await env.DB.prepare(`
      UPDATE api_keys SET pairs_used_this_month = 0, month_reset = ? WHERE key_hash = ?
    `).bind(currentMonth, keyHash).run();
    row.pairs_used_this_month = 0;
  }

  // Update last used
  await env.DB.prepare(`
    UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?
  `).bind(keyHash).run();

  return {
    ok: true,
    customer_id: row.customer_id,
    tier: row.tier,
    rate_limit: row.rate_limit,
    monthly_pair_limit: row.monthly_pair_limit,
    pairs_used_this_month: row.pairs_used_this_month,
    key_hash: keyHash,
  };
}

async function hashKey(key) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export { hashKey };
