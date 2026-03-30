# IndiaMart BuyLead Auto-Picker — Chrome Extension

Automatically monitors IndiaMart's BuyLeads section and clicks "Contact Buyer Now"
on any lead that contains your keywords.

---

## Installation (Developer Mode)

1. Open Chrome and go to: `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `indiamart-extension` folder
5. The extension icon will appear in your toolbar

---

## How to Use

1. Log in to `seller.indiamart.com`
2. Navigate to the **BuyLeads** section
3. Click the extension icon in the toolbar
4. Add your **keywords** (e.g. "steel", "pipe fittings", "flanges")
5. Toggle **Auto-Accept Mode ON**
6. Keep the tab open — it will auto-click "Contact Buyer Now" on every matching lead

---

## ⚠️ Important Notes

### Finding the Right Selectors
IndiaMart updates their DOM occasionally. If auto-click stops working:
1. Open `seller.indiamart.com/buyleads/`
2. Right-click a lead card → **Inspect**
3. Find the card's CSS class (e.g. `.lead-card-wrapper`)
4. Open `content.js` and add the class to the `cardSelectors` array

### Accept Button Label
The extension tries multiple button labels:
- "Contact Buyer Now"
- "Accept"
- "Pick Lead"
- "Consume"
- "Get Contact"
- "View Contact"

If IndiaMart uses a different label, add it to `acceptPatterns` in `content.js`.

### Single Page App (SPA) Handling
IndiaMart is a React SPA. The extension auto-detects URL changes
and re-scans every time you navigate to a new section.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config & permissions |
| `content.js` | DOM observer + keyword matching + click logic |
| `popup.html/js` | UI to manage keywords and on/off toggle |
| `background.js` | Service worker for browser notifications |

---

## Troubleshooting

**Extension not firing?**
- Make sure you're on `seller.indiamart.com` (not `www.indiamart.com`)
- Check the browser console (F12) for `[BuyLead Bot]` logs
- Ensure the toggle is ON and keywords are added

**Button not found?**
- Inspect the accept button and note its exact text
- Add that text as a pattern in `content.js` → `acceptPatterns`
# indiamart-extension
