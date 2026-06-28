/*
  WHAT THIS FILE IS:
  JavaScript is the "brain" of the page. It runs in your browser and does three things:

    1. FETCH  — downloads trade and committee data from free public sources
    2. MATCH  — connects each member's name to their committee assignments
    3. BUILD  — creates the trade cards and injects them into the page

  You don't need to understand every line right now. Read the comments
  as you go — they explain the "why", not just the "what".
*/

// ─────────────────────────────────────────────────────────────────────
// DATA SOURCE URLS
// All free, no API keys required.
// ─────────────────────────────────────────────────────────────────────

// Community-parsed trade disclosures (pull from official STOCK Act filings)
const HOUSE_API_URL  = 'https://housestockwatcher.com/api';
const SENATE_API_URL = 'https://senatestockwatcher.com/api';

// Official government legislator + committee data, hosted on GitHub (public domain)
const LEGISLATORS_URL = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.json';
const COMMITTEES_URL  = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committees-current.json';
const MEMBERSHIP_URL  = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.json';

// ─────────────────────────────────────────────────────────────────────
// APP STATE
// Variables that hold data while the page is open.
// ─────────────────────────────────────────────────────────────────────

let allTrades          = [];   // every trade fetched (House + Senate combined)
let visibleCount       = 50;   // how many cards are currently showing
const PAGE_SIZE        = 50;   // how many more to load each time "Load more" is clicked

// Lookup tables built from the legislators data:
let committeesByBioguide = {};  // bioguide ID  → [{committeeName, rank, title}]
let membersByName        = {};  // lowercase name → legislator object (for matching)

// ─────────────────────────────────────────────────────────────────────
// ENTRY POINT
// document.addEventListener('DOMContentLoaded', fn) means:
// "Wait until the page HTML is fully loaded, then run init()."
// ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setStatus('Loading trades and committee data…');

  // Kick off all five fetches at the same time (parallel = faster).
  // Promise.allSettled means: "try all five; don't crash if one fails."
  const [houseResult, senateResult, legislatorsResult, committeesResult, membershipResult] =
    await Promise.allSettled([
      fetchJSON(HOUSE_API_URL),
      fetchJSON(SENATE_API_URL),
      fetchJSON(LEGISLATORS_URL),
      fetchJSON(COMMITTEES_URL),
      fetchJSON(MEMBERSHIP_URL),
    ]);

  // ── Step 1: Build committee name lookup (thomas_id → display name) ──────
  const committeeNames = {};
  if (committeesResult.status === 'fulfilled') {
    for (const c of committeesResult.value) {
      committeeNames[c.thomas_id] = c.name;
    }
  }

  // ── Step 2: Build name → bioguide lookup from legislators data ───────────
  if (legislatorsResult.status === 'fulfilled') {
    for (const leg of legislatorsResult.value) {
      // "official_full" is the display name from congress.gov (most reliable)
      const fullName = (leg.name.official_full || `${leg.name.first} ${leg.name.last}`).toLowerCase();
      membersByName[fullName] = leg;

      // Also index by last name alone as a fallback for partial matches
      const lastName = leg.name.last.toLowerCase();
      if (!membersByName[lastName]) {
        membersByName[lastName] = leg;
      }
    }
  } else {
    showError('Could not load legislator data — committee context unavailable.');
  }

  // ── Step 3: Build bioguide → committees lookup ───────────────────────────
  if (membershipResult.status === 'fulfilled') {
    for (const [committeeId, members] of Object.entries(membershipResult.value)) {
      for (const m of members) {
        const bioguide = m.bioguide || m.bioguide_id;
        if (!bioguide) continue;
        if (!committeesByBioguide[bioguide]) {
          committeesByBioguide[bioguide] = [];
        }
        committeesByBioguide[bioguide].push({
          name:  committeeNames[committeeId] || committeeId,
          rank:  m.rank,
          title: m.title || null,
        });
      }
    }
  } else {
    showError('Could not load committee membership data — committee context unavailable.');
  }

  // ── Step 4: Normalize and combine House + Senate trades ──────────────────
  let trades = [];

  if (houseResult.status === 'fulfilled') {
    const raw = Array.isArray(houseResult.value.data) ? houseResult.value.data : [];
    trades = trades.concat(raw.map(normalizeHouseTrade));
  } else {
    showError('Could not load House trade data. The House Stock Watcher API may be temporarily unavailable.');
  }

  if (senateResult.status === 'fulfilled') {
    const raw = Array.isArray(senateResult.value.data) ? senateResult.value.data : [];
    trades = trades.concat(raw.map(normalizeSenateTrade));
  } else {
    showError('Could not load Senate trade data. The Senate Stock Watcher API may be temporarily unavailable.');
  }

  // Sort newest disclosure date first
  trades.sort((a, b) => parseDate(b.disclosureDate) - parseDate(a.disclosureDate));

  allTrades = trades;
  visibleCount = PAGE_SIZE;

  setStatus(`${trades.length.toLocaleString()} trades loaded — showing most recent first.`);
  renderVisible();
  wireFilters();
}

// ─────────────────────────────────────────────────────────────────────
// NORMALIZE FUNCTIONS
// The House and Senate APIs use slightly different field names.
// These functions convert both into the same standard shape.
// ─────────────────────────────────────────────────────────────────────

function normalizeHouseTrade(t) {
  return {
    chamber:         'House',
    memberName:      t.representative || 'Unknown',
    state:           t.state || '',
    district:        t.district || '',
    ticker:          (t.ticker || '').toUpperCase().trim(),
    assetDesc:       t.asset_description || '',
    tradeType:       classifyType(t.type || ''),
    rawType:         t.type || '',
    amount:          t.amount || '',
    disclosureDate:  t.disclosure_date || '',
    transactionDate: t.transaction_date || '',
    ptrLink:         t.ptr_link || '',
  };
}

function normalizeSenateTrade(t) {
  return {
    chamber:         'Senate',
    memberName:      t.senator || 'Unknown',
    state:           t.state || '',
    district:        '',
    ticker:          (t.ticker || '').toUpperCase().trim(),
    assetDesc:       t.asset_description || '',
    tradeType:       classifyType(t.type || ''),
    rawType:         t.type || '',
    amount:          t.amount || '',
    disclosureDate:  t.disclosure_date || '',
    transactionDate: t.transaction_date || '',
    ptrLink:         t.ptr_link || '',
  };
}

// Map raw type strings to one of: 'buy' | 'sell' | 'exchange' | 'other'
function classifyType(raw) {
  const s = raw.toLowerCase();
  if (s.includes('purchase') || s === 'buy')  return 'buy';
  if (s.includes('sale') || s === 'sell')      return 'sell';
  if (s.includes('exchange'))                  return 'exchange';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────
// COMMITTEE LOOKUP
// Given a member's display name, find their bioguide ID (a unique
// government ID for each member), then look up their committees.
// ─────────────────────────────────────────────────────────────────────

function getCommitteesForMember(memberName) {
  const nameLower = memberName.toLowerCase().trim();

  // Try exact full name first, then last name only
  const leg = membersByName[nameLower]
           || membersByName[nameLower.split(' ').at(-1)];

  if (!leg) return [];

  const bioguide = leg.id && leg.id.bioguide;
  if (!bioguide) return [];

  return committeesByBioguide[bioguide] || [];
}

// ─────────────────────────────────────────────────────────────────────
// FILTERING
// Reads the current search box and dropdown values and re-renders.
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
    if (chamber !== 'all' && t.chamber !== chamber) return false;
    if (typeVal  !== 'all' && t.tradeType !== typeVal) return false;
    if (query) {
      const haystack = `${t.memberName} ${t.ticker} ${t.state} ${t.assetDesc}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function applyFilters() {
  visibleCount = PAGE_SIZE; // reset to first page on new filter
  renderVisible();
}

function loadMore() {
  visibleCount += PAGE_SIZE;
  renderVisible();
}

// ─────────────────────────────────────────────────────────────────────
// RENDER
// Takes the filtered+sliced list of trades and builds the HTML cards.
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

  // Build all cards using a DocumentFragment (faster than appending one by one)
  const frag = document.createDocumentFragment();
  for (const trade of slice) {
    frag.appendChild(buildCard(trade));
  }
  container.appendChild(frag);

  // Show or hide the "Load more" button
  const loadMoreWrap = document.getElementById('load-more-wrap');
  loadMoreWrap.style.display = (visibleCount < filtered.length) ? 'block' : 'none';
}

// ─────────────────────────────────────────────────────────────────────
// CARD BUILDER
// Creates one trade card as a DOM element (an HTML node in memory).
// ─────────────────────────────────────────────────────────────────────

function buildCard(trade) {
  const committees = getCommitteesForMember(trade.memberName);

  // Badge appearance varies by trade type
  const badgeClass = {
    buy:      'badge-buy',
    sell:     'badge-sell',
    exchange: 'badge-exchange',
  }[trade.tradeType] || 'badge-other';

  const badgeLabel = {
    buy:      'Purchase',
    sell:     'Sale',
    exchange: 'Exchange',
  }[trade.tradeType] || trade.rawType || 'Other';

  // Build location string: "TX" or "CA-12"
  const location = trade.district
    ? `${trade.state}-${trade.district.replace(/^[A-Z]+-/, '')}`
    : trade.state;

  const discDate = formatDate(trade.disclosureDate);
  const txDate   = formatDate(trade.transactionDate);

  // Create the card element
  const card = document.createElement('div');
  card.className = 'trade-card';

  // innerHTML sets the card's internal HTML.
  // escHtml() is called on every piece of external data to prevent XSS
  // (a security issue where malicious text in the data could run code).
  card.innerHTML = `
    <div class="card-header">
      <span class="badge ${badgeClass}">${badgeLabel}</span>
      <span class="ticker">${escHtml(trade.ticker || 'N/A')}</span>
      <span class="member-name">${escHtml(trade.memberName)}</span>
      ${location ? `<span class="member-meta">${escHtml(location)}</span>` : ''}
      <span class="chamber-tag">${escHtml(trade.chamber)}</span>
    </div>

    <div class="card-details">
      ${trade.amount          ? `<span data-label="Amount">${escHtml(trade.amount)}</span>` : ''}
      ${discDate              ? `<span data-label="Disclosed">${escHtml(discDate)}</span>` : ''}
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

  // Wire up the expand/collapse button
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
// CONTEXT PANEL HTML
// The expandable section showing committee context + source link.
// ─────────────────────────────────────────────────────────────────────

function buildContextHTML(trade, committees) {
  let html = '';

  // Committee assignments section
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
    html += '<p style="color:#94a3b8; font-size:0.8rem; margin:0">'
          + 'No current committee assignments found, or member not in current Congress.'
          + '</p>';
  }
  html += '</div>';

  // Original disclosure source link
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
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

// Fetch a URL and parse its JSON response.
// Throws an error if the network request fails.
async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

// Update the status line text
function setStatus(msg) {
  document.getElementById('status-message').textContent = msg;
}

// Insert a yellow warning box above the trade list
function showError(msg) {
  const container = document.getElementById('trades-container');
  const div = document.createElement('div');
  div.className = 'error-notice';
  div.textContent = '⚠ ' + msg;
  container.before(div);
}

// Convert date strings to "Jun 15, 2025" format for display.
// Returns raw string if it can't be parsed.
function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Helper to make date comparison work reliably across date string formats
function parseDate(raw) {
  if (!raw) return 0;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// SECURITY: Escape HTML special characters in text that comes from external data.
// This prevents malicious content in the API data from running as code in the browser.
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same as escHtml but safe to use inside HTML attribute values (href=)
function escAttr(str) {
  if (!str) return '';
  // Only allow http/https URLs (block javascript: etc.)
  const s = String(str).trim();
  if (!/^https?:\/\//i.test(s)) return '#';
  return escHtml(s);
}
