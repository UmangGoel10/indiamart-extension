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
});

// ── Save & push to content script ─────────────────────────────
function save() {
  chrome.storage.sync.set({ keywords, enabled, leadLimit, pickedCount }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_UPDATED' }).catch(() => {});
      }
    });
  });
}

// ── Toggle ─────────────────────────────────────────────────────
toggle.addEventListener('change', () => {
  enabled = toggle.checked;
  updateStatus();
  save();
});

// ── Lead limit input ───────────────────────────────────────────
leadLimitInput.addEventListener('change', () => {
  const val = parseInt(leadLimitInput.value) || 0;
  leadLimit = val < 0 ? 0 : val;
  leadLimitInput.value = leadLimit || '';
  updateProgress();
  save();
});

// ── Reset counter ──────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  pickedCount = 0;
  chrome.storage.sync.set({ pickedCount: 0 });
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
    updateProgress();
  }
  if (msg.type === 'LIMIT_REACHED') {
    pickedCount = msg.pickedCount;
    enabled = false;
    toggle.checked = false;
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
