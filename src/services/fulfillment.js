/**
 * Fulfillment Engine — Select, package, prove, deliver.
 * The critical path. Every step verified.
 */

import { computeMerkleRoot } from './merkle.js';
import { fetchPairFromR2, tiersAtOrAbove } from '../routes/catalog.js';

const PRICE_PER_PAIR = {
  royal_jelly: 50,  // $0.50 in cents
  honey: 20,        // $0.20
  pollen: 8,        // $0.08
  propolis: 3,      // $0.03
};

export function calculatePrice(tierMinimum, quantity, customerTier) {
  const pricePerPair = PRICE_PER_PAIR[tierMinimum] || PRICE_PER_PAIR.honey;
  let total = pricePerPair * quantity;

  // Tier discounts
  if (customerTier === 'pro') total = Math.round(total * 0.85);
  if (customerTier === 'enterprise') total = Math.round(total * 0.70);

  return total;
}

export async function fulfillOrder(env, order, customerTier) {
  const tiers = tiersAtOrAbove(order.tier_minimum);
  const tierPlaceholders = tiers.map(() => '?').join(',');

  // 1. SELECT candidates — not already delivered to this customer
  const query = `
    SELECT c.cell_id, c.fingerprint, c.tier, c.score, c.r2_bucket, c.r2_key, c.line_number
    FROM cells c
    WHERE c.task_type = ?
    AND c.tier IN (${tierPlaceholders})
    AND c.reserved_for IS NULL
    AND c.cell_id NOT IN (
      SELECT d.cell_id FROM deliveries d
      JOIN orders o ON d.order_id = o.order_id
      WHERE o.customer_id = ?
    )
    ORDER BY RANDOM()
    LIMIT ?
  `;

  const params = [order.task_type, ...tiers, order.customer_id, order.quantity];
  const candidates = await env.DB.prepare(query).bind(...params).all();

  if (candidates.results.length < order.quantity) {
    throw new Error(
      `Insufficient inventory: ${candidates.results.length} available, ${order.quantity} requested. ` +
      `Try a lower tier or smaller quantity.`
    );
  }

  // 2. FETCH actual pair content from R2
  const pairs = [];
  const fingerprints = [];
  for (const c of candidates.results) {
    const content = await fetchPairFromR2(env, c.r2_bucket, c.r2_key, c.line_number);
    pairs.push({
      cell_id: c.cell_id,
      fingerprint: c.fingerprint,
      tier: c.tier,
      score: c.score,
      messages: content.messages || content.conversations || [],
    });
    fingerprints.push(c.fingerprint);
  }

  // 3. COMPUTE delivery Merkle root
  const merkleRoot = await computeMerkleRoot(fingerprints);

  // 4. BUILD delivery HoneyCard
  const deliveryId = `del_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const avgScore = Math.round(pairs.reduce((s, p) => s + p.score, 0) / pairs.length * 10) / 10;
  
  const tierCounts = {};
  for (const p of pairs) {
    tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1;
  }

  const deliveryCard = {
    delivery_id: deliveryId,
    order_id: order.order_id,
    customer_id: order.customer_id,
    task_type: order.task_type,
    tier_minimum: order.tier_minimum,
    quantity: pairs.length,
    actual_avg_score: avgScore,
    tier_distribution: tierCounts,
    pairs_merkle_root: merkleRoot,
    master_lineage_hash: env.MASTER_LINEAGE_HASH,
    delivered_at: new Date().toISOString(),
    verify_command: 'python3 -m hive.verify delivery pairs.jsonl --honeycard HONEYCARD.json',
  };

  // 5. PACKAGE as JSONL
  const pairsJsonl = pairs.map(p => JSON.stringify({
    cell_id: p.cell_id,
    fingerprint: p.fingerprint,
    tier: p.tier,
    score: p.score,
    messages: p.messages,
  })).join('\n') + '\n';

  // 6. UPLOAD to deliveries bucket
  const pairsKey = `deliveries/${order.order_id}/pairs.jsonl`;
  const cardKey = `deliveries/${order.order_id}/HONEYCARD.json`;

  await env.DELIVERIES.put(pairsKey, pairsJsonl, {
    customMetadata: {
      order_id: order.order_id,
      customer_id: order.customer_id,
      pair_count: String(pairs.length),
      merkle_root: merkleRoot,
    },
  });

  await env.DELIVERIES.put(cardKey, JSON.stringify(deliveryCard, null, 2), {
    customMetadata: {
      order_id: order.order_id,
      delivery_id: deliveryId,
    },
  });

  // 7. VERIFY upload (read-back)
  const verifyPairs = await env.DELIVERIES.head(pairsKey);
  const verifyCard = await env.DELIVERIES.head(cardKey);
  if (!verifyPairs || !verifyCard) {
    throw new Error('Delivery upload verification FAILED — objects not found in R2 after upload');
  }

  // 8. RECORD deliveries in D1
  const insertStmt = env.DB.prepare(
    'INSERT INTO deliveries (order_id, cell_id, delivered_at) VALUES (?, ?, datetime("now"))'
  );
  const updateStmt = env.DB.prepare(
    'UPDATE cells SET times_sold = times_sold + 1, last_sold_at = datetime("now") WHERE cell_id = ?'
  );

  // Batch in groups of 50 to avoid D1 limits
  for (let i = 0; i < candidates.results.length; i += 50) {
    const batch = candidates.results.slice(i, i + 50);
    const stmts = [];
    for (const c of batch) {
      stmts.push(insertStmt.bind(order.order_id, c.cell_id));
      stmts.push(updateStmt.bind(c.cell_id));
    }
    await env.DB.batch(stmts);
  }

  // 9. UPDATE order
  await env.DB.prepare(`
    UPDATE orders SET 
      status = 'delivered',
      actual_quantity = ?,
      delivery_r2_key = ?,
      delivery_honeycard = ?,
      delivery_merkle_root = ?,
      delivered_at = datetime('now')
    WHERE order_id = ?
  `).bind(
    pairs.length,
    pairsKey,
    JSON.stringify(deliveryCard),
    merkleRoot,
    order.order_id
  ).run();

  // 10. UPDATE customer's monthly usage
  await env.DB.prepare(`
    UPDATE api_keys SET pairs_used_this_month = pairs_used_this_month + ? 
    WHERE customer_id = ?
  `).bind(pairs.length, order.customer_id).run();

  // 11. AUDIT LOG
  await env.DB.prepare(`
    INSERT INTO audit_log (action, entity_type, entity_id, actor, detail)
    VALUES ('fulfill', 'order', ?, ?, ?)
  `).bind(order.order_id, order.customer_id, `${pairs.length} pairs, merkle: ${merkleRoot.slice(0, 16)}...`).run();

  return deliveryCard;
}
