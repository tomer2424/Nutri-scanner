# Nutri Scanner

A prototype: enter a weight in grams, scan a food product's barcode, and get the nutrition values scaled to that weight. Data comes from [Open Food Facts](https://world.openfoodfacts.org/).

Plain HTML, CSS and vanilla JS. No build step, no dependencies to install — the repo root *is* the site.

**Live:** https://tomer2424.github.io/Nutri-scanner/

## Running it locally

```bash
python -m http.server 8000
# then open http://localhost:8000
```

`localhost` counts as a secure context, so the camera works there. Opening the same server over your LAN address (`http://192.168.x.x:8000`) will **not** work — see below.

## Tests

```bash
node test/run.mjs             # 63 checks, including the live API contract
node test/run.mjs --offline   # 59 checks, no network needed
```

No dependencies and no test framework — just Node. `app.js` exports nothing and touches the DOM at load, so [test/harness.mjs](test/harness.mjs) stubs the handful of browser APIs it uses, imports **the real file**, fires the listeners it registered, and reads back what it rendered. Nothing in the suite reimplements the app's logic, so a check passing means the shipped code works.

Two deliberate choices worth knowing before you extend it:

- **Arithmetic runs against a recorded fixture**, not the live database. Open Food Facts is crowd-sourced and editable; if someone corrects Nutella's entry, asserting `270 kcal` against the live API would fail for reasons that have nothing to do with our code. The live API is still checked, but for its *contract* — that `status: 1` still comes back and all eight nutriment keys `app.js` reads are still present and numeric. That's the thing that would otherwise break silently.
- **The harness loads `app.js` as a copied `.mjs`.** This isn't incidental. The repo has no `package.json`, so Node treats a bare `.js` as CommonJS, and the CJS cache keys on filename alone — `?v=` cache-busting is silently ignored, the module never re-executes, and a "reload" test passes by reading stale text. That exact false pass hid a real bug during development. For the same reason, any check that reads rendered text after a reload should scribble a sentinel over it first, so "unchanged" can't masquerade as "correctly re-rendered".

The suite covers input validation, scaling, kJ→kcal conversion, UPC-A/EAN-13 normalisation in both directions, the daily counter, saved quick-add meals (including id collisions under a frozen clock, malformed stored rows, and untrusted product names), persistence (corrupt storage, a throwing `setItem`), reset, and every error path.

## The HTTPS requirement

Both iOS Safari and Android Chrome expose `navigator.mediaDevices` only in a secure context. A plain `http://` address — including a LAN IP — gives the browser no camera access at all, and the failure is quiet. That's why the app is deployed to GitHub Pages rather than served off a laptop.

If you see *"Camera needs a secure (HTTPS) connection"*, this is why.

## Deploying

Pushing to `main` triggers [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which runs the tests and then publishes to GitHub Pages.

**One-time setup:** repo **Settings → Pages → Source → GitHub Actions**. The first workflow run fails without it.

Three jobs:

| Job | Gates the deploy? | What it runs |
| --- | --- | --- |
| `test` | **yes** | `node test/run.mjs --offline` |
| `contract` | no | `node test/run.mjs` (live API) |
| `deploy` | — | stages the site and publishes it |

The gate is the **offline** suite on purpose. It's fixture-backed and deterministic, so a red build always means our code broke — never that Open Food Facts had a blip. The live contract check still runs on every push, but as a non-blocking job, because a third party's uptime shouldn't be able to veto a deploy. If `contract` goes red while `test` stays green, the API changed shape and the fixture needs re-recording.

**`test/` is not published.** The deploy stages an allowlist by extension (`*.html *.js *.css *.webmanifest *.png`, top-level only), so test files and `.github/` are excluded by construction rather than by an exclude list that drifts. An unmatched glob or a missing `index.html` fails the step loudly. The consequence: if you add an asset in a *subdirectory*, add it to the staging step or it won't ship.

## How the scanner picks an engine

Barcode decoding is the fragile part of this prototype, and the two target phones fail in different ways:

- **iOS Safari has no `BarcodeDetector` at all** — it's disabled by default through Safari 26.6, and every iOS browser is WebKit underneath.
- **Android Chrome has one, but it delegates to Google Play Services.** When Play Services is missing — China-ROM or de-Googled Xiaomi devices — the spec requires `getSupportedFormats()` to resolve to an *empty array* and `detect()` to reject. The API is present but dead.

So the app doesn't check whether `BarcodeDetector` exists. It probes `getSupportedFormats()` for `ean_13`, and falls back to a WebAssembly decoder ([`barcode-detector`](https://github.com/Sec-ant/barcode-detector), which wraps `zxing-wasm`) when native isn't usable. It can also demote from native to wasm mid-scan, covering the case where Play Services reports formats before its barcode module has finished downloading.

The line at the bottom of the screen shows which engine is live:

| Reading | Meaning |
| --- | --- |
| `engine: native` | Platform decoder (expected on a Redmi with Play Services) |
| `engine: wasm` | WebAssembly decoder (expected on any iPhone) |
| `engine: wasm (demoted from native)` | Native claimed support, then failed — fallback worked |
| `engine: unavailable` | Neither could load; manual entry still works |

The wasm decoder is fetched from jsDelivr on first load (~1 MB) and warmed up before the camera opens.

## Daily counter

The home screen shows running totals for calories and protein. On a results screen, **Add to Daily Total** adds the current item and returns you home with the totals updated. Totals are kept in `localStorage`, so they survive refreshes and relaunching the installed app.

**There is no midnight rollover.** Totals run until you press **Reset Counter** (which asks for confirmation first), however many days that spans — so "daily" is your discipline, not the app's. This is deliberate, not an oversight.

There's no undo either: a mis-tap can only be cleared by resetting the whole counter. The Add button returns straight home, so a double-tap can't land twice.

Two details worth knowing:

- **Totals add the rounded numbers you saw, not full precision.** 50 g of Nutella is 269.5 kcal, displayed as `270`. Add it twice and you get `540`, not `539`. Totalling the exact values would be marginally more accurate but would contradict arithmetic you can do in your head, which reads as a bug. The cost is at most 0.5 kcal per item — noise next to crowd-sourced data and an eyeballed weight.
- **A missing nutrient contributes 0.** If a product has no protein figure, the results screen shows `—` and adding it contributes 0 g of protein rather than breaking the total.

In iOS Safari Private Browsing, `localStorage` writes throw. The counter still works for the session; it just won't persist.

## Saved quick-add meals

**Save as Quick Add** on a results screen stores the product and that portion weight as a one-tap button on the home screen — `Nutella — 50g (270 kcal, 3.1g)`. Tapping it adds those values to the daily total without rescanning; the `✕` beside it deletes that meal immediately, with no confirmation.

A quick-add runs through the same `creditTotals()` call as the Add button, and the saved figures were produced by the same `displayed()` rounding, so adding a saved meal lands on exactly the same total as scanning the item and adding it live. A test asserts that.

Two notes:

- **The list renders from memory, not from storage on every visit.** The addendum specified re-reading storage on each return to the home screen. That would lose data in iOS Private Browsing, where writes throw: the meal you just saved would vanish the moment the app returned home. The array is loaded once at startup and written on every change, so a saved meal survives the session even when storage is unavailable — like the daily totals already do.
- **Stored under `nutri-scanner-meals`**, not a bare `savedMeals`. Every GitHub Pages project on `tomer2424.github.io` shares one origin and therefore one `localStorage`, so an unnamespaced key would be a live collision risk with any other app published there.

Product names come from Open Food Facts, which anyone can edit, and they're persisted and re-rendered on every visit home. Everything goes in via `textContent` and names are capped at 60 characters; a test saves a name containing `<img onerror=...>` and asserts it renders as inert literal text.

## Manual barcode entry

The idle screen has an **Enter barcode manually** link. It's there on purpose, not as a nicety: it drives the exact same lookup and calculation path with the camera out of the loop, so when something breaks you can tell which half is at fault. It also rescues barcodes the decoder simply won't read.

## Testing checklist

On desktop:

1. Weight validation — empty, `0`, `-5`, `abc`, `99999` all show an inline error and never open the camera.
2. Manual entry `3017620422003` at 50 g → ~270 kcal, "Nutella", thumbnail loads.
3. Change grams on the results screen → numbers update with no network request.
4. Manual entry `0000000000000` → "Product not found in database."
5. DevTools → Offline → any lookup → "Network error, please try again."
6. Deny camera permission → a real message, not a dead screen.
7. In the console, run `BarcodeDetector.getSupportedFormats = async () => []` **before** the page finishes loading to simulate a Play-Services-less Redmi. The diagnostics line should read `engine: wasm` and scanning should still work. Worth doing deliberately — it's the one failure mode you can't reproduce on a phone that happens to have Play Services.
8. Add `3017620422003` at 50 g twice → totals read `540 kcal` / `6.2 g`, matching the `270` / `3.1` shown each time.
9. Refresh the page → totals are still there. Reset Counter → cancel leaves them alone, confirm zeroes them.

On both phones:

| | iPhone (Safari) | Redmi (Chrome) |
| --- | --- | --- |
| Engine | expect `wasm` | expect `native` |
| Scan 3–4 real products | note time-to-decode and failures | same — compare against the iPhone |
| Permissions | Safari's prompt | Chrome's prompt **and** MIUI's own permission manager |
| Install | Add to Home Screen | Chrome should offer "Install app" |
| Counter persists | add two items, force-quit, reopen from the icon | same |

Do the scanning tests in normal indoor light. There's no torch button, so what you get is the honest baseline.

## Known limitations

- **1D decode accuracy is the weak link.** Open-source decoders read EAN-13 at roughly 78% *per frame* and degrade sharply on blur. Scanning continuously hides much of that, but a crumpled or dimly-lit barcode may never read.
- **Open Food Facts is crowd-sourced.** Israeli and store-brand products are patchily covered. A missing product is a data gap, not a bug — the app says so explicitly, and distinguishes it from a product that exists but has no nutrition facts filled in.
- **Values are per 100 g.** Drinks are per 100 ml; the app flags this but treats grams and millilitres as equivalent.
- The service worker caches nothing. It exists only so Chrome will offer to install the app.
