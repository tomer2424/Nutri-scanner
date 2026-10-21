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

## The HTTPS requirement

Both iOS Safari and Android Chrome expose `navigator.mediaDevices` only in a secure context. A plain `http://` address — including a LAN IP — gives the browser no camera access at all, and the failure is quiet. That's why the app is deployed to GitHub Pages rather than served off a laptop.

If you see *"Camera needs a secure (HTTPS) connection"*, this is why.

## Deploying

Pushing to `main` triggers `.github/workflows/deploy.yml`, which publishes the repo root to GitHub Pages.

**One-time setup:** repo **Settings → Pages → Source → GitHub Actions**. The first workflow run fails without it.

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
