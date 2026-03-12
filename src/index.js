/**
 * Hive Warehouse — Main Worker Entry
 * Swarm & Bee LLC
 * 
 * Routes all /honey/* requests to the appropriate handler.
 */

import { handleCatalog } from './routes/catalog.js';
import { handleOrders } from './routes/orders.js';
import { handleAdmin } from './routes/admin.js';
import { authenticate } from './middleware/auth.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response;

      // Public catalog endpoints (no auth)
      if (path.startsWith('/honey/catalog') || path === '/honey/stats') {
        response = await handleCatalog(request, env, url);
      }
      // Order endpoints (auth required)
      else if (path.startsWith('/honey/order')) {
        const auth = await authenticate(request, env);
        if (!auth.ok) {
          return jsonResponse(401, { error: auth.error }, corsHeaders);
        }
        response = await handleOrders(request, env, url, auth);
      }
      // Admin endpoints
      else if (path.startsWith('/honey/admin')) {
        const auth = await authenticate(request, env);
        if (!auth.ok || auth.tier !== 'enterprise') {
          return jsonResponse(403, { error: 'Admin access required' }, corsHeaders);
        }
        response = await handleAdmin(request, env, url);
      }
      // Health check
      else if (path === '/honey/health') {
        const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM cells').first();
        response = jsonResponse(200, {
          status: 'ok',
          cells_indexed: count?.cnt || 0,
          version: '1.0.0',
          lineage_hash: env.MASTER_LINEAGE_HASH,
        });
      }
      // Root
      else if (path === '/honey' || path === '/honey/') {
        response = jsonResponse(200, {
          name: 'Hive Warehouse',
          description: 'Verified intelligence pairs for AI systems',
          docs: '/honey/catalog',
          health: '/honey/health',
          by: 'Swarm & Bee LLC',
        });
      }
      else {
        response = jsonResponse(404, { error: 'Not found' });
      }

      // Add CORS and cache headers
      const finalHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        headers: finalHeaders,
      });

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse(500, { error: 'Internal server error' }, corsHeaders);
    }
  },
};

function jsonResponse(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

export { jsonResponse };
