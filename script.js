/*
  WHAT THIS FILE IS:
  JavaScript is the "brain" of the page. When the page loads it:
    1. FETCH  — downloads trade and committee data from free public sources
    2. MATCH  — links each trade's member ID directly to their committee assignments
    3. BUILD  — creates the trade cards and injects them into the page

  Data sources used:
    - Trade data: Financial Modeling Prep (FMP) free API — financialmodelingprep.com
    - Committee data: unitedstates/congress-legislators — unitedstates.github.io

  FMP_API_KEY is loaded from config.js (that file is gitignored — never goes to GitHub).
*/

// ─────────────────────────────────────────────────────────────────────
// DATA SOURCE URLS
// ─────────────────────────────────────────────────────────────────────

// FMP_API_KEY comes from config.js, which loads before this file in index.html
const SENATE_API_URL = `https://financialmodelingprep.com/stable/senate-latest?apikey=${FMP_API_KEY}`;
const HOUSE_API_URL  = `https://financialmodelingprep.com/stable/house-latest?apikey=${FMP_API_KEY}`;

// Committee data — official public domain JSON files (no API key needed)
const COMMITTEES_URL = 'https://unitedstates.github.io/congress-legislators/committees-current.json';
const MEMBERSHIP_URL = 'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';

// ─────────────────────────────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────────────────────────────

let allTrades            = [];   // every trade fetched (House + Senate combined)
let visibleCount         = 50;   // how many cards are currently showing
const PAGE_SIZE          = 50;

// committeesByBioguide: maps a member's unique government ID → their committee list
// FMP's "senateID" field IS the bioguide ID (used for both chambers despite the name)
let committeesByBioguide = {};   // bioguide → [{name, rank, title}]

// ─────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Safety check: if config.js didn't load, FMP_API_KEY will be undefined
  if (typeof FMP_API_KEY === 'undefined' || FMP_API_KEY === 'YOUR_KEY_HERE') {
    showError('No API key found. Copy config.example.js to config.js and add your free FMP key.');
    setStatus('Setup required — see error above.');
    return;
  }

  setStatus('Loading trades and committee data…');

  const [senateResult, houseResult, committeesResult, membershipResult] =
    await Promise.allSettled([
      fetchJSON(SENATE_API_URL),
      fetchJSON(HOUSE_API_URL),
      fetchJSON(COMMITTEES_URL),
      fetchJSON(MEMBERSHIP_URL),
    ]);

  // ── Build committee name lookup: thomas_id → display name ───────────
  const committeeNames = {};
  if (committeesResult.status === 'fulfilled') {
    for (const c of committeesResult.value) {
      committeeNames[c.thomas_id] = c.name;
    }
  } else {
    showError('Could not load committee names. Committee context will be unavailable.');
  }

  // ── Build bioguide → committees lookup ───────────────────────────────
  // FMP includes each member's bioguide ID directly in the trade record ("senateID" field),
  // so we can look up committees without any fuzzy name matching.
  if (membershipResult.status === 'fulfilled') {
    for (const [committeeId, members] of Object.entries(membershipResult.value)) {
      for (const m of members) {
        const bioguide = m.bioguide;
        if (!bioguide) continue;
        if (!committeesByBioguide[bioguide]) committeesByBioguide[bioguide] = [];
        committeesByBioguide[bioguide].push({
          name:  committeeNames[committeeId] || committeeId,
          rank:  m.rank,
          title: m.title || null,
        });
      }
    }
  } else {
    showError('Could not load committee membership data. Committee context will be unavailable.');
  }

  // ── Normalize and combine trades ─────────────────────────────────────
  let trades = [];

  if (senateResult.status === 'fulfilled') {
    const raw = Array.isArray(senateResult.value) ? senateResult.value : [];
    trades = trades.concat(raw.map(t => normalizeTrade(t, 'Senate')));
  } else {
    showError('Could not load Senate trade data. FMP API may be temporarily unavailable.');
  }

  if (houseResult.status === 'fulfilled') {
    const raw = Array.isArray(houseResult.value) ? houseResult.value : [];
    trades = trades.concat(raw.map(t => normalizeTrade(t, 'House')));
  } else {
    showError('Could not load House trade data. FMP API may be temporarily unavailable.');
  }

  // Sort newest disclosure date first
  trades.sort((a, b) => parseDate(b.disclosureDate) - parseDate(a.disclosureDate));

  allTrades    = trades;
  visibleCount = PAGE_SIZE;

  setStatus(`${trades.length.toLocaleString()} trades loaded — showing most recent first.`);
  renderVisible();
  wireFilters();
}

// ─────────────────────────────────────────────────────────────────────
// NORMALIZE
// FMP uses the same field names for both chambers (despite calling the
// member ID "senateID" even on House records).
// ─────────────────────────────────────────────────────────────────────

function normalizeTrade(t, chamber) {
  // district field: Senate = "KS" (state only), House = "PA03" (state + number)
  const districtStr = t.district || '';
  const isStateOnly = districtStr.length <= 2;
  const state           = districtStr.slice(0, 2);
  const districtDisplay = isStateOnly ? state : `${state}-${districtStr.slice(2).replace(/^0+/, '') || districtStr.slice(2)}`;

  return {
    chamber,
    memberName:      t.office || `${t.firstName || ''} ${t.lastName || ''}`.trim(),
    bioguide:        t.senateID || '',   // FMP's "senateID" = bioguide ID for both chambers
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

// Map "Purchase" / "Sale" / "Sale (Full)" etc. → 'buy' | 'sell' | 'exchange' | 'other'
function classifyType(raw) {
  const s = raw.toLowerCase();
  if (s.includes('purchase') || s === 'buy')  return 'buy';
  if (s.includes('sale') || s === 'sell')      return 'sell';
  if (s.includes('exchange'))                  return 'exchange';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────
// COMMITTEE LOOKUP
// Direct O(1) lookup using the bioguide ID from FMP — no name matching needed.
// ─────────────────────────────────────────────────────────────────────

function getCommitteesForMember(bioguide) {
  if (!bioguide) return [];
  return committeesByBioguide[bioguide] || [];
}

// ─────────────────────────────────────────────────────────────────────
// FILTERING
// ─────────────────────────────────────────────────────────────────────

function wireFilters() {
  document.getElementById('search-input').addEventListener('input', applyFilters);
  document.getElementById('chamber-filter').addEventListener('change', applyFilters);
  document.getElementById('type-filter').addEventListener('change', applyFilters);
  document.getElementById('load-more-btn').addEventListener('click', loadMore);
}

function getFilteredTrades() {
  const query   = document.getElementById('search-input').value.toLowerCase().trim();
  const chamber = document.getElementById('chamber-filter').value;
  const typeVal = document.getElementById('type-filter').value;

  return allTrades.filter(t => {
    if (chamber !== 'all' && t.chamber !== chamber)    return false;
    if (typeVal  !== 'all' && t.tradeType !== typeVal) return false;
    if (query) {
      const haystack = `${t.memberName} ${t.ticker} ${t.state} ${t.assetDesc}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function applyFilters() {
  visibleCount = PAGE_SIZE;
  renderVisible();
}

function loadMore() {
  visibleCount += PAGE_SIZE;
  renderVisible();
}

// ─────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────

function renderVisible() {
  const filtered = getFilteredTrades();
  const slice    = filtered.slice(0, visibleCount);
  const container = document.getElementById('trades-container');
  container.innerHTML = '';

  setStatus(
    filtered.length === allTrades.length
      ? `${allTrades.length.toLocaleString()} trades — showing ${slice.length.toLocaleString()}`
      : `${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} matching trades`
  );

  if (filtered.length === 0) {
    container.innerHTML = '<p class="no-results">No trades match your search.</p>';
    document.getElementById('load-more-wrap').style.display = 'none';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const trade of slice) {
    frag.appendChild(buildCard(trade));
  }
  container.appendChild(frag);

  const loadMoreWrap = document.getElementById('load-more-wrap');
  loadMoreWrap.style.display = (visibleCount < filtered.length) ? 'block' : 'none';
}

// ─────────────────────────────────────────────────────────────────────
// CARD BUILDER
// ─────────────────────────────────────────────────────────────────────

function buildCard(trade) {
  const committees = getCommitteesForMember(trade.bioguide);

  const badgeClass = { buy: 'badge-buy', sell: 'badge-sell', exchange: 'badge-exchange' }[trade.tradeType] || 'badge-other';
  const badgeLabel = { buy: 'Purchase', sell: 'Sale', exchange: 'Exchange' }[trade.tradeType] || trade.rawType || 'Other';

  const location   = trade.districtDisplay || trade.state;
  const discDate   = formatDate(trade.disclosureDate);
  const txDate     = formatDate(trade.transactionDate);

  const card = document.createElement('div');
  card.className = 'trade-card';

  card.innerHTML = `
    <div class="card-header">
      <span class="badge ${badgeClass}">${badgeLabel}</span>
      <span class="ticker">${escHtml(trade.ticker || 'N/A')}</span>
      <span class="member-name">${escHtml(trade.memberName)}</span>
      ${location ? `<span class="member-meta">${escHtml(location)}</span>` : ''}
      <span class="chamber-tag">${escHtml(trade.chamber)}</span>
    </div>

    <div class="card-details">
      ${trade.amount          ? `<span data-label="Amount">${escHtml(trade.amount)}</span>`    : ''}
      ${discDate              ? `<span data-label="Disclosed">${escHtml(discDate)}</span>`     : ''}
      ${txDate && txDate !== discDate ? `<span data-label="Trade date">${escHtml(txDate)}</span>` : ''}
    </div>

    ${trade.assetDesc ? `<div class="asset-desc">${escHtml(trade.assetDesc)}</div>` : ''}

    <button class="context-toggle" aria-expanded="false">
      <span class="toggle-arrow">▼</span>
      Context &amp; source
    </button>

    <div class="context-panel">
      ${buildContextHTML(trade, committees)}
    </div>
  `;

  const btn   = card.querySelector('.context-toggle');
  const panel = card.querySelector('.context-panel');
  btn.addEventListener('click', () => {
    const nowOpen = panel.classList.toggle('visible');
    btn.classList.toggle('open', nowOpen);
    btn.setAttribute('aria-expanded', String(nowOpen));
  });

  return card;
}

// ─────────────────────────────────────────────────────────────────────
// CONTEXT PANEL
// ─────────────────────────────────────────────────────────────────────

function buildContextHTML(trade, committees) {
  let html = '';

  // Committee assignments
  html += '<div class="context-section">';
  html += '<div class="context-label">Committee assignments</div>';
  if (committees.length > 0) {
    html += '<ul class="committee-list">';
    for (const c of committees) {
      const titlePart = c.title ? ` <em style="color:#94a3b8">(${escHtml(c.title)})</em>` : '';
      html += `<li>${escHtml(c.name)}${titlePart}</li>`;
    }
    html += '</ul>';
  } else {
    html += '<p style="color:#94a3b8;font-size:0.8rem;margin:0">No current committee assignments found.</p>';
  }
  html += '</div>';

  // Source link
  if (trade.ptrLink) {
    html += '<div class="context-section">';
    html += '<div class="context-label">Original disclosure</div>';
    html += `<a class="source-link" href="${escAttr(trade.ptrLink)}" target="_blank" rel="noopener noreferrer">`;
    html += 'View official STOCK Act filing ↗';
    html += '</a>';
    html += '</div>';
  }

  return html;
}

// ─────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setStatus(msg) {
  document.getElementById('status-message').textContent = msg;
}

function showError(msg) {
  const notice = document.createElement('div');
  notice.className = 'error-notice';
  notice.textContent = '⚠ ' + msg;
  document.getElementById('trades-container').before(notice);
}

function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseDate(raw) {
  if (!raw) return 0;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// Escape HTML to prevent XSS from external API data
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Escape attribute values — also blocks javascript: URLs
function escAttr(str) {
  if (!str) return '';
  const s = String(str).trim();
  if (!/^https?:\/\//i.test(s)) return '#';
  return escHtml(s);
}
