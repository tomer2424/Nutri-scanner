# Nutri Scanner

A prototype: scan a food product's barcode, then enter how many grams you're eating and get the nutrition values scaled to that weight. Data comes from [Open Food Facts](https://world.openfoodfacts.org/).

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
node test/run.mjs             # 181 checks, including the live API contract
node test/run.mjs --offline   # 177 checks, no network needed
```

No dependencies and no test framework — just Node. `app.js` exports nothing and touches the DOM at load, so [test/harness.mjs](test/harness.mjs) stubs the handful of browser APIs it uses, imports **the real file**, fires the listeners it registered, and reads back what it rendered. Nothing in the suite reimplements the app's logic, so a check passing means the shipped code works.

Two deliberate choices worth knowing before you extend it:

- **Arithmetic runs against a recorded fixture**, not the live database. Open Food Facts is crowd-sourced and editable; if someone corrects Nutella's entry, asserting `270 kcal` against the live API would fail for reasons that have nothing to do with our code. The live API is still checked, but for its *contract* — that `status: 1` still comes back and all eight nutriment keys `app.js` reads are still present and numeric. That's the thing that would otherwise break silently.
- **The harness loads `app.js` as a copied `.mjs`.** This isn't incidental. The repo has no `package.json`, so Node treats a bare `.js` as CommonJS, and the CJS cache keys on filename alone — `?v=` cache-busting is silently ignored, the module never re-executes, and a "reload" test passes by reading stale text. That exact false pass hid a real bug during development. For the same reason, any check that reads rendered text after a reload should scribble a sentinel over it first, so "unchanged" can't masquerade as "correctly re-rendered".

The suite covers the scan-first flow end to end (a stubbed camera and `BarcodeDetector` walk it through idle → scanning → loading → results → credited), weight validation on the results screen, scaling, kJ→kcal conversion, UPC-A/EAN-13 normalisation in both directions, the daily counter, the daily log (logging from both add routes, delete-decrements-total, zero clamping, and the counter-equals-log-sum invariant), saved quick-add meals (including id collisions under a frozen clock, malformed stored rows, and untrusted product names), persistence (corrupt storage, a throwing `setItem`), reset, and every error path.

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

### Asset versioning (don't remove this)

`index.html` references `app.js?v=dev` and `styles.css?v=dev`; CI rewrites `?v=dev` to the commit SHA when publishing, and fails the build if the rewrite doesn't land.

This is load-bearing. GitHub Pages serves every file with `Cache-Control: max-age=600` and caches each one independently, so without it a deploy can leave a browser holding a **fresh `index.html` and a ten-minute-old `app.js`** — new markup renders, the code wiring it up is missing, and nothing logs an error. New buttons just silently do nothing. Versioning means fresh HTML always requests a URL no cache has seen, while stale HTML keeps requesting the matching stale JS. Consistent either way; mixed state was the bug.

**A service worker cannot do this job** — worth recording, because it's the obvious first attempt. Instrumenting the worker showed it *does* receive the `script /app.js` fetch event on a cold load, and its `cache: "reload"` fetch never fails. But on a later load Chrome serves cached scripts and stylesheets **without dispatching a fetch event at all**; the navigation, manifest and icons still reach the worker, scripts don't. [sw.js](sw.js) now force-revalidates the same-origin requests it does see, which keeps `index.html` itself fresh so a new version stamp takes effect on the next load — but the stamp is what fixes it.

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

## Daily counter and goals

The home screen shows running totals for **calories, protein, carbs and fat**, each against a daily target, with a progress bar underneath. **Edit Goals** opens an inline form to set your own targets; they're stored in `nutri-scanner-targets` and default to 2000 kcal / 150 g / 250 g / 70 g. Targets are settings, not daily data, so Reset Counter leaves them alone.

Bars cap at 100% so an overshoot can't paint outside the track — the card still shows the real number (`30.9 / 30 g`), and a filled bar is outlined to mark the goal as met.

The four metrics are declared once in a `MACROS` list in [app.js](app.js), and totals, saved meals, log entries, targets and the cards all iterate it. That's deliberate: with four metrics hand-written in five places, crediting one and forgetting another is the obvious bug, and this makes it unexpressible.

Scanning starts straight from the home screen; the weight is entered on the results screen once the product is identified. It defaults to **100 g** — the label basis, so the first numbers you see match the pack — and every figure recalculates as you type, from the cached product with no refetch. An empty, zero, negative or over-10 000 g value shows an inline error, blanks the figures to `—`, and disables Add and Save; the handlers check too, so the disabled state isn't the only guard.

On a results screen, **Add to Daily Total** adds the current item at the entered weight and returns you home with the totals updated. Totals are kept in `localStorage`, so they survive refreshes and relaunching the installed app.

**Legacy data is read, not discarded.** Totals saved before carbs and fat existed used `{ kcal, protein }`; those calories are carried across rather than silently zeroing a counter mid-day, and saved meals or log entries missing carbs/fat read as 0 instead of `NaN`.

The goals form carries `novalidate` on purpose. The app does its own validation with specific inline messages; without it the browser's native constraint check fires first on `min` violations and suppresses ours, which also made the browser and the test suite exercise different paths.

**There is no midnight rollover.** Totals run until you press **Reset Counter** (which asks for confirmation first), however many days that spans — so "daily" is your discipline, not the app's. This is deliberate, not an oversight.

There's no undo either: a mis-tap can only be cleared by resetting the whole counter. The Add button returns straight home, so a double-tap can't land twice.

Two details worth knowing:

- **Totals add the rounded numbers you saw, not full precision.** 50 g of Nutella is 269.5 kcal, displayed as `270`. Add it twice and you get `540`, not `539`. Totalling the exact values would be marginally more accurate but would contradict arithmetic you can do in your head, which reads as a bug. The cost is at most 0.5 kcal per item — noise next to crowd-sourced data and an eyeballed weight.
- **A missing nutrient contributes 0.** If a product has no protein figure, the results screen shows `—` and adding it contributes 0 g of protein rather than breaking the total.

In iOS Safari Private Browsing, `localStorage` writes throw. The counter still works for the session; it just won't persist.

## Today's log

Every item credited to the counter — from a scan or a quick-add — is logged under **Today's Log** on the home screen, newest first. The `✕` beside an entry removes it *and* subtracts its calories and protein back out of the counter.

The log is written inside `creditTotals()`, the single function both add routes call, so an item cannot be credited without being logged. That's what makes the two reconcilable, and a test asserts the counter always equals the sum of the log — including after a delete.

- **"Today" means "since you last reset"**, same as the counter. There's no midnight rollover, deliberately. Reset Counter clears the totals and the log together.
- **Subtraction clamps at zero.** The counter is a running sum of rounded values, so a long sequence of adds and deletes shouldn't be able to leave a stray `-0.1` on screen.
- **The list is capped and scrolls** at ~210px. The addendum places it directly under the counter, which is above the scan button; without a cap a long log would push the main action off-screen. Verified at iPhone viewport: with six entries the scan button still sits at 597px in a 749px viewport.

Stored under `nutri-scanner-history`, with the same validation and iOS Private Browsing guards as the other two keys.

## Saved quick-add meals

**Save as Quick Add** on a results screen stores the product and that portion weight as a one-tap button on the home screen — `Nutella — 50g (270 kcal, 3.1g)`. Tapping it adds those values to the daily total without rescanning; the `✕` beside it deletes that meal immediately, with no confirmation.

A quick-add runs through the same `creditTotals()` call as the Add button, and the saved figures were produced by the same `displayed()` rounding, so adding a saved meal lands on exactly the same total as scanning the item and adding it live. A test asserts that.

Two notes:

- **The list renders from memory, not from storage on every visit.** The addendum specified re-reading storage on each return to the home screen. That would lose data in iOS Private Browsing, where writes throw: the meal you just saved would vanish the moment the app returned home. The array is loaded once at startup and written on every change, so a saved meal survives the session even when storage is unavailable — like the daily totals already do.
- **Stored under `nutri-scanner-meals`**, not a bare `savedMeals`. Every GitHub Pages project on `tomer2424.github.io` shares one origin and therefore one `localStorage`, so an unnamespaced key would be a live collision risk with any other app published there.

Product names come from Open Food Facts, which anyone can edit, and they're persisted and re-rendered on every visit home. Everything goes in via `textContent` and names are capped at 60 characters; a test saves a name containing `<img onerror=...>` and asserts it renders as inert literal text.

## Custom manual entry

**Add a custom item** on the home screen logs something with no barcode and no API lookup: an optional name plus calories, protein, carbs and fat. Blank macro fields count as 0; negative or non-numeric values are rejected inline, and an entirely blank submission is refused rather than adding a meaningless `0 kcal` row. A checkbox optionally saves the item as a Quick Add at the same time.

It calls the same `creditTotals()` as a scan, so the totals, the progress bars and Today's Log all update through one path with no separate bookkeeping.

Custom items have no portion weight, so row labels omit it — `Homemade Soup (250 kcal, 20g)` rather than `— 0g`, which would read as a measurement instead of an absence. `itemLabel()` is shared by log rows and saved meals, so both render consistently.

The name is untrusted input and goes in via `textContent`, capped at 60 characters. A browser test logs a name containing an `onerror` payload and asserts the row has zero child elements and the handler never fired.

## Manual barcode entry

The idle screen has an **Enter barcode manually** link. It's there on purpose, not as a nicety: it drives the exact same lookup and calculation path with the camera out of the loop, so when something breaks you can tell which half is at fault. It also rescues barcodes the decoder simply won't read.

## Testing checklist

On desktop:

1. Manual entry `3017620422003` → "Nutella", thumbnail loads, grams default to 100 → ~539 kcal.
2. Change grams to 50 → ~270 kcal, updating as you type, with no network request.
3. Weight validation on the results screen — empty, `0`, `-5`, `99999` each show an inline error, grey out Add and Save, and blank the figures to `—`.
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
