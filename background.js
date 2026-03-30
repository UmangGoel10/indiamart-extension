// background.js — Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NOTIFY') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: msg.title || 'BuyLead Bot',
      message: msg.message || '',
      priority: 2
    });
  }
});
