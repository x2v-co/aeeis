#!/usr/bin/env node

/**
 * Development-only Planprice HTTP fixture. It implements the two read
 * endpoints consumed by PlanpriceHttpCatalog so Compose can exercise catalog
 * routing without depending on a live pricing database or provider account.
 */

import { createServer } from 'node:http';

const host = process.env.AEEIS_FIXTURE_PLANPRICE_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_FIXTURE_PLANPRICE_PORT ?? 4699);

const grouped = [{
  slug: 'aeeis-fixture',
  context_window: 128000,
  versions: [{
    model_slug: 'aeeis-fixture/1',
    providers: { slug: 'compose-fixture' },
    input_price_per_1m: 0.01,
    output_price_per_1m: 0.02,
    currency: 'USD',
    is_available: true,
  }],
}];

const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET') { response.writeHead(405); response.end(JSON.stringify({ error: 'method_not_allowed' })); return; }
  if (request.url?.startsWith('/health')) { response.writeHead(200); response.end(JSON.stringify({ status: 'ok', mode: 'development-fixture' })); return; }
  if (request.url?.startsWith('/api/products/grouped')) { response.writeHead(200); response.end(JSON.stringify(grouped)); return; }
  if (request.url?.startsWith('/api/exchange-rates')) { response.writeHead(200); response.end(JSON.stringify({ rates: { CNY: 7.2, EUR: 0.92 }, allRates: { USD: { CNY: 7.2, EUR: 0.92 } }, lastUpdated: '2026-09-21T00:00:00.000Z' })); return; }
  response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, host, () => console.log(`AEEIS Planprice fixture listening on http://${host}:${port}`));
