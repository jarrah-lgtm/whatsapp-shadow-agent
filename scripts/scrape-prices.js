#!/usr/bin/env node
// Pulls every product + variant price from a Shopify or WooCommerce store and writes a CSV.
// Usage: node scripts/scrape-prices.js [baseUrl] [outFile]
//   default baseUrl: https://peptidesolutions.au   default outFile: prices-<host>-<date>.csv
const fs = require('fs');

const BASE = (process.argv[2] || 'https://peptidesolutions.au').replace(/\/+$/, '');
const OUT = process.argv[3] || `prices-${new URL(BASE).host}-${new Date().toISOString().slice(0, 10)}.csv`;
const UA = 'Mozilla/5.0 (price-check script)';
const MAX_PAGES = 100;
const failures = [];

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) {
      failures.push(`${url} -> HTTP ${res.status}`);
      return null;
    }
    if (!(res.headers.get('content-type') || '').includes('json')) {
      failures.push(`${url} -> not JSON (${res.headers.get('content-type')})`);
      return null;
    }
    return res.json();
  }
  throw new Error(`Gave up on ${url} after 3 attempts`);
}

// Shopify: /products.json, 250 per page, stop on an empty page.
async function scrapeShopify() {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson(`${BASE}/products.json?limit=250&page=${page}`);
    if (!data || !Array.isArray(data.products)) return page === 1 ? null : rows;
    if (data.products.length === 0) break;
    for (const p of data.products) {
      for (const v of p.variants || []) {
        rows.push({
          product: p.title,
          variant: v.title === 'Default Title' ? '' : v.title,
          sku: v.sku || '',
          price: v.price,
          compare_at_price: v.compare_at_price || '',
          available: v.available === undefined ? '' : String(v.available),
          url: `${BASE}/products/${p.handle}`,
        });
      }
    }
  }
  return rows;
}

// WooCommerce Store API: prices come back in minor units (cents).
async function scrapeWoo() {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson(`${BASE}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!Array.isArray(data)) return page === 1 ? null : rows;
    if (data.length === 0) break;
    for (const p of data) {
      const pr = p.prices || {};
      const minor = Number(pr.currency_minor_unit ?? 2);
      const fmt = v => (v === undefined || v === '' ? '' : (Number(v) / 10 ** minor).toFixed(minor));
      rows.push({
        product: p.name,
        variant: '',
        sku: p.sku || '',
        price: fmt(pr.price),
        compare_at_price: pr.regular_price !== pr.price ? fmt(pr.regular_price) : '',
        available: String(!!p.is_in_stock),
        url: p.permalink || '',
      });
    }
    if (data.length < 100) break;
  }
  return rows;
}

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  const rows = (await scrapeShopify()) ?? (await scrapeWoo());
  if (!rows) {
    console.error(`No Shopify or WooCommerce product feed found at ${BASE}`);
    for (const f of failures) console.error(`  ${f}`);
    if (failures.some(f => / (401|403)$/.test(f))) console.error('  403/401 means blocked (site firewall or network proxy), not a missing feed.');
    process.exit(1);
  }
  if (rows.length === 0) {
    console.error('Feed found but it returned zero products');
    process.exit(1);
  }
  const cols = ['product', 'variant', 'sku', 'price', 'compare_at_price', 'available', 'url'];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
  fs.writeFileSync(OUT, csv);
  console.log(`Wrote ${rows.length} rows to ${OUT}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
