// ============================================================
// IndiaMart BuyLead Auto-Picker — content.js (FINAL)
// Page: seller.indiamart.com/messagecentre/buyleads/
// ============================================================
// TIMING PHILOSOPHY:
//   Your code owns ~5ms of the cycle. The rest is IndiaMart's
//   feed refresh (200–600ms). Every design decision here
//   optimises for firing the click signal first, not confirming
//   it arrived. Fire-and-trust beats wait-and-verify in a race.
// ============================================================

// ── State ────────────────────────────────────────────────
let keywords        = [];
let isEnabled       = false;
let leadLimit       = 0;
let pickedCount     = 0;
let compiledKeywords = [];

let scanInterval    = null;
let lastTopCardId   = null;   // fingerprint of card currently being handled
let isProcessingCard = false; // tracks active async process for current top card
let settingsReady   = false;
let settingsLoadSeq = 0;      // stale-callback guard for overlapping loadSettings calls
let lastHandledUrl  = location.href;
let scannerState    = 'IDLE'; // IDLE | SHIMMER_BLOCKED | READY | PROCESSING
let lastShimmerSeenAt = 0;
let activeProcess   = null;   // { token, fingerprint, cancelled }
let processSeq      = 0;
let scanTickCount   = 0;
let lastHeartbeatAt = 0;
let shimmerWasVisible = false;
let settleWaitLogged = false;
let shimmerBlockStartedAt = 0;
let shimmerBlockConsecutive = 0;
let ignoreShimmerUntil = 0;
let lastSameTopLeadLogAt = 0;
const recentlyClickedLeads = new Map(); // key -> timestamp(ms)
let lastClickAt = 0;

// ── Constants ────────────────────────────────────────────
const CONTACT_BUYER_RX = /contact\s*buyer/i;
const POLL_MS          = 100; // how often the scanner tick runs
const SHIMMER_SETTLE_MS = 200;
const SHIMMER_MAX_BLOCK_MS = 4000;
const SHIMMER_FORCE_RESUME_STREAK = 25;
const SHIMMER_BYPASS_AFTER_FORCE_MS = 1500;
const CLICK_DEDUPE_TTL_MS = 3000;
const CLICK_COOLDOWN_MS = 350;
const SAME_TOP_LEAD_LOG_MS = 1000;
const DEBUG            = true;
const HEARTBEAT_MS     = 3000;

// ── Card selectors (tried in order, first match wins) ────
const CARD_SELECTORS = [
  '[class*="lstNw"]',
  'div.f1.lstNw',
  'div.bl_listing',
  '[class*="Prd_Enq"]',
  '[class*="bl-listing"]'
];

// ── Feed container selector (narrows button proximity search) ─
const FEED_SELECTORS = [
  '#list1',
  'div.bl_grid',
  '[class*="bl_listing"]',
  '#buyleads-container',
  '.messagecentre-right',
  'main',
  'section'
];

// ── Helpers ──────────────────────────────────────────────
function escapeRegExp(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debugStamp() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function logInfo(msg, meta) {
  if (!DEBUG) return;
  if (meta !== undefined) console.log(`[BuyLead][${debugStamp()}] ${msg}`, meta);
  else console.log(`[BuyLead][${debugStamp()}] ${msg}`);
}

function logWarn(msg, meta) {
  if (meta !== undefined) console.warn(`[BuyLead][${debugStamp()}] ${msg}`, meta);
  else console.warn(`[BuyLead][${debugStamp()}] ${msg}`);
}

function logDebug(msg, meta) {
  if (!DEBUG) return;
  if (meta !== undefined) console.debug(`[BuyLead][${debugStamp()}] ${msg}`, meta);
  else console.debug(`[BuyLead][${debugStamp()}] ${msg}`);
}

function scannerSnapshot() {
  return {
    state: scannerState,
    enabled: isEnabled,
    settingsReady,
    processing: isProcessingCard,
    hasActiveProcess: !!activeProcess,
    dedupeCacheSize: recentlyClickedLeads.size,
    pickedCount,
    leadLimit,
    tick: scanTickCount
  };
}

function pruneRecentlyClicked(now = Date.now()) {
  for (const [k, ts] of recentlyClickedLeads.entries()) {
    if (now - ts > CLICK_DEDUPE_TTL_MS) recentlyClickedLeads.delete(k);
  }
}

function getCardStructureKey(card) {
  const id = card.getAttribute('data-id') || card.getAttribute('data-lead-id') || card.id || '';
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';
  const gridId = card.closest('[id^="list"]')?.id || '';
  const cardIndex = card.parentElement
    ? Array.prototype.indexOf.call(card.parentElement.children, card)
    : -1;
  return `${normalizeText(id)}|${normalizeText(href)}|${normalizeText(gridId)}|${cardIndex}`;
}

function getLeadKey(card) {
  const ofrId = card.querySelector('input[name="ofrid"]')?.value || card.getAttribute('data-id') || card.getAttribute('data-lead-id') || '';
  const offerDate = card.querySelector('input[name="offerdate"]')?.value || card.querySelector('input[name="ofrdate"]')?.value || '';
  const mcatId = card.querySelector('input[name="mcatid"]')?.value || card.querySelector('input[name="mcatidnew"]')?.value || '';
  const gridParam = card.querySelector('input[name="gridParam1"]')?.value || card.querySelector('input[id^="gridParam"]')?.value || '';
  const cityId = card.querySelector('input[id^="city_id_"]')?.value || '';
  const city = card.querySelector('input[id^="card_city_"]')?.value || '';
  const state = card.querySelector('input[id^="card_state_"]')?.value || '';
  const country = card.querySelector('input[id^="card_country_"]')?.value || '';
  const buyerId = card.querySelector('input[id^="prime_mcat_id_"]')?.value || '';
  const cat = card.querySelector('input[name="mcatname"]')?.value || card.querySelector('input[name="parent_mcatname"]')?.value || '';
  const productOrService = card.querySelector('input[id^="productOrService"]')?.value || '';
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';

  // Prefer explicit lead id when available so same-title inquiries are treated independently.
  if (normalizeText(ofrId)) return `leadid:${normalizeText(ofrId)}`;

  // Fallback avoids title-only identity; combines multiple metadata fields.
  const parts = [
    normalizeText(offerDate),
    normalizeText(mcatId),
    normalizeText(gridParam),
    normalizeText(cityId),
    normalizeText(city),
    normalizeText(state),
    normalizeText(country),
    normalizeText(buyerId),
    normalizeText(cat),
    normalizeText(productOrService),
    normalizeText(href)
  ];

  const nonEmpty = parts.filter(Boolean).length;
  if (nonEmpty < 3) {
    const structural = getCardStructureKey(card);
    logWarn('Weak fallback dedupe key detected. Using structural fallback.', { nonEmpty, structural });
    return `fallback:${parts.join('|')}|${structural}`;
  }

  return `fallback:${parts.join('|')}`;
}

function wasRecentlyClicked(leadKey, now = Date.now()) {
  const ts = recentlyClickedLeads.get(leadKey);
  return !!(ts && (now - ts) <= CLICK_DEDUPE_TTL_MS);
}

function markLeadClicked(leadKey, now = Date.now()) {
  recentlyClickedLeads.set(leadKey, now);
}

function globalClickCoolingDown(now = Date.now()) {
  return (now - lastClickAt) < CLICK_COOLDOWN_MS;
}

function sendMessageWithResponse(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// ── Settings ─────────────────────────────────────────────
function loadSettings(cb) {
  const seq = ++settingsLoadSeq;
  try {
    chrome.storage.sync.get(['keywords', 'enabled', 'leadLimit', 'pickedCount'], (d) => {
      // Discard if a newer load has already started
      if (seq !== settingsLoadSeq) { if (cb) cb(false); return; }
      if (chrome.runtime.lastError) {
        console.warn('[BuyLead] Storage error:', chrome.runtime.lastError.message);
        if (cb) cb(false);
        return;
      }
      keywords     = Array.isArray(d.keywords) ? d.keywords : [];
      isEnabled    = d.enabled === true;
      leadLimit    = parseInt(d.leadLimit, 10)  || 0;
      pickedCount  = parseInt(d.pickedCount, 10) || 0;
      compiledKeywords = keywords
        .map(kw => (typeof kw === 'string' ? kw : '').trim())
        .filter(kw => kw.length > 0 && kw.length < 200) // cap length; long strings waste regex time
        .map(kw => new RegExp(escapeRegExp(kw), 'i'));
      settingsReady = true;
      logInfo('Settings loaded', {
        enabled: isEnabled,
        keywordCount: keywords.length,
        leadLimit: leadLimit || '∞'
      });
      if (cb) cb(true);
    });
  } catch (e) {
    logWarn('loadSettings threw', e);
    if (cb) cb(false);
  }
}

function limitReached() {
  return leadLimit > 0 && pickedCount >= leadLimit;
}

function isElementVisible(el) {
  if (!el || !el.isConnected) return false;
  try {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  } catch (_) {
    return false;
  }
}

function getVisibleShimmerInfo(root = document) {
  const scope = root || document;
  const nodes = Array.from(scope.querySelectorAll('.secshimmer, .backgroundshimmer, [class*="shimmer"]'));
  const visible = nodes.filter(isElementVisible);
  return {
    visibleCount: visible.length,
    sampleClasses: visible.slice(0, 3).map((el) => el.className || '(no-class)')
  };
}

function shouldBlockForShimmer() {
  const feed = getFeedContainer();
  const shimmerInfo = getVisibleShimmerInfo(feed);
  if (shimmerInfo.visibleCount === 0) return { block: false, reason: 'no-visible-shimmer', shimmerInfo };

  const cards = findLeadCards(feed);
  if (cards.length > 0) {
    const title = getLeadTitle(cards[0]);
    if (title && title.length >= 4) {
      return { block: false, reason: 'stable-top-card-present', shimmerInfo };
    }

    // If cards exist but title extraction is transiently incomplete, avoid hard blocking.
    return { block: false, reason: 'cards-present-allow-scan', shimmerInfo };
  }

  return { block: true, reason: 'visible-shimmer-no-stable-card', shimmerInfo };
}

function cancelActiveProcess() {
  if (activeProcess) {
    logDebug('Cancelling active process', { token: activeProcess.token, fingerprint: activeProcess.fingerprint });
    activeProcess.cancelled = true;
  }
}

function isProcessCurrent(ctx) {
  return !!(
    ctx &&
    activeProcess &&
    activeProcess.token === ctx.token &&
    activeProcess.fingerprint === ctx.fingerprint &&
    !ctx.cancelled
  );
}

// ── Count persistence ─────────────────────────────────────
// Read-then-write avoids count drift when two tabs are open.
async function incrementPicked() {
  const res = await sendMessageWithResponse({ type: 'INCREMENT_COUNT' });
  if (!res || res.ok !== true) {
    logWarn('INCREMENT_COUNT failed; count not updated.', res);
    return { ok: false, reached: limitReached() };
  }

  const nextCount = parseInt(res.pickedCount, 10);
  const nextLimit = parseInt(res.leadLimit, 10);

  if (!Number.isNaN(nextCount)) pickedCount = nextCount;
  if (!Number.isNaN(nextLimit)) leadLimit = nextLimit;

  safeSendMessage({ type: 'COUNT_UPDATED', pickedCount, leadLimit });
  logInfo('Count incremented', { pickedCount, leadLimit: leadLimit || '∞', reached: res.reached === true });

  if (res.reached === true) {
    isEnabled = false;
    stopScanner();
    safeSendMessage({ type: 'LIMIT_REACHED', pickedCount });
    logWarn(`Lead limit ${leadLimit} reached. Scanner disabled.`);
  }

  return { ok: true, reached: res.reached === true };
}

// ── Messaging ─────────────────────────────────────────────
function safeSendMessage(msg, cb) {
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) { if (cb) cb(false); return; }
      if (cb) cb(res || true);
    });
  } catch (_) {
    if (cb) cb(false);
  }
}

function notifyMatch(title, clicked) {
  safeSendMessage({
    type:    'NOTIFY',
    title:   clicked ? `✅ Accepted (${pickedCount}/${leadLimit || '∞'})` : '⚠️ Match — no button found',
    message: title.substring(0, 100)
  });
}

// ── Keyword matching ──────────────────────────────────────
function matchesKeywords(text) {
  if (!compiledKeywords.length) return false;
  const rx = compiledKeywords.find(r => r.test(text));
  if (rx) {
    logInfo('Keyword matched', { title: text, matchedRegex: String(rx) });
    return true;
  }
  return false;
}

// ── Title extraction ──────────────────────────────────────
// Primary: hidden input IndiaMart injects specifically for offer tracking.
// Fallbacks cover layout variants and A/B tests.
function getLeadTitle(card) {
  const inp = card.querySelector('input[name="ofrtitle"]');
  if (inp?.value) return inp.value.trim();

  const fallbacks = [
    '.bl_lsting_title',
    '[class*="Prd_Enq"] h2',
    '[class*="Prd_Enq"] h3',
    'h2', 'h3',
    '.prod-name', '.product-name',
    '.bl-prod-name', '.lead-title'
  ];
  for (const sel of fallbacks) {
    const el = card.querySelector(sel);
    if (el) {
      const t = el.textContent.trim();
      if (t.length > 3) return t;
    }
  }
  // Last resort: first [class*="buy"] text that isn't just a button label
  const buyEl = card.querySelector('[class*="buy"], [class*="Buy"]');
  if (buyEl) {
    const t = buyEl.textContent.trim();
    if (t.length > 3) return t;
  }
  return '';
}

// ── Card fingerprint ──────────────────────────────────────
// Uses only stable DOM attributes — NOT textContent.
// textContent changes during micro-refreshes and causes false "new card" signals.
function getCardFingerprint(card, title) {
  const id =
    card.querySelector('input[name="ofrid"]')?.value ||
    card.getAttribute('data-id') ||
    card.getAttribute('data-lead-id') ||
    card.id ||
    '';
  const offerDate = card.querySelector('input[name="offerdate"]')?.value || card.querySelector('input[name="ofrdate"]')?.value || '';
  const cityId = card.querySelector('input[id^="city_id_"]')?.value || '';
  const city = card.querySelector('input[id^="card_city_"]')?.value || '';
  const state = card.querySelector('input[id^="card_state_"]')?.value || '';
  const country = card.querySelector('input[id^="card_country_"]')?.value || '';
  const mcatId = card.querySelector('input[name="mcatid"]')?.value || card.querySelector('input[name="mcatidnew"]')?.value || '';
  const gridParam = card.querySelector('input[name="gridParam1"]')?.value || card.querySelector('input[id^="gridParam"]')?.value || '';
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';
  const cardIndex = card.parentElement
    ? Array.prototype.indexOf.call(card.parentElement.children, card)
    : -1;

  // Prefer lead-specific metadata over title to distinguish similar inquiries.
  if (normalizeText(id)) {
    return `id:${normalizeText(id)}|${normalizeText(offerDate)}|${normalizeText(cityId)}|${normalizeText(mcatId)}`;
  }

  return [
    normalizeText(offerDate),
    normalizeText(gridParam),
    normalizeText(cityId),
    normalizeText(city),
    normalizeText(state),
    normalizeText(country),
    normalizeText(mcatId),
    normalizeText(href),
    normalizeText(title),
    cardIndex
  ].join('|');
}

// ── Click helpers ─────────────────────────────────────────
// No getBoundingClientRect — forces layout reflow, adds latency at 100ms polling.
function isClickable(el) {
  if (!el?.isConnected || el.disabled) return false;
  try {
    const s = getComputedStyle(el);
    if (s.display === 'none')       return false;
    if (s.visibility === 'hidden')  return false;
    if (s.pointerEvents === 'none') return false;
    return true;
  } catch (_) {
    return false;
  }
}

// Fire mousedown + mouseup + click to cover React/Vue synthetic event handlers.
function tryClick(el) {
  if (!isClickable(el)) return false;
  try {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    el.click();

    // Some IndiaMart CTAs are divs with inline onclick handler and little/no text.
    if (typeof el.onclick === 'function') {
      el.onclick();
    }

    logInfo('Click fired', {
      tag: el.tagName,
      id: el.id || null,
      className: el.className || null,
      buttonText: (el.textContent || '').trim().substring(0, 40),
      title: el.getAttribute('title') || null
    });
    return true;
  } catch (e) {
    logWarn('Click dispatch failed', e);
    return false;
  }
}

function isContactBuyerElement(el) {
  if (!el) return false;
  try {
    const txt = normalizeText(el.textContent || '');
    const titleText = normalizeText(el.getAttribute('title') || '');
    const ariaLabel = normalizeText(el.getAttribute('aria-label') || '');
    const onclickAttr = normalizeText(el.getAttribute('onclick') || '');
    const className = normalizeText(el.className || '');

    return (
      CONTACT_BUYER_RX.test(txt) ||
      CONTACT_BUYER_RX.test(titleText) ||
      CONTACT_BUYER_RX.test(ariaLabel) ||
      onclickAttr.includes('contactbuyernow') ||
      className.includes('btncbn')
    );
  } catch (e) {
    logWarn('Skipping candidate due to inspection error.', e);
    return false;
  }
}

// ── Feed container ────────────────────────────────────────
function getFeedContainer() {
  for (const sel of FEED_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

// ── Button finder ─────────────────────────────────────────
// 1. Search inside the card first (fast, safe, no wrong-card risk).
// 2. Proximity fallback within the feed container only if step 1 fails.
//    600px cap prevents matching a button from an unrelated card.
function findContactButton(card) {
  for (const el of card.querySelectorAll('button, a, [class*="btn"], [class*="Btn"], .btnCBN')) {
    if (isContactBuyerElement(el) && isClickable(el)) {
      logDebug('Button found inside card', {
        text: (el.textContent || '').trim().substring(0, 40),
        title: el.getAttribute('title') || null,
        className: el.className || null
      });
      return el;
    }
  }

  // Ranked fallback across multiple roots. Sticky/footer CTA is often outside card/feed subtree.
  const feed = getFeedContainer();
  const panel = card.closest('[class*="lstNw"], [class*="bl_listing"], .bl_grid, section, article');
  const roots = [panel, feed, document.body].filter(Boolean);
  const cardRect = card.getBoundingClientRect();
  const seen = new Set();
  const candidates = [];

  const selector = [
    'button',
    'a',
    '[role="button"]',
    '[class*="btn"]',
    '[class*="Btn"]',
    '.btnCBN',
    '[onclick]'
  ].join(', ');

  for (const root of roots) {
    for (const el of root.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);

      if (!isContactBuyerElement(el)) continue;
      if (!isClickable(el)) continue;

      const r = el.getBoundingClientRect();
      const dy = Math.abs(r.top - cardRect.top);
      const dx = Math.abs(r.left - cardRect.left);

      let score = dy + (dx * 0.25);
      if (card.contains(el)) score -= 1000; // should have returned already, but keep as strongest safety
      if (panel && panel.contains(el)) score -= 250;
      if (r.top > cardRect.top) score -= 40; // usually CTA sits below title/details in same card/panel

      candidates.push({
        el,
        score,
        dy: Math.round(dy),
        dx: Math.round(dx),
        txt: (el.textContent || '').trim().substring(0, 60),
        title: (el.getAttribute('title') || '').substring(0, 60),
        className: (el.className || '').substring(0, 60)
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0]?.el || null;
  if (best) {
    logDebug('Button found by ranked fallback', {
      candidateCount: candidates.length,
      top: candidates.slice(0, 3).map(c => ({
        text: c.txt,
        title: c.title,
        className: c.className,
        score: Math.round(c.score),
        dy: c.dy,
        dx: c.dx
      }))
    });
    return best;
  }

  logWarn('No Contact Buyer candidate found in fallback roots.', {
    rootsChecked: roots.length,
    feedTag: feed?.tagName,
    panelClass: panel?.className || null
  });
  return null;
}

// ── Click with single render-wait fallback ────────────────
// No confirmation loop. No multi-retry with growing sleeps.
// Strategy: fire immediately. If button not found, wait ONE short
// render frame (60ms) and try once more. That's it.
// Rationale: if the button still isn't there after 60ms, the card
// has no button (already claimed) — retrying for 360ms won't change that.
async function clickAcceptButton(card, ctx, parentRef) {
  if (!card?.isConnected || card.parentElement !== parentRef || !isProcessCurrent(ctx)) return false;

  let btn = findContactButton(card);
  if (!btn) {
    await sleep(60); // single render-frame wait
    if (!card?.isConnected || card.parentElement !== parentRef || !isProcessCurrent(ctx)) return false;
    btn = findContactButton(card);
  }

  if (!btn) {
    logWarn('No "Contact Buyer" button found on matched card.');
    return false;
  }

  return tryClick(btn);
}

// ── Process top card ──────────────────────────────────────
async function processCard(card, ctx) {
  if (!isEnabled || !card || card.nodeType !== 1 || limitReached()) return false;
  if (!card.isConnected || !isProcessCurrent(ctx)) return false;

  const parentRef = card.parentElement;
  if (!parentRef) return false;

  const title = getLeadTitle(card);
  if (!title || title.length < 4) {
    logWarn('Card skipped — could not extract title.', { className: card.className });
    return false;
  }

  logDebug('Evaluating top card title', { title });

  pruneRecentlyClicked();
  const now = Date.now();
  const leadKey = getLeadKey(card);
  if (wasRecentlyClicked(leadKey)) {
    logWarn('Skipping lead due to dedupe TTL (recently clicked).', { leadKey });
    return false;
  }

  if (globalClickCoolingDown(now)) {
    logDebug('Skipping lead due to global click cooldown.', { cooldownMs: CLICK_COOLDOWN_MS });
    return false;
  }

  if (!matchesKeywords(title) || !isProcessCurrent(ctx)) return false;

  if (!card.isConnected || card.parentElement !== parentRef || !isProcessCurrent(ctx)) {
    logWarn('Card detached before click.');
    return false;
  }

  const clicked = await clickAcceptButton(card, ctx, parentRef);

  if (clicked) {
    lastClickAt = Date.now();
    markLeadClicked(leadKey, lastClickAt);
    await incrementPicked();
    // Keep lastTopCardId unchanged to avoid rapid re-click loops on the same top card.
  }

  notifyMatch(title, clicked);
  return clicked;
}

// ── Card discovery ────────────────────────────────────────
function findLeadCards(root = document) {
  const isValidCard = (el) => {
    // Reject anything inside a shimmer/skeleton layer
    if (el.closest('.secshimmer, .backgroundshimmer, [class*="shimmer"]')) return false;
    // Accept if it has the canonical title input, a known title class, or enough text
    return (
      el.querySelector('input[name="ofrtitle"]') ||
      el.querySelector('.prod-name, .bl_lsting_title') ||
      normalizeText(el.textContent).length > 20
    );
  };

  for (const sel of CARD_SELECTORS) {
    const cards = Array.from(root.querySelectorAll(sel)).filter(isValidCard);
    if (cards.length) return cards;
  }
  return [];
}

// ── Scanner ───────────────────────────────────────────────
function startScanner() {
  if (!settingsReady) {
    logWarn('Scanner start skipped: settings not ready.');
    return;
  }
  stopScanner();
  scannerState = 'READY';
  lastShimmerSeenAt = 0;
  scanTickCount = 0;
  lastHeartbeatAt = 0;
  shimmerWasVisible = false;
  settleWaitLogged = false;
  shimmerBlockStartedAt = 0;
  shimmerBlockConsecutive = 0;
  ignoreShimmerUntil = 0;
  logInfo('Scanner started', {
    pollMs: POLL_MS,
    shimmerSettleMs: SHIMMER_SETTLE_MS,
    shimmerMaxBlockMs: SHIMMER_MAX_BLOCK_MS,
    keywords
  });

  scanInterval = setInterval(() => {
    scanTickCount += 1;

    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      logDebug('Scanner heartbeat', scannerSnapshot());
    }

    if (!isEnabled || limitReached()) { stopScanner(); return; }

    // Skip while IndiaMart is mid-refresh (shimmer/skeleton visible).
    // If we recently force-resumed, bypass shimmer checks briefly.
    const bypassActive = Date.now() < ignoreShimmerUntil;
    const shimmerCheck = bypassActive
      ? { block: false, reason: 'bypass-active', shimmerInfo: { visibleCount: 0, sampleClasses: [] } }
      : shouldBlockForShimmer();

    if (shimmerCheck.block) {
      if (!shimmerBlockStartedAt) shimmerBlockStartedAt = Date.now();
      const blockedMs = Date.now() - shimmerBlockStartedAt;
      shimmerBlockConsecutive += 1;

      if (blockedMs >= SHIMMER_MAX_BLOCK_MS || shimmerBlockConsecutive >= SHIMMER_FORCE_RESUME_STREAK) {
        logWarn('Shimmer block exceeded max window; forcing scanner resume.', {
          blockedMs,
          consecutiveBlocks: shimmerBlockConsecutive,
          reason: shimmerCheck.reason,
          shimmerInfo: shimmerCheck.shimmerInfo
        });
        shimmerWasVisible = false;
        shimmerBlockStartedAt = 0;
        shimmerBlockConsecutive = 0;
        ignoreShimmerUntil = Date.now() + SHIMMER_BYPASS_AFTER_FORCE_MS;
      } else {
        if (!shimmerWasVisible) {
          shimmerWasVisible = true;
          logInfo('Shimmer detected — scanner temporarily blocked.', {
            reason: shimmerCheck.reason,
            shimmerInfo: shimmerCheck.shimmerInfo
          });
        }

        scannerState = 'SHIMMER_BLOCKED';
        lastShimmerSeenAt = Date.now();
        lastTopCardId = null; // reset so the incoming card is evaluated fresh
        settleWaitLogged = false;
        cancelActiveProcess();
        return;
      }
    } else {
      shimmerBlockStartedAt = 0;
      shimmerBlockConsecutive = 0;
    }

    if (shimmerWasVisible) {
      shimmerWasVisible = false;
      logInfo('Shimmer cleared — entering settle wait.', { settleMs: SHIMMER_SETTLE_MS });
    }

    // Wait a short settle window after shimmer clears to avoid partial DOM reads.
    if (Date.now() - lastShimmerSeenAt < SHIMMER_SETTLE_MS) {
      scannerState = 'SHIMMER_BLOCKED';
      if (!settleWaitLogged) {
        settleWaitLogged = true;
        logDebug('Settle wait active after shimmer clear.');
      }
      return;
    }

    if (settleWaitLogged) {
      settleWaitLogged = false;
      logDebug('Settle wait completed; scanner resumed.');
    }

    const cards = findLeadCards();
    if (!cards.length) return;

    const topCard  = cards[0];
    const title    = getLeadTitle(topCard);
    const currentId = getCardFingerprint(topCard, title);

    // If processing old top-card and the top changed, cancel stale process.
    if (activeProcess && currentId !== activeProcess.fingerprint) {
      cancelActiveProcess();
      logDebug('Top card changed while processing; stale process cancelled.', {
        previous: activeProcess?.fingerprint,
        next: currentId
      });
    }

    // Log once per second when the top lead is unchanged.
    if (currentId === lastTopCardId) {
      const nowMs = Date.now();
      if (nowMs - lastSameTopLeadLogAt >= SAME_TOP_LEAD_LOG_MS) {
        lastSameTopLeadLogAt = nowMs;
        logDebug('Still same top lead', {
          title,
          fingerprint: currentId
        });
      }
      return;
    }

    // Do not start a new process while one is already in flight.
    if (isProcessingCard || activeProcess) return;

    scannerState      = 'PROCESSING';
    lastTopCardId    = currentId;
    isProcessingCard = true;
    activeProcess    = { token: ++processSeq, fingerprint: currentId, cancelled: false };
    const processCtx = activeProcess;
    logInfo('New top lead picked for processing', {
      token: processCtx.token,
      title,
      fingerprint: currentId
    });

    processCard(topCard, processCtx).finally(() => {
      if (activeProcess && activeProcess.token === processCtx.token) {
        activeProcess = null;
        isProcessingCard = false;
        scannerState = 'READY';
        logDebug('Process completed and scanner returned to READY.', { token: processCtx.token });
      }
    });
  }, POLL_MS);
}

function stopScanner() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval     = null;
  }
  lastTopCardId    = null;
  isProcessingCard = false;
  activeProcess    = null;
  scannerState     = 'IDLE';
  shimmerBlockConsecutive = 0;
  ignoreShimmerUntil = 0;
  logInfo('Scanner stopped.', scannerSnapshot());
}

// ── Settings reload (triggered by popup) ─────────────────
// No debounce needed — SETTINGS_UPDATED is a deliberate user action, not a burst.
function reloadSettingsAndScanner(cb) {
  stopScanner();
  loadSettings((ok) => {
    if (ok && isEnabled && !limitReached()) startScanner();
    if (cb) cb(ok);
  });
}

// ── Message listener ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === 'SETTINGS_UPDATED') {
    logInfo('Received SETTINGS_UPDATED message. Reloading scanner settings.');
    reloadSettingsAndScanner((ok) => sendResponse({ ok }));
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ enabled: isEnabled, keywords, pickedCount, leadLimit });
    return;
  }

  if (msg.type === 'RESET_COUNT') {
    pickedCount = 0;
    chrome.storage.sync.set({ pickedCount: 0 });
    logInfo('Received RESET_COUNT message. Counter reset to 0.');
    sendResponse({ ok: true });
  }
});

// ── Init ──────────────────────────────────────────────────
loadSettings(() => {
  if (isEnabled && !limitReached()) {
    logInfo('Init: extension is active and watching.');
    startScanner();
  } else {
    logInfo('Init: extension is disabled or lead limit already reached.');
  }
});

// ── SPA navigation detection ──────────────────────────────
// Patch pushState + replaceState to catch framework-driven navigation.
// popstate handles browser back/forward.
// No polling fallback needed — the three listeners cover all cases.
function handleNavigationChange() {
  if (location.href === lastHandledUrl) return;
  const prevUrl = lastHandledUrl;
  lastHandledUrl = location.href;
  logInfo('Navigation detected — restarting scanner.', { from: prevUrl, to: lastHandledUrl });
  cancelActiveProcess();
  stopScanner();
  // Brief wait for the new page's DOM to settle before scanning
  setTimeout(() => {
    if (isEnabled && settingsReady && !limitReached()) startScanner();
  }, 300);
}

window.addEventListener('popstate', handleNavigationChange);

const _origPush = history.pushState;
history.pushState = function (...args) {
  const r = _origPush.apply(this, args);
  handleNavigationChange();
  return r;
};

const _origReplace = history.replaceState;
history.replaceState = function (...args) {
  const r = _origReplace.apply(this, args);
  handleNavigationChange();
  return r;
};