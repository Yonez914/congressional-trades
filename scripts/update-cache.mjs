// scripts/update-cache.mjs
// Fetches the latest congressional trades from FMP and accumulates them in data/trades-cache.json.
// FMP free tier only exposes "senate-latest" and "house-latest" (no date range, no pagination).
// Running this daily grows the cache over time by deduplicating and keeping every new trade seen.
//
// Local run (PowerShell):
//   node scripts/update-cache.mjs        (reads key from config.js automatically)
//
// GitHub Actions injects FMP_API_KEY automatically from the repo Secret.

import { readFile, writeFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'trades-cache.json');

// ── Config ────────────────────────────────────────────────────────────────────

// Prefer env var (used by GitHub Actions). Fall back to config.js for local dev.
if (!process.env.FMP_API_KEY) {
  const configPath = path.join(ROOT, 'config.js');
  if (existsSync(configPath)) {
    const src   = await readFile(configPath, 'utf8');
    const match = src.match(/FMP_API_KEY\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[1] !== 'YOUR_KEY_HERE') {
      process.env.FMP_API_KEY = match[1];
      console.log('Using FMP_API_KEY from config.js');
    }
  }
}

const API_KEY  = process.env.FMP_API_KEY;
const BASE_URL = 'https://financialmodelingprep.com/stable';

if (!API_KEY || API_KEY === 'YOUR_KEY_HERE') {
  console.error('ERROR: FMP_API_KEY not set.');
  console.error('Add your key to config.js, or: $env:FMP_API_KEY="your_key"; node scripts/update-cache.mjs');
  process.exit(1);
}


// ── Normalization (mirrors normalizeTrade in script.js — keep in sync) ────────

function classifyType(raw) {
  const s = raw.toLowerCase();
  if (s.includes('purchase') || s === 'buy') return 'buy';
  if (s.includes('sale')     || s === 'sell') return 'sell';
  if (s.includes('exchange'))                 return 'exchange';
  return 'other';
}

function normalizeTrade(t, chamber) {
  const districtStr     = t.district || '';
  const isStateOnly     = districtStr.length <= 2;
  const state           = districtStr.slice(0, 2);
  const districtDisplay = isStateOnly
    ? state
    : `${state}-${districtStr.slice(2).replace(/^0+/, '') || districtStr.slice(2)}`;

  return {
    chamber,
    memberName:      t.office || `${t.firstName || ''} ${t.lastName || ''}`.trim(),
    bioguide:        t.senateID || '',
    state,
    districtDisplay: isStateOnly ? '' : districtDisplay,
    ticker:          (t.symbol || '').toUpperCase().trim(),
    assetDesc:       t.assetDescription || '',
    tradeType:       classifyType(t.type || ''),
    rawType:         t.type || '',
    amount:          t.amount || '',
    disclosureDate:  t.disclosureDate || '',
    transactionDate: t.transactionDate || '',
    ptrLink:         t.link || '',
  };
}

// ── Dedup key ─────────────────────────────────────────────────────────────────
// Composite key — no single FMP field is guaranteed unique per trade.
// Uses rawType (exact FMP string) not tradeType (our classification bucket).
// Uses bioguide when present; falls back to memberName for House records that omit it.
function tradeKey(t) {
  const member = t.bioguide || t.memberName;
  return `${member}|${t.ticker}|${t.transactionDate}|${t.rawType}|${t.amount}`;
}

// ── FMP fetch ─────────────────────────────────────────────────────────────────
// Free tier only exposes -latest endpoints (no date range, no pagination).

async function fetchLatest(endpoint, chamber) {
  const url  = `${BASE_URL}/${endpoint}?apikey=${API_KEY}`;
  const res  = await fetch(url);
  if (!res.ok) {
    console.warn(`  HTTP ${res.status} on ${endpoint} — skipping`);
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    const msg = data?.['Error Message'] || JSON.stringify(data).slice(0, 120);
    console.warn(`  Non-array response for ${endpoint}: ${msg}`);
    return [];
  }
  return data.map(raw => normalizeTrade(raw, chamber));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load existing cache
  let cache = { lastUpdated: null, tradeCount: 0, trades: [] };
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    } catch (e) {
      console.warn('Could not parse existing cache — starting fresh.', e.message);
    }
  }

  const existingKeys = new Set(cache.trades.map(tradeKey));
  console.log(`Cache loaded: ${cache.trades.length} existing trades.\n`);

  // 2. Fetch both chambers (free tier: latest ~200 trades each, no date filtering)
  console.log('Fetching Senate latest…');
  const senateTrades = await fetchLatest('senate-latest', 'Senate');
  console.log(`  ${senateTrades.length} records`);

  console.log('Fetching House latest…');
  const houseTrades = await fetchLatest('house-latest', 'House');
  console.log(`  ${houseTrades.length} records`);

  const incoming = [...senateTrades, ...houseTrades];
  console.log(`\nFetched: ${senateTrades.length} Senate + ${houseTrades.length} House = ${incoming.length} total`);

  // 4. Merge + deduplicate
  let added = 0;
  for (const trade of incoming) {
    const key = tradeKey(trade);
    if (!existingKeys.has(key)) {
      cache.trades.push(trade);
      existingKeys.add(key);
      added++;
    }
  }
  console.log(`New: ${added}  |  Duplicates skipped: ${incoming.length - added}  |  Cache total: ${cache.trades.length}`);

  if (added === 0) {
    console.log('Nothing new — cache file not rewritten.');
    return;
  }

  // 5. Sort newest disclosure date first
  // Fall back to transactionDate so SSW backfill records (no disclosureDate) sort correctly.
  cache.trades.sort((a, b) => {
    const da = new Date(a.disclosureDate || a.transactionDate || '2000-01-01').getTime();
    const db = new Date(b.disclosureDate || b.transactionDate || '2000-01-01').getTime();
    return db - da;
  });

  // 6. Write
  cache.lastUpdated = new Date().toISOString();
  cache.tradeCount  = cache.trades.length;

  if (!existsSync(path.join(ROOT, 'data'))) mkdirSync(path.join(ROOT, 'data'));
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');

  console.log(`\nWrote ${CACHE_PATH}`);
  console.log(`  lastUpdated: ${cache.lastUpdated}`);
  console.log(`  tradeCount:  ${cache.tradeCount}`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
