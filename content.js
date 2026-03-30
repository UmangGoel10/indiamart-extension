// ============================================================
// IndiaMart BuyLead Auto-Picker — content.js (SPEED v4)
// Page: seller.indiamart.com/messagecentre/buyleads/
// ============================================================

let keywords = [];
let isEnabled = false;
let leadLimit = 0;
let pickedCount = 0;

let compiledKeywords = [];
let scanInterval = null;
let lastTopCardId = null; // Track the current top card so we don't spam clicks on the same one
let isProcessingCard = false;
let settingsReady = false;
let settingsLoadSeq = 0;
let settingsReloadTimer = null;
let cachedCardSelector = null;
let lastHandledUrl = location.href;

const CONTACT_BUYER_RX = /contact\s*buyer/i;
const POLL_INTERVAL_MS = 100; // Aggressive while-loop equivalent

function escapeRegExp(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(v) {
  return (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Card & feed selectors ────────────────────────────────
const CARD_SELECTORS = [
  '[class*="lstNw"]',
  'div.f1.lstNw',
  'div.bl_listing',
  '[class*="Prd_Enq"]',
  '[class*="bl-listing"]'
];
const CARD_SELECTOR_STR = CARD_SELECTORS.join(',');

// ── Load settings ────────────────────────────────────────
function loadSettings(cb) {
  const seq = ++settingsLoadSeq;
  try {
    chrome.storage.sync.get(['keywords', 'enabled', 'leadLimit', 'pickedCount'], (d) => {
      if (seq !== settingsLoadSeq) {
        if (cb) cb(false);
        return;
      }
      if (chrome.runtime.lastError) {
        console.warn('[BuyLead] Storage error:', chrome.runtime.lastError.message);
        if (cb) cb(false);
        return;
      }
      keywords = Array.isArray(d.keywords) ? d.keywords : [];
      isEnabled = d.enabled === true;
      leadLimit = parseInt(d.leadLimit, 10) || 0;
      pickedCount = parseInt(d.pickedCount, 10) || 0;
      compiledKeywords = keywords
        .map(kw => (typeof kw === 'string' ? kw : '').trim())
        .filter(Boolean)
        .map(kw => new RegExp(escapeRegExp(kw), 'i'));
      settingsReady = true;

      console.log(`[BuyLead] Settings loaded. Enabled: ${isEnabled}, Keywords: ${keywords.length}, Limit: ${leadLimit || '∞'}`);
      if (cb) cb(true);
    });
  } catch (e) {
    console.warn('[BuyLead] loadSettings failed:', e);
    if (cb) cb(false);
  }
}

function limitReached() {
  return leadLimit > 0 && pickedCount >= leadLimit;
}

function safeSendMessage(msg, cb) {
  try {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        if (cb) cb(false);
        return;
      }
      if (cb) cb(response || true);
    });
  } catch (_) {
    if (cb) cb(false);
  }
}

function incrementPicked() {
  pickedCount++;
  const reached = limitReached();
  if (reached) {
    isEnabled = false;
    stopScanner();
  }

  const update = reached ? { pickedCount, enabled: false } : { pickedCount };
  chrome.storage.sync.set(update, () => {
    safeSendMessage({ type: 'COUNT_UPDATED', pickedCount, leadLimit });
    if (reached) {
      safeSendMessage({ type: 'LIMIT_REACHED', pickedCount });
      console.log(`[BuyLead] Limit ${leadLimit} reached. Disabled.`);
    }
  });
}

function matchesKeywords(text) {
  if (!compiledKeywords.length) return false;
  const match = compiledKeywords.find(rx => rx.test(text));
  if (match) {
    console.log(`[BuyLead] 🎯 Match found! Title: "${text}" matched keyword pattern: ${match}`);
    return true;
  }
  return false;
}

// ── Extract lead title ───────────────────────────────────
function getLeadTitle(card) {
  // IndiaMart provides this hidden input precisely for tracking the offer title
  const titleInput = card.querySelector('input[name="ofrtitle"]');
  if (titleInput && titleInput.value) {
    return titleInput.value.trim();
  }

  // Fallbacks just in case
  const sels = [
    '.bl_lsting_title',
    '[class*="Prd_Enq"] h2', '[class*="Prd_Enq"] h3',
    'h2', 'h3',
    '.prod-name', '.product-name',
    '.bl-prod-name', '.lead-title'
  ];
  for (const s of sels) {
    const el = card.querySelector(s);
    if (el) {
      const t = (el.textContent || '').trim();
      if (t.length > 3) return t;
    }
  }
  const buys = card.querySelector('[class*="buy"], [class*="Buy"]');
  if (buys) {
    const t = (buys.textContent || '').trim();
    if (t.length > 3) return t;
  }
  return '';
}

// ── Click helpers ────────────────────────────────────────
function isClickable(el) {
  if (!el?.isConnected || el.disabled) return false;
  try {
    const s = getComputedStyle(el);
    if (s.display === 'none') return false;
    if (s.visibility === 'hidden') return false;
    if (s.pointerEvents === 'none') return false;
    if (parseFloat(s.opacity || '1') < 0.1) return false;
    const rect = el.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
    return inViewport;
  } catch (_) {
    return false; // detached or invalid node
  }
}

function tryClick(el) {
  if (!isClickable(el)) return false;
  console.log(`[BuyLead] 🖱️ Attempting click on:`, el);
  try {
    // Fire multiple event styles since some UIs ignore plain .click().
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    return true;
  } catch (e) {
    console.warn('[BuyLead] Click dispatch failed:', e);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmClickApplied(card, btn, beforeTopId, beforeBtnText) {
  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    await sleep(80);

    if (!card?.isConnected) return true;
    if (!btn?.isConnected) return true;
    if (btn.disabled) return true;

    const currentBtnText = normalizeText(btn.textContent || '');
    if (currentBtnText && currentBtnText !== normalizeText(beforeBtnText || '')) {
      return true;
    }
    if (beforeBtnText && !CONTACT_BUYER_RX.test(btn.textContent || '')) {
      return true;
    }

    const cards = findLeadCards();
    if (!cards.length) continue;
    const topCard = cards[0];
    const currentTopId = getCardFingerprint(topCard, getLeadTitle(topCard));
    if (beforeTopId && currentTopId !== beforeTopId) {
      return true;
    }
  }

  return false;
}

// ── Click "Contact Buyer Now" ────────────────────────────
function findContactButton(card) {
  // Local search first
  for (const el of card.querySelectorAll('button, a, [class*="btn"], [class*="Btn"], .btnCBN')) {
    const text = (el.textContent || '').trim();
    if (CONTACT_BUYER_RX.test(text) && isClickable(el)) {
      console.log(`[BuyLead] Found button by text: "${text}"`);
      return el;
    }
  }
  // Proximity fallback in feed
  const cardTop = card.getBoundingClientRect().top;
  const feed = getFeedContainer();
  let best = null, bestDist = 600;
  for (const btn of feed.querySelectorAll('button, a[class*="contact"], [class*="contactBtn"], [class*="contact_buyer"], .btnCBN')) {
    const text = (btn.textContent || '').trim();
    if (!CONTACT_BUYER_RX.test(text) || !isClickable(btn)) continue;
    const d = Math.abs(btn.getBoundingClientRect().top - cardTop);
    if (d < bestDist) { bestDist = d; best = btn; }
  }
  if (best) {
    console.log(`[BuyLead] Found button by proximity (${Math.round(bestDist)}px)`);
    return best;
  }
  return null;
}

async function clickAcceptButton(card, maxRetries = 3) {
  const beforeTopId = getCardFingerprint(card, getLeadTitle(card));
  for (let i = 0; i < maxRetries; i++) {
    if (!card?.isConnected) return false;
    const btn = findContactButton(card);
    if (btn && tryClick(btn)) {
      const confirmed = await confirmClickApplied(card, btn, beforeTopId, btn.textContent || '');
      if (confirmed) return true;
      console.warn('[BuyLead] Click fired but no UI confirmation detected. Retrying...');
    }
    if (i < maxRetries - 1) {
      await sleep(120 * (i + 1));
    }
  }
  console.warn('[BuyLead] Match found, but click was not confirmed.');
  return false;
}

function getFeedContainer() {
  for (const sel of ['#list1', 'div.bl_grid', '[class*="bl_listing"]', '#buyleads-container', '.messagecentre-right', 'main', 'section']) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

function notifyMatch(title, clicked) {
  safeSendMessage({
    type: 'NOTIFY',
    title: clicked ? `✅ Accepted (${pickedCount}/${leadLimit || '∞'})` : '⚠️ Match — no button',
    message: title.substring(0, 100)
  });
}

// ── Fingerprint for dedup ────────────────────────────────
function getCardFingerprint(card, title) {
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';
  const id = card.getAttribute('data-id') || card.getAttribute('data-lead-id') || card.id || '';
  const summary = normalizeText(card.textContent || '').substring(0, 180);
  return `${normalizeText(title)}|${href}|${id}|${summary}`;
}

// ── Process one card (no delays) ─────────────────────────
async function processCard(card) {
  if (!isEnabled || !card || card.nodeType !== 1 || limitReached()) return false;
  if (!card.isConnected) return false;

  const title = getLeadTitle(card);
  if (!title || title.length < 4) return false;

  console.debug(`[BuyLead] Evaluating Top Lead: "${title}"`);

  if (matchesKeywords(title)) {
    if (!card.isConnected) {
      console.warn('[BuyLead] Card detached before click attempt.');
      return false;
    }
    const clicked = await clickAcceptButton(card);
    if (clicked) {
      incrementPicked();
      // Reset immediately so scanner can re-evaluate top lead while feed catches up.
      lastTopCardId = null;
    }
    notifyMatch(title, clicked);
    return true; // Return true if we took action
  }
  return false;
}

// ── Continuous Polling Loop (The "While" loop) ───────────
// We use setInterval instead of a "while(true)" loop because JavaScript is single-threaded.
// A literal while loop would freeze the browser tab entirely and IndiaMart would never load.
function startScanner() {
  if (!settingsReady) {
    console.log('[BuyLead] Scanner start skipped: settings not ready.');
    return;
  }
  stopScanner();
  const kwList = keywords.join(', ');
  console.log(`[BuyLead] ⚡ Starting high-speed scanner. Checking top lead every ${POLL_INTERVAL_MS}ms for keywords: [${kwList}]`);

  scanInterval = setInterval(() => {
    if (!isEnabled || limitReached()) {
      stopScanner();
      return;
    }

    const isShimmering = document.querySelector('.secshimmer, .backgroundshimmer, [class*="shimmer"]');
    if (isShimmering) {
      if (lastTopCardId) {
        console.log('[BuyLead] Page refresh/shimmer detected. Waiting for stable cards...');
      }
      lastTopCardId = null;
      return;
    }

    const cards = findLeadCards();
    if (cards.length > 0) {
      const topCard = cards[0];
      const newTitle = getLeadTitle(topCard);
      const currentId = getCardFingerprint(topCard, newTitle);

      if (currentId !== lastTopCardId && !isProcessingCard) {
        lastTopCardId = currentId; // Mark this as our new target
        console.log(`[BuyLead] 👀 New top lead detected: "${newTitle}"`);
        isProcessingCard = true;
        processCard(topCard).finally(() => {
          isProcessingCard = false;
        });
      } else {
        // Optional debug log: uncomment if you want to see the 100ms loop running
        console.debug(`[BuyLead] ⏳ Still observing same top lead: "${newTitle}"`);
      }
    }
  }, POLL_INTERVAL_MS);
}

function stopScanner() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    lastTopCardId = null;
    isProcessingCard = false;
  }
}

// ── Find cards & scan ────────────────────────────────────
function findLeadCards(root = document) {
  const isValidCard = (el) => {
    if (el.closest('.secshimmer, .backgroundshimmer, [class*="shimmer"]')) return false;
    return el.querySelector('input[name="ofrtitle"]') || el.querySelector('.prod-name, .bl_lsting_title') || normalizeText(el.textContent || '').length > 20;
  };

  if (cachedCardSelector) {
    const cachedCards = Array.from(root.querySelectorAll(cachedCardSelector)).filter(isValidCard);
    if (cachedCards.length) return cachedCards;
    cachedCardSelector = null;
  }

  for (const sel of CARD_SELECTORS) {
    const cards = Array.from(root.querySelectorAll(sel)).filter(isValidCard);
    if (cards.length) {
      cachedCardSelector = sel;
      return cards;
    }
  }
  return [];
}

function reloadSettingsAndScanner(cb) {
  if (settingsReloadTimer) clearTimeout(settingsReloadTimer);
  settingsReloadTimer = setTimeout(() => {
    stopScanner();
    loadSettings(() => {
      if (isEnabled && !limitReached()) {
        startScanner();
      } else {
        stopScanner();
      }
      if (cb) cb();
    });
  }, 120);
}

// ── Message listener ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'SETTINGS_UPDATED') {
    reloadSettingsAndScanner(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'GET_STATUS') {
    sendResponse({ enabled: isEnabled, keywords, pickedCount, leadLimit });
  } else if (msg.type === 'RESET_COUNT') {
    pickedCount = 0;
    chrome.storage.sync.set({ pickedCount: 0 });
    sendResponse({ ok: true });
  }
});

// ── Init ─────────────────────────────────────────────────
loadSettings(() => {
  if (isEnabled && !limitReached()) {
    console.log('[BuyLead] 🚀 Bot is active and watching...');
    startScanner();
  } else {
    console.log('[BuyLead] ⏸ Bot is disabled or limit reached. Update settings in popup to start.');
  }
});

// SPA nav detection
function handleNavigationChange() {
  if (location.href !== lastHandledUrl) {
    lastHandledUrl = location.href;
    console.log('[BuyLead] 🔄 Navigation detected. Resetting scanner.');
    stopScanner();
    setTimeout(() => {
      if (isEnabled && settingsReady && !limitReached()) startScanner();
    }, 300);
  }
}

window.addEventListener('popstate', handleNavigationChange);
const originalPushState = history.pushState;
history.pushState = function patchedPushState(...args) {
  const result = originalPushState.apply(this, args);
  handleNavigationChange();
  return result;
};
const originalReplaceState = history.replaceState;
history.replaceState = function patchedReplaceState(...args) {
  const result = originalReplaceState.apply(this, args);
  handleNavigationChange();
  return result;
};

setInterval(handleNavigationChange, 300);
