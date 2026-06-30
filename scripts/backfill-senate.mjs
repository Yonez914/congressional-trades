// scripts/backfill-senate.mjs
// ONE-TIME backfill: loads all Senate trade history from Senate Stock Watcher
// and merges it into data/trades-cache.json.
//
// Run once:  node scripts/backfill-senate.mjs
// No API key needed. Safe to re-run — dedup prevents double-adding.

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'trades-cache.json');

const SSW_URL         = 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json';
const LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').trim();
}

// Convert MM/DD/YYYY → YYYY-MM-DD. Returns '' on failure.
function convertDate(mmddyyyy) {
  if (!mmddyyyy) return '';
  const parts = mmddyyyy.split('/');
  if (parts.length !== 3) return '';
  const [mm, dd, yyyy] = parts;
  if (!mm || !dd || !yyyy || yyyy.length !== 4) return '';
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function classifyType(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('purchase') || s === 'buy') return 'buy';
  if (s.includes('sale')     || s === 'sell') return 'sell';
  if (s.includes('exchange'))                 return 'exchange';
  return 'other';
}

function tradeKey(t) {
  const member = t.bioguide || t.memberName;
  return `${member}|${t.ticker}|${t.transactionDate}|${t.rawType}|${t.amount}`;
}

// ── Name → bioguide lookup ────────────────────────────────────────────────────

function buildNameLookup(legislators) {
  const lookup = new Map();
  for (const leg of legislators) {
    const bioguide = leg.id?.bioguide;
    if (!bioguide) continue;
    const first    = (leg.name?.first         || '').toLowerCase().trim();
    const last     = (leg.name?.last          || '').toLowerCase().trim();
    const official = (leg.name?.official_full || '').toLowerCase().trim();
    if (official)         lookup.set(official,          bioguide);
    if (first && last)    lookup.set(`${first} ${last}`, bioguide);
  }
  return lookup;
}

// SSW uses formats like "Ron L Wyden" or "Elizabeth Warren".
// Try several matching strategies in order of specificity.
function resolveBioguide(senatorName, lookup) {
  if (!senatorName) return '';
  const lower = senatorName.toLowerCase().trim();

  // 1. Exact match against official_full or "first last"
  if (lookup.has(lower)) return lookup.get(lower);

  // 2. Drop middle name/initial: "ron l wyden" → "ron wyden"
  const words = lower.split(/\s+/);
  if (words.length >= 3) {
    const firstLast = `${words[0]} ${words[words.length - 1]}`;
    if (lookup.has(firstLast)) return lookup.get(firstLast);
  }

  return '';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Fetch SSW data + legislators in parallel
  console.log('Fetching Senate Stock Watcher data and legislators…');
  const [sswRes, legRes] = await Promise.allSettled([
    fetch(SSW_URL).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} from SSW`);
      return r.json();
    }),
    fetch(LEGISLATORS_URL).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} from legislators`);
      return r.json();
    }),
  ]);

  if (sswRes.status === 'rejected') {
    console.error('Failed to fetch Senate Stock Watcher data:', sswRes.reason.message);
    process.exit(1);
  }
  if (legRes.status === 'rejected') {
    console.warn('Could not fetch legislators — bioguide lookup disabled. Dedup may be slightly less accurate.');
  }

  const sswTrades  = sswRes.value;
  const nameLookup = legRes.status === 'fulfilled' ? buildNameLookup(legRes.value) : new Map();

  console.log(`Senate Stock Watcher: ${sswTrades.length} raw records`);
  if (nameLookup.size > 0) console.log(`Name lookup: ${nameLookup.size} entries`);

  // 2. Load existing cache
  let cache = { lastUpdated: null, tradeCount: 0, trades: [] };
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    } catch (e) {
      console.warn('Could not parse existing cache — starting fresh:', e.message);
    }
  }

  const existingKeys = new Set(cache.trades.map(tradeKey));
  console.log(`\nExisting cache: ${cache.trades.length} trades`);

  // 3. Normalize + merge
  let added        = 0;
  let skippedBlank = 0;

  for (const t of sswTrades) {
    // Skip records with no real ticker (non-stock assets show "--")
    const rawTicker = (t.ticker || '').trim();
    if (!rawTicker || rawTicker === '--') {
      skippedBlank++;
      continue;
    }

    const bioguide        = resolveBioguide(t.senator, nameLookup);
    const memberName      = t.senator || '';
    const ticker          = rawTicker.toUpperCase();
    const rawType         = t.type || '';
    const transactionDate = convertDate(t.transaction_date);
    const amount          = t.amount || '';

    const normalized = {
      chamber:         'Senate',
      memberName,
      bioguide,
      state:           '',
      districtDisplay: '',
      ticker,
      assetDesc:       stripHtml(t.asset_description),
      tradeType:       classifyType(rawType),
      rawType,
      amount,
      disclosureDate:  '',
      transactionDate,
      ptrLink:         t.ptr_link || '',
    };

    const key = tradeKey(normalized);
    if (!existingKeys.has(key)) {
      cache.trades.push(normalized);
      existingKeys.add(key);
      added++;
    }
  }

  console.log('\nResults:');
  console.log(`  Raw SSW records:                 ${sswTrades.length}`);
  console.log(`  Skipped (no ticker):             ${skippedBlank}`);
  console.log(`  Already in cache (deduped):      ${sswTrades.length - skippedBlank - added}`);
  console.log(`  New trades added:                ${added}`);
  console.log(`  Cache total:                     ${cache.trades.length}`);

  if (added === 0) {
    console.log('\nNothing new — cache unchanged.');
    return;
  }

  // 4. Sort: disclosureDate first, fall back to transactionDate for SSW records
  cache.trades.sort((a, b) => {
    const da = new Date(a.disclosureDate || a.transactionDate || '2000-01-01').getTime();
    const db = new Date(b.disclosureDate || b.transactionDate || '2000-01-01').getTime();
    return db - da;
  });

  cache.lastUpdated = new Date().toISOString();
  cache.tradeCount  = cache.trades.length;

  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`\nWrote ${CACHE_PATH}`);
  console.log(`  lastUpdated: ${cache.lastUpdated}`);
  console.log(`  tradeCount:  ${cache.tradeCount}`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
