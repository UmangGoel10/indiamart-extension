// popup.js — v3 with lead limit

const toggle        = document.getElementById('enableToggle');
const keywordInput  = document.getElementById('keywordInput');
const addBtn        = document.getElementById('addBtn');
const keywordList   = document.getElementById('keywordList');
const emptyMsg      = document.getElementById('emptyMsg');
const statusDot     = document.getElementById('statusDot');
const statusText    = document.getElementById('statusText');
const leadLimitInput= document.getElementById('leadLimitInput');
const countLabel    = document.getElementById('countLabel');
const progressFill  = document.getElementById('progressFill');
const resetBtn      = document.getElementById('resetBtn');
const limitBanner   = document.getElementById('limitBanner');

let keywords    = [];
let enabled     = false;
let leadLimit   = 0;
let pickedCount = 0;
const DEBUG = true;

function logPopup(msg, meta) {
  if (!DEBUG) return;
  if (meta !== undefined) console.log(`[BuyLead][POPUP] ${msg}`, meta);
  else console.log(`[BuyLead][POPUP] ${msg}`);
}

function warnPopup(msg, meta) {
  if (meta !== undefined) console.warn(`[BuyLead][POPUP] ${msg}`, meta);
  else console.warn(`[BuyLead][POPUP] ${msg}`);
}

function normalizeErrorMessage(err) {
  if (!err) return 'unknown-error';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function isEligibleSellerTab(tab) {
  const url = tab?.url || '';
  return /^https:\/\/seller\.indiamart\.com\//i.test(url);
}

function isExpectedTransientSendError(msg) {
  const m = (msg || '').toLowerCase();
  return (
    m.includes('receiving end does not exist') ||
    m.includes('message port closed') ||
    m.includes('could not establish connection')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushSettingsUpdate(retries = 3, delayMs = 250) {
  logPopup('Pushing SETTINGS_UPDATED to active tab.', { retries, delayMs });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id) {
    logPopup('Skipping SETTINGS_UPDATED: no active tab id found.');
    return false;
  }

  if (!isEligibleSellerTab(tab)) {
    logPopup('Skipping SETTINGS_UPDATED: active tab is not seller.indiamart.com.', { url: tab.url || null });
    return false;
  }

  const tabId = tab.id;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_UPDATED' });
      if (res?.ok) {
        logPopup('SETTINGS_UPDATED acknowledged by content script.', { attempt, tabId });
        return true;
      }
      warnPopup('SETTINGS_UPDATED did not return ok. Retrying if attempts remain.', { attempt, tabId, res });
    } catch (err) {
      const msg = normalizeErrorMessage(err);
      const meta = { attempt, tabId, error: msg };
      // These are expected while tab/content script is reloading; keep them as info.
      if (isExpectedTransientSendError(msg)) {
        logPopup('SETTINGS_UPDATED send deferred due to transient tab/content state.', meta);
      } else {
        warnPopup('SETTINGS_UPDATED send failed.', meta);
      }
    }

    if (attempt < retries) await sleep(delayMs);
  }
  warnPopup('SETTINGS_UPDATED exhausted retries without acknowledgement.');
  return false;
}

// ── Load from storage ─────────────────────────────────────────
chrome.storage.sync.get(['keywords', 'enabled', 'leadLimit', 'pickedCount'], (data) => {
  keywords    = data.keywords    || [];
  enabled     = data.enabled     || false;
  leadLimit   = data.leadLimit   !== undefined ? parseInt(data.leadLimit) : 0;
  pickedCount = data.pickedCount !== undefined ? parseInt(data.pickedCount) : 0;

  toggle.checked       = enabled;
  leadLimitInput.value = leadLimit || '';

  renderKeywords();
  updateProgress();
  updateStatus();
  logPopup('Popup initialized from storage.', {
    enabled,
    keywordCount: keywords.length,
    leadLimit: leadLimit || '∞',
    pickedCount
  });
});

// ── Save & push to content script ─────────────────────────────
function save() {
  chrome.storage.sync.set({ keywords, enabled, leadLimit, pickedCount }, () => {
    logPopup('Saved popup state to storage.', {
      enabled,
      keywordCount: keywords.length,
      leadLimit: leadLimit || '∞',
      pickedCount
    });
    pushSettingsUpdate();
  });
}

// ── Toggle ─────────────────────────────────────────────────────
toggle.addEventListener('change', () => {
  enabled = toggle.checked;
  logPopup('Enable toggle changed.', { enabled });
  updateStatus();
  save();
});

// ── Lead limit input ───────────────────────────────────────────
leadLimitInput.addEventListener('change', () => {
  const val = parseInt(leadLimitInput.value) || 0;
  leadLimit = val < 0 ? 0 : val;
  leadLimitInput.value = leadLimit || '';
  logPopup('Lead limit changed.', { leadLimit: leadLimit || '∞' });
  updateProgress();
  save();
});

// ── Reset counter ──────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  pickedCount = 0;
  chrome.storage.sync.set({ pickedCount: 0 });
  logPopup('Reset counter clicked.');
  // Also tell content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'RESET_COUNT' }).catch(() => {});
    }
  });
  // Re-enable if it was auto-disabled
  if (!enabled) {
    enabled = true;
    toggle.checked = true;
    save();
  }
  updateProgress();
  updateStatus();
});

// ── Listen for live count updates from content script ─────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'COUNT_UPDATED') {
    pickedCount = msg.pickedCount;
    leadLimit   = msg.leadLimit;
    logPopup('COUNT_UPDATED received.', { pickedCount, leadLimit: leadLimit || '∞' });
    updateProgress();
  }
  if (msg.type === 'LIMIT_REACHED') {
    pickedCount = msg.pickedCount;
    enabled = false;
    toggle.checked = false;
    warnPopup('LIMIT_REACHED received. Popup set to disabled.', { pickedCount });
    updateProgress();
    updateStatus();
  }
  sendResponse({ ok: true });
  return true;
});

// Keep popup state in sync with storage even if runtime messages are missed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.pickedCount) pickedCount = parseInt(changes.pickedCount.newValue, 10) || 0;
  if (changes.leadLimit) leadLimit = parseInt(changes.leadLimit.newValue, 10) || 0;
  if (changes.enabled) {
    enabled = changes.enabled.newValue === true;
    toggle.checked = enabled;
  }
  logPopup('Storage change observed in popup.', {
    pickedCount,
    leadLimit: leadLimit || '∞',
    enabled
  });
  updateProgress();
  updateStatus();
});

// ── Progress bar & counter ─────────────────────────────────────
function updateProgress() {
  const lim = leadLimit > 0 ? leadLimit : 0;
  const pct = lim > 0 ? Math.min((pickedCount / lim) * 100, 100) : 0;

  countLabel.textContent = lim > 0 ? `${pickedCount} / ${lim}` : `${pickedCount} / ∞`;
  progressFill.style.width = pct + '%';

  // Colour coding
  progressFill.classList.remove('warning', 'danger');
  if (pct >= 100)     progressFill.classList.add('danger');
  else if (pct >= 75) progressFill.classList.add('warning');

  // Banner
  const reached = lim > 0 && pickedCount >= lim;
  limitBanner.classList.toggle('show', reached);
}

// ── Add keyword ────────────────────────────────────────────────
function addKeyword() {
  const kw = keywordInput.value.trim().toLowerCase();
  if (!kw || keywords.includes(kw)) { keywordInput.value = ''; return; }
  keywords.push(kw);
  keywordInput.value = '';
  renderKeywords();
  save();
}

addBtn.addEventListener('click', addKeyword);
keywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });

function removeKeyword(kw) {
  keywords = keywords.filter(k => k !== kw);
  renderKeywords();
  save();
}

// ── Render keyword tags ────────────────────────────────────────
function renderKeywords() {
  keywordList.querySelectorAll('.keyword-tag').forEach(el => el.remove());
  emptyMsg.style.display = keywords.length === 0 ? 'inline' : 'none';
  keywords.forEach(kw => {
    const tag = document.createElement('div');
    tag.className = 'keyword-tag';
    tag.innerHTML = `<span>${kw}</span><span class="remove" title="Remove">✕</span>`;
    tag.querySelector('.remove').addEventListener('click', () => removeKeyword(kw));
    keywordList.appendChild(tag);
  });
}

// ── Status bar ─────────────────────────────────────────────────
function updateStatus() {
  const lim = leadLimit > 0 ? leadLimit : 0;
  const reached = lim > 0 && pickedCount >= lim;

  statusDot.classList.remove('active', 'stopped');

  if (reached) {
    statusDot.classList.add('stopped');
    statusText.textContent = `Limit of ${lim} reached — reset to continue`;
  } else if (enabled) {
    statusDot.classList.add('active');
    statusText.textContent = keywords.length > 0
      ? `Watching for ${keywords.length} keyword${keywords.length > 1 ? 's' : ''}...`
      : 'Active — add keywords to start';
  } else {
    statusText.textContent = 'Paused — toggle on to activate';
  }
}
