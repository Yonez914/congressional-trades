/*
  WHAT THIS FILE IS:
  JavaScript is the "brain" of the page. When the page loads it:
    1. FETCH  — loads the trade cache and committee data
    2. MATCH  — links each trade's member ID directly to their committee assignments
    3. BUILD  — creates the trade cards and injects them into the page

  Data sources:
    - Trade data: data/trades-cache.json — updated daily by GitHub Actions via FMP
    - Committee data: unitedstates/congress-legislators — unitedstates.github.io

  No API key is needed in the browser. The cache file is pre-built and served statically.
*/

// ─────────────────────────────────────────────────────────────────────
// DATA SOURCE URLS
// ─────────────────────────────────────────────────────────────────────

// Trade cache — built by scripts/update-cache.mjs, served as a static file
const CACHE_URL = 'data/trades-cache.json';

// Committee data — official public domain JSON files (no API key needed)
const COMMITTEES_URL  = 'https://unitedstates.github.io/congress-legislators/committees-current.json';
const MEMBERSHIP_URL  = 'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';
const LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';

// ─────────────────────────────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────────────────────────────

let allTrades            = [];   // every trade fetched (House + Senate combined)
let visibleCount         = 50;   // how many cards are currently showing
const PAGE_SIZE          = 50;

// committeesByBioguide: maps a member's unique government ID → their committee list
// FMP's "senateID" field IS the bioguide ID (used for both chambers despite the name)
let committeesByBioguide = {};   // bioguide → [{name, description, rank, title}]
let bioguideByNameState  = {};   // `${lastName}_${state}` → bioguide (fallback when FMP omits bioguide)

// ─────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setStatus('Loading trades and committee data…');

  const [cacheResult, committeesResult, membershipResult, legislatorsResult] =
    await Promise.allSettled([
      fetchJSON(CACHE_URL),
      fetchJSON(COMMITTEES_URL),
      fetchJSON(MEMBERSHIP_URL),
      fetchJSON(LEGISLATORS_URL),
    ]);

  // ── Build committee name + jurisdiction lookup: thomas_id → display name / description ──
  const committeeNames        = {};
  const committeeJurisdiction = {};
  if (committeesResult.status === 'fulfilled') {
    for (const c of committeesResult.value) {
      committeeNames[c.thomas_id] = c.name;
      if (c.jurisdiction) committeeJurisdiction[c.thomas_id] = c.jurisdiction;
      // Index subcommittees — their IDs appear in membership data but not at top level
      for (const sub of (c.subcommittees || [])) {
        if (sub.thomas_id) {
          // Membership JSON uses concatenated key: parent thomas_id + sub thomas_id (e.g. "SSAF" + "13" = "SSAF13")
          const subKey = c.thomas_id + sub.thomas_id;
          committeeNames[subKey] = `${c.name} — ${sub.name}`;
          if (c.jurisdiction) committeeJurisdiction[subKey] = c.jurisdiction;
        }
      }
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
          name:        committeeNames[committeeId] || committeeId,
          description: committeeJurisdiction[committeeId] || null,
          rank:        m.rank,
          title:       m.title || null,
        });
      }
    }
  } else {
    showError('Could not load committee membership data. Committee context will be unavailable.');
  }

  // ── Build lastName+state → bioguide fallback map ─────────────────────
  // Used when FMP omits the bioguide ID (common for House records).
  // Key is lastName+state so "Bill Cassidy" and "William Cassidy" both match.
  if (legislatorsResult.status === 'fulfilled') {
    for (const leg of legislatorsResult.value) {
      const bioguide = leg.id?.bioguide;
      if (!bioguide) continue;
      const last  = (leg.name?.last || '').toLowerCase().replace(/[^a-z]/g, '');
      const terms = leg.terms || [];
      const state = (terms[terms.length - 1]?.state || '').toUpperCase();
      if (!last || !state) continue;
      bioguideByNameState[`${last}_${state}`] = bioguide;
    }
  }

  // ── Load trades from cache ────────────────────────────────────────────
  let trades = [];
  let updatedStr = '';

  if (cacheResult.status === 'fulfilled') {
    const cache = cacheResult.value;
    trades = Array.isArray(cache.trades) ? cache.trades : [];
    if (cache.lastUpdated) {
      const d = new Date(cache.lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      updatedStr = ` — cache updated ${d}`;
    }
  } else {
    showError('Could not load trade cache. If running locally, use a local server (e.g. npx serve .)');
  }

  allTrades    = trades;
  visibleCount = PAGE_SIZE;

  setStatus(`${trades.length.toLocaleString()} trades loaded${updatedStr}`);
  renderVisible();
  wireFilters();
}


// ─────────────────────────────────────────────────────────────────────
// COMMITTEE LOOKUP
// Primary: O(1) bioguide lookup from FMP's senateID field.
// Fallback: lastName+state → bioguide map for records where FMP omits bioguide.
// ─────────────────────────────────────────────────────────────────────

function getCommitteesForMember(bioguide, memberName, state) {
  if (bioguide && committeesByBioguide[bioguide]?.length) {
    return committeesByBioguide[bioguide];
  }
  if (memberName && state) {
    const words   = memberName.trim().split(/\s+/);
    const rawLast = words[words.length - 1];
    const last    = rawLast.toLowerCase().replace(/[^a-z]/g, '');
    const key     = `${last}_${state.toUpperCase()}`;
    const derived = bioguideByNameState[key];
    if (derived && committeesByBioguide[derived]?.length) {
      console.log(`[committees] fallback matched: "${memberName}" ${state} → ${derived}`);
      return committeesByBioguide[derived];
    }
  }
  return [];
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
  const committees = getCommitteesForMember(trade.bioguide, trade.memberName, trade.state);

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
      const descPart  = c.description
        ? `<div class="committee-desc">${escHtml(c.description)}</div>`
        : '';
      html += `<li>${escHtml(c.name)}${titlePart}${descPart}</li>`;
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
