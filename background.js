// background.js — Service Worker

let countUpdateQueue = Promise.resolve();
const DEBUG = true;

function logBg(msg, meta) {
  if (!DEBUG) return;
  if (meta !== undefined) console.log(`[BuyLead][BG] ${msg}`, meta);
  else console.log(`[BuyLead][BG] ${msg}`);
}

function warnBg(msg, meta) {
  if (meta !== undefined) console.warn(`[BuyLead][BG] ${msg}`, meta);
  else console.warn(`[BuyLead][BG] ${msg}`);
}

function queueCountIncrement(sendResponse) {
  countUpdateQueue = countUpdateQueue
    .then(() => new Promise((resolve) => {
      logBg('INCREMENT_COUNT dequeued. Reading storage...');
      chrome.storage.sync.get(['pickedCount', 'leadLimit'], (d) => {
        if (chrome.runtime.lastError) {
          warnBg('Storage read failed during increment.', chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          resolve();
          return;
        }

        const current = parseInt(d.pickedCount, 10) || 0;
        const limit = parseInt(d.leadLimit, 10) || 0;
        const next = current + 1;
        const reached = limit > 0 && next >= limit;
        const update = reached ? { pickedCount: next, enabled: false } : { pickedCount: next };
        logBg('Applying increment update.', { current, next, limit: limit || '∞', reached });

        chrome.storage.sync.set(update, () => {
          if (chrome.runtime.lastError) {
            warnBg('Storage write failed during increment.', chrome.runtime.lastError.message);
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            logBg('Increment update committed.', { pickedCount: next, leadLimit: limit || '∞', reached });
            sendResponse({ ok: true, pickedCount: next, leadLimit: limit, reached });
          }
          resolve();
        });
      });
    }))
    .catch((e) => {
      warnBg('Unexpected increment queue error.', String(e));
      sendResponse({ ok: false, error: String(e) });
    });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === 'NOTIFY') {
    logBg('NOTIFY received.', { title: msg.title || 'BuyLead Bot' });
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: msg.title || 'BuyLead Bot',
      message: msg.message || '',
      priority: 2
    });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'INCREMENT_COUNT') {
    logBg('INCREMENT_COUNT received. Queueing increment request.');
    queueCountIncrement(sendResponse);
    return true;
  }
});
