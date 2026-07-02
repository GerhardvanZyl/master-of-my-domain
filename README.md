# Domain Shortlist+

A Chrome (Manifest V3) extension for domain.com.au that adds:

- **Sort your shortlist** by My rating, Date listed, Price, Date shortlisted, or Price reduced — order persists across visits.
- **Notes on cards** — your saved notes show on each shortlist card (4-line clamp, hover to see all), with a global Show/Hide toggle.
- **Star ratings** — rate properties 1–5; stored locally (Domain has no rating feature).
- **Notes on the map** — your notes also appear on map view (`?displaymap=1`) cards.

## Price reduction — how it works

Domain doesn't expose price history on the shortlist page (it only fetches
"price last month" when you open an individual listing). So "Price reduced"
tracks the price each time you view your shortlist and flags drops **from the
first price this extension saw** — reductions going forward, not historical
ones. No Domain API calls, so it can't break when Domain changes its site.

## Load it

1. Visit `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open https://www.domain.com.au/user/shortlist (logged in).

## Tests

```
node test/lib.test.js
node test/pricesnap.test.js
```
