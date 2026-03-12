/**
 * Catalog Routes — Public endpoints for browsing the Honey shelf
 * No auth required. Rate limited by IP.
 */

import { jsonResponse } from '../index.js';

const TIER_ORDER = ['genesis', 'honey', 'cluster', 'cell', 'swarm'];

function tiersAtOrAbove(minimum) {
  const idx = TIER_ORDER.indexOf(minimum);
  return idx >= 0 ? TIER_ORDER.slice(0, idx + 1) : TIER_ORDER;
}

export async function handleCatalog(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // GET /honey/stats
  if (path === '/honey/stats') {
    return getStats(env);
  }

  // GET /honey/catalog
  if (path === '/honey/catalog' || path === '/honey/catalog/') {
    return getCatalog(env);
  }

  // Parse task_type from path
  const parts = path.replace('/honey/catalog/', '').split('/');
  const taskType = decodeURIComponent(parts[0]);
  const subpath = parts[1] || '';

  if (!taskType) {
    return jsonResponse(400, { error: 'Missing task_type' });
  }

  // GET /honey/catalog/:task_type/samples
  if (subpath === 'samples') {
    return getSamples(env, taskType);
  }

  // GET /honey/catalog/:task_type/honeycard
  if (subpath === 'honeycard') {
    return getHoneyCard(env, taskType);
  }

  // GET /honey/catalog/:task_type
  return getTaskDetail(env, taskType);
}

// ── GET /honey/catalog ──────────────────────

async function getCatalog(env) {
  // Aggregate stats per task type
  const rows = await env.DB.prepare(`
    SELECT 
      task_type,
      tier,
      COUNT(*) as cnt,
      ROUND(AVG(score), 1) as avg_score
    FROM cells
    GROUP BY task_type, tier
    ORDER BY task_type, tier
  `).all();

  // Group by task type
  const taskMap = {};
  for (const row of rows.results) {
    if (!taskMap[row.task_type]) {
      taskMap[row.task_type] = { task_type: row.task_type, total: 0, tiers: {}, avg_score: 0, scores_sum: 0 };
    }
    const t = taskMap[row.task_type];
    t.tiers[row.tier] = row.cnt;
    t.total += row.cnt;
    t.scores_sum += row.avg_score * row.cnt;
  }

  // Compute weighted avg scores
  const taskTypes = Object.values(taskMap).map(t => ({
    task_type: t.task_type,
    total: t.total,
    tiers: t.tiers,
    avg_score: Math.round((t.scores_sum / t.total) * 10) / 10,
    honeycard_url: `/honey/catalog/${encodeURIComponent(t.task_type)}/honeycard`,
    samples_url: `/honey/catalog/${encodeURIComponent(t.task_type)}/samples`,
  })).sort((a, b) => b.total - a.total);

  // Total stats
  const totalPairs = taskTypes.reduce((s, t) => s + t.total, 0);
  const totalScore = taskTypes.reduce((s, t) => s + t.avg_score * t.total, 0);

  return jsonResponse(200, {
    total_pairs: totalPairs,
    avg_score: Math.round((totalScore / totalPairs) * 10) / 10,
    master_lineage_hash: env.MASTER_LINEAGE_HASH,
    task_types: taskTypes,
    _cache: 'public, max-age=3600',
  });
}

// ── GET /honey/catalog/:task_type ───────────

async function getTaskDetail(env, taskType) {
  const stats = await env.DB.prepare(`
    SELECT 
      tier,
      COUNT(*) as cnt,
      ROUND(AVG(score), 1) as avg_score,
      ROUND(MIN(score), 1) as min_score,
      ROUND(MAX(score), 1) as max_score
    FROM cells
    WHERE task_type = ?
    GROUP BY tier
  `).bind(taskType).all();

  if (!stats.results.length) {
    return jsonResponse(404, { error: `Task type '${taskType}' not found` });
  }

  const tiers = {};
  let total = 0;
  let scoreSum = 0;
  for (const row of stats.results) {
    tiers[row.tier] = {
      count: row.cnt,
      avg_score: row.avg_score,
      min_score: row.min_score,
      max_score: row.max_score,
    };
    total += row.cnt;
    scoreSum += row.avg_score * row.cnt;
  }

  // Get 3 free samples
  const samples = await env.DB.prepare(`
    SELECT cell_id, tier, score, message_preview
    FROM cells
    WHERE task_type = ?
    AND tier IN ('honey', 'genesis')
    ORDER BY RANDOM()
    LIMIT 3
  `).bind(taskType).all();

  return jsonResponse(200, {
    task_type: taskType,
    total,
    avg_score: Math.round((scoreSum / total) * 10) / 10,
    tiers,
    samples: samples.results.map(s => ({
      cell_id: s.cell_id,
      tier: s.tier,
      score: s.score,
      preview: s.message_preview,
    })),
    honeycard_url: `/honey/catalog/${encodeURIComponent(taskType)}/honeycard`,
    order_url: '/honey/order',
    _cache: 'public, max-age=3600',
  });
}

// ── GET /honey/catalog/:task_type/samples ───

async function getSamples(env, taskType) {
  // Full pair content from R2 — 3 random Honey+ pairs
  const candidates = await env.DB.prepare(`
    SELECT cell_id, tier, score, r2_bucket, r2_key, line_number
    FROM cells
    WHERE task_type = ?
    AND tier IN ('honey', 'genesis')
    ORDER BY RANDOM()
    LIMIT 3
  `).bind(taskType).all();

  if (!candidates.results.length) {
    return jsonResponse(404, { error: `No samples available for '${taskType}'` });
  }

  // Fetch actual pair content from R2
  const samples = [];
  for (const c of candidates.results) {
    try {
      const content = await fetchPairFromR2(env, c.r2_bucket, c.r2_key, c.line_number);
      samples.push({
        cell_id: c.cell_id,
        tier: c.tier,
        score: c.score,
        messages: content?.messages || [],
      });
    } catch (err) {
      // Skip failed fetches, don't break the response
      console.error(`Failed to fetch sample ${c.cell_id}:`, err);
    }
  }

  return jsonResponse(200, {
    task_type: taskType,
    sample_count: samples.length,
    note: 'Free preview. Full pairs available via /honey/order.',
    samples,
  });
}

// ── GET /honey/catalog/:task_type/honeycard ─

async function getHoneyCard(env, taskType) {
  const card = await env.DB.prepare(`
    SELECT card_json FROM honeycards WHERE task_type = ?
  `).bind(taskType).first();

  if (!card) {
    return jsonResponse(404, { error: `No HoneyCard for '${taskType}'` });
  }

  return jsonResponse(200, JSON.parse(card.card_json));
}

// ── GET /honey/stats ────────────────────────

async function getStats(env) {
  const total = await env.DB.prepare('SELECT COUNT(*) as cnt FROM cells').first();
  
  const byDomain = await env.DB.prepare(`
    SELECT domain, COUNT(*) as cnt, ROUND(AVG(score), 1) as avg
    FROM cells GROUP BY domain
  `).all();
  
  const byTier = await env.DB.prepare(`
    SELECT tier, COUNT(*) as cnt
    FROM cells GROUP BY tier ORDER BY 
      CASE tier WHEN 'genesis' THEN 1 WHEN 'honey' THEN 2 
      WHEN 'cluster' THEN 3 WHEN 'cell' THEN 4 ELSE 5 END
  `).all();

  const topTasks = await env.DB.prepare(`
    SELECT task_type, COUNT(*) as cnt
    FROM cells GROUP BY task_type ORDER BY cnt DESC LIMIT 10
  `).all();

  return jsonResponse(200, {
    total_pairs: total?.cnt || 0,
    master_lineage_hash: env.MASTER_LINEAGE_HASH,
    by_domain: byDomain.results,
    by_tier: byTier.results,
    top_task_types: topTasks.results,
    _cache: 'public, max-age=3600',
  });
}

// ── R2 Pair Fetching ────────────────────────

async function fetchPairFromR2(env, bucketName, r2Key, lineNumber) {
  // Get the R2 binding based on bucket name
  const bucket = bucketName === 'sb-cre-verified' ? env.CRE_VERIFIED
    : bucketName === 'sb-medical-verified' ? env.MEDICAL_VERIFIED
    : null;

  if (!bucket) {
    throw new Error(`Unknown bucket: ${bucketName}`);
  }

  const obj = await bucket.get(r2Key);
  if (!obj) {
    throw new Error(`Object not found: ${bucketName}/${r2Key}`);
  }

  const text = await obj.text();
  const lines = text.split('\n').filter(l => l.trim());

  if (lineNumber >= lines.length) {
    throw new Error(`Line ${lineNumber} out of range (${lines.length} lines)`);
  }

  return JSON.parse(lines[lineNumber]);
}

export { fetchPairFromR2, tiersAtOrAbove };
