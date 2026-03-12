/**
 * Order Routes — Authenticated endpoints for purchasing and receiving pairs
 */

import { jsonResponse } from '../index.js';
import { fulfillOrder, calculatePrice } from '../services/fulfillment.js';
import { sha256 } from '../services/merkle.js';

const VALID_TIERS = ['genesis', 'honey', 'cluster', 'cell'];
const TIER_CAPS = {
  explorer: 'cell',
  pro: 'honey',
  enterprise: 'genesis',
};

export async function handleOrders(request, env, url, auth) {
  const path = url.pathname;
  const method = request.method;

  // POST /honey/order — create new order
  if (path === '/honey/order' && method === 'POST') {
    return createOrder(request, env, auth);
  }

  // GET /honey/orders — list my orders
  if (path === '/honey/orders' && method === 'GET') {
    return listOrders(env, auth);
  }

  // Parse order_id from path
  const match = path.match(/\/honey\/order\/([^/]+)(\/(.+))?/);
  if (!match) {
    return jsonResponse(404, { error: 'Not found' });
  }
  const orderId = match[1];
  const action = match[3] || '';

  // GET /honey/order/:id
  if (!action && method === 'GET') {
    return getOrder(env, auth, orderId);
  }

  // GET /honey/order/:id/download
  if (action === 'download' && method === 'GET') {
    return downloadOrder(env, auth, orderId);
  }

  // POST /honey/order/:id/verify
  if (action === 'verify' && method === 'POST') {
    return verifyOrder(request, env, auth, orderId);
  }

  return jsonResponse(404, { error: 'Not found' });
}

// ── POST /honey/order ───────────────────────

async function createOrder(request, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { task_type, tier_minimum, quantity, payment_method } = body;

  // Validate inputs
  if (!task_type) return jsonResponse(400, { error: 'task_type required' });
  if (!tier_minimum || !VALID_TIERS.includes(tier_minimum)) {
    return jsonResponse(400, { error: `tier_minimum must be one of: ${VALID_TIERS.join(', ')}` });
  }
  if (!quantity || quantity < 1 || quantity > 10000) {
    return jsonResponse(400, { error: 'quantity must be between 1 and 10,000' });
  }
  if (!payment_method || !['stripe', 'usdc', 'free'].includes(payment_method)) {
    return jsonResponse(400, { error: 'payment_method must be: stripe, usdc, or free' });
  }

  // Check tier access
  const maxTier = TIER_CAPS[auth.tier] || 'cell';
  const tierOrder = VALID_TIERS;
  if (tierOrder.indexOf(tier_minimum) < tierOrder.indexOf(maxTier)) {
    return jsonResponse(403, {
      error: `Your plan (${auth.tier}) allows up to ${maxTier} tier. Upgrade for ${tier_minimum}.`,
    });
  }

  // Check monthly limits
  const remaining = auth.monthly_pair_limit - auth.pairs_used_this_month;
  if (payment_method === 'free' && quantity > remaining) {
    return jsonResponse(403, {
      error: `Monthly limit: ${remaining} pairs remaining. Use paid payment method for more.`,
    });
  }

  // Calculate price
  const priceCents = payment_method === 'free' ? 0 : calculatePrice(tier_minimum, quantity, auth.tier);
  const orderId = `ord_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // Check inventory
  const available = await env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM cells
    WHERE task_type = ? AND tier = ?
    AND reserved_for IS NULL
    AND cell_id NOT IN (
      SELECT d.cell_id FROM deliveries d
      JOIN orders o ON d.order_id = o.order_id
      WHERE o.customer_id = ?
    )
  `).bind(task_type, tier_minimum, auth.customer_id).first();

  if ((available?.cnt || 0) < quantity) {
    return jsonResponse(409, {
      error: `Insufficient inventory: ${available?.cnt || 0} available for ${task_type}/${tier_minimum}`,
      available: available?.cnt || 0,
      requested: quantity,
    });
  }

  // Create order
  await env.DB.prepare(`
    INSERT INTO orders (order_id, customer_id, task_type, tier_minimum, quantity, price_cents, payment_method, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId, auth.customer_id, task_type, tier_minimum, quantity, priceCents,
    payment_method, payment_method === 'free' ? 'paid' : 'pending'
  ).run();

  // Auto-fulfill free orders immediately
  if (payment_method === 'free') {
    try {
      const order = { order_id: orderId, customer_id: auth.customer_id, task_type, tier_minimum, quantity };
      const deliveryCard = await fulfillOrder(env, order, auth.tier);
      return jsonResponse(201, {
        order_id: orderId,
        status: 'delivered',
        quantity,
        price_cents: 0,
        delivery: deliveryCard,
        download_url: `/honey/order/${orderId}/download`,
        verify_url: `/honey/order/${orderId}/verify`,
      });
    } catch (err) {
      await env.DB.prepare(`UPDATE orders SET status = 'failed', error_message = ? WHERE order_id = ?`)
        .bind(err.message, orderId).run();
      return jsonResponse(500, { error: `Fulfillment failed: ${err.message}` });
    }
  }

  // For paid orders, return payment instructions
  return jsonResponse(201, {
    order_id: orderId,
    status: 'pending',
    quantity,
    price_cents: priceCents,
    price_display: `$${(priceCents / 100).toFixed(2)}`,
    payment_method,
    payment_instructions: payment_method === 'stripe'
      ? { message: 'Complete payment via Stripe checkout', checkout_url: `STRIPE_CHECKOUT_URL/${orderId}` }
      : { message: 'Send USDC to the following address', address: 'USDC_WALLET_ADDRESS', amount_usd: (priceCents / 100).toFixed(2), memo: orderId },
    next: `After payment, your order will be fulfilled automatically. Check status at /honey/order/${orderId}`,
  });
}

// ── GET /honey/orders ───────────────────────

async function listOrders(env, auth) {
  const orders = await env.DB.prepare(`
    SELECT order_id, task_type, tier_minimum, quantity, actual_quantity,
           price_cents, payment_method, status, created_at, delivered_at
    FROM orders WHERE customer_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).bind(auth.customer_id).all();

  return jsonResponse(200, {
    customer_id: auth.customer_id,
    orders: orders.results.map(o => ({
      ...o,
      price_display: `$${(o.price_cents / 100).toFixed(2)}`,
      download_url: o.status === 'delivered' ? `/honey/order/${o.order_id}/download` : null,
    })),
  });
}

// ── GET /honey/order/:id ────────────────────

async function getOrder(env, auth, orderId) {
  const order = await env.DB.prepare(`
    SELECT * FROM orders WHERE order_id = ? AND customer_id = ?
  `).bind(orderId, auth.customer_id).first();

  if (!order) {
    return jsonResponse(404, { error: 'Order not found' });
  }

  return jsonResponse(200, {
    ...order,
    price_display: `$${(order.price_cents / 100).toFixed(2)}`,
    download_url: order.status === 'delivered' ? `/honey/order/${orderId}/download` : null,
    verify_url: order.status === 'delivered' ? `/honey/order/${orderId}/verify` : null,
    delivery_honeycard: order.delivery_honeycard ? JSON.parse(order.delivery_honeycard) : null,
  });
}

// ── GET /honey/order/:id/download ───────────

async function downloadOrder(env, auth, orderId) {
  const order = await env.DB.prepare(`
    SELECT delivery_r2_key, status, customer_id FROM orders WHERE order_id = ?
  `).bind(orderId).first();

  if (!order || order.customer_id !== auth.customer_id) {
    return jsonResponse(404, { error: 'Order not found' });
  }
  if (order.status !== 'delivered') {
    return jsonResponse(400, { error: `Order status is '${order.status}', not 'delivered'` });
  }

  // Fetch from deliveries bucket
  const pairsObj = await env.DELIVERIES.get(order.delivery_r2_key);
  if (!pairsObj) {
    return jsonResponse(500, { error: 'Delivery file not found in storage' });
  }

  const cardKey = order.delivery_r2_key.replace('pairs.jsonl', 'HONEYCARD.json');
  const cardObj = await env.DELIVERIES.get(cardKey);

  // Return as multipart or JSON with both files
  const pairs = await pairsObj.text();
  const card = cardObj ? await cardObj.text() : null;

  return jsonResponse(200, {
    order_id: orderId,
    pairs_jsonl: pairs,
    honeycard: card ? JSON.parse(card) : null,
    verify_command: 'python3 -m hive.verify delivery pairs.jsonl --honeycard HONEYCARD.json',
  });
}

// ── POST /honey/order/:id/verify ────────────

async function verifyOrder(request, env, auth, orderId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { merkle_root } = body;
  if (!merkle_root) {
    return jsonResponse(400, { error: 'merkle_root required in body' });
  }

  const order = await env.DB.prepare(`
    SELECT delivery_merkle_root, customer_id, status FROM orders WHERE order_id = ?
  `).bind(orderId).first();

  if (!order || order.customer_id !== auth.customer_id) {
    return jsonResponse(404, { error: 'Order not found' });
  }

  const match = order.delivery_merkle_root === merkle_root;

  return jsonResponse(200, {
    order_id: orderId,
    verified: match,
    expected_root: order.delivery_merkle_root,
    provided_root: merkle_root,
    status: match ? 'VERIFIED — you got what you paid for' : 'MISMATCH — delivery may have been tampered with',
  });
}
