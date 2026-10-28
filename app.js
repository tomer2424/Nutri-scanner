// Nutri Scanner — barcode → Open Food Facts → nutrition scaled to a weight.

const WASM_PONYFILL =
  "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/es/ponyfill.min.js";

const API_BASE = "https://world.openfoodfacts.org/api/v2/product/";
const API_FIELDS = [
  "product_name", "product_name_en", "brands", "image_small_url",
  "quantity", "nutriments", "nutrition_data_per", "serving_size",
].join(",");

const WANTED_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const SCAN_INTERVAL_MS = 100;
const BAND_FRACTION = 0.4;   // centre slice of the frame we actually decode
const FETCH_TIMEOUT_MS = 10000;
const MAX_GRAMS = 10000;
const DEFAULT_GRAMS = "100";   // the label basis, so the first numbers match the pack
// Namespaced because every GitHub Pages project under the same account shares
// one origin, and therefore one localStorage. A bare "savedMeals" would be a
// live collision risk with any other app published there.
const TOTALS_KEY = "nutri-scanner-totals";
const MEALS_KEY = "nutri-scanner-meals";
const HISTORY_KEY = "nutri-scanner-history";
const TARGETS_KEY = "nutri-scanner-targets";
const ADDED_FEEDBACK_MS = 800;
const MAX_MEAL_NAME = 60;
const MAX_TARGET = 100000;

// The four tracked macros, declared once. Totals, saved meals, log entries,
// targets and the progress cards all iterate this list, so a metric cannot be
// credited in one place and forgotten in another.
//   key      — field name in totals / meals / history / targets
//   source   — matching field on currentValues()
//   onHome   — whether its card shows on the home screen. A macro without a
//              card is still credited, stored and targeted exactly the same.
const MACROS = [
  { key: "calories", source: "kcal",          label: "Calories", unit: "kcal", decimals: 0, fallback: 2000, onHome: true },
  { key: "protein",  source: "proteins",      label: "Protein",  unit: "g",    decimals: 1, fallback: 150,  onHome: true },
  { key: "carbs",    source: "carbohydrates", label: "Carbs",    unit: "g",    decimals: 1, fallback: 250,  onHome: false },
  { key: "fat",      source: "fat",           label: "Fat",      unit: "g",    decimals: 1, fallback: 70,   onHome: false },
];

const zeroTotals = () => Object.fromEntries(MACROS.map((m) => [m.key, 0]));

const $ = (id) => document.getElementById(id);

const els = {
  btnScan: $("btn-scan"),
  btnManualToggle: $("btn-manual-toggle"),
  manualForm: $("manual-form"),
  manualBarcode: $("manual-barcode"),
  manualError: $("manual-error"),
  video: $("video"),
  btnCancelScan: $("btn-cancel-scan"),
  loadingText: $("loading-text"),
  productImage: $("product-image"),
  productName: $("product-name"),
  productBrand: $("product-brand"),
  productBarcode: $("product-barcode"),
  weightResults: $("weight-results"),
  weightError: $("weight-error"),
  headline: $("headline"),
  secondary: $("secondary"),
  resultNote: $("result-note"),
  btnAddTotal: $("btn-add-total"),
  btnSaveMeal: $("btn-save-meal"),
  btnReset: $("btn-reset"),
  totalsGrid: $("totals-grid"),
  btnOptions: $("btn-options"),
  optionsMenu: $("options-menu"),
  btnResetCounter: $("btn-reset-counter"),
  btnEditGoals: $("btn-edit-goals"),
  btnGoalsCancel: $("btn-goals-cancel"),
  targetsForm: $("targets-form"),
  targetsError: $("targets-error"),
  btnCustomToggle: $("btn-custom-toggle"),
  customForm: $("custom-form"),
  customName: $("custom-name"),
  customError: $("custom-error"),
  customSaveMeal: $("custom-save-meal"),
  btnCustomSubmit: $("btn-custom-submit"),
  mealsSection: $("meals-section"),
  mealsList: $("meals-list"),
  logList: $("log-list"),
  logEmpty: $("log-empty"),
  errorMessage: $("error-message"),
  errorDetail: $("error-detail"),
  btnErrorReset: $("btn-error-reset"),
  diagnostics: $("diagnostics"),
  crop: $("crop"),
};

// Bottom-nav tabs. Each one is a <button id="tab-NAME"> in the nav bar and a
// <section id="view-NAME">; adding a tab is one entry here plus that markup.
const TABS = ["home", "log"];
const VIEWS = [...TABS, "scanning", "loading", "results", "error"];

let view = "home";
// Bumped by every reset(). A camera start or lookup still awaiting when the
// user navigates away compares against it and drops its result, rather than
// yanking them back to a scan they have already left.
let flow = 0;
let product = null;      // cached OFF product, so weight edits never refetch
let engineLabel = "starting…";
let totals = zeroTotals();
let targets = {};
let meals = [];
let history = [];
let addedTimer = null;
let mealAddedTimer = null;
let customTimer = null;

// ───────────────────────── view state ─────────────────────────

function setState(name) {
  view = name;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;

  // The scan flow belongs to Home, so its tab stays lit through scanning,
  // loading and results.
  const activeTab = TABS.includes(name) ? name : "home";
  for (const tab of TABS) {
    if (tab === activeTab) $(`tab-${tab}`).setAttribute("aria-current", "page");
    else $(`tab-${tab}`).removeAttribute("aria-current");
  }

  // Saving a meal from the results screen doesn't repaint the list, since it
  // isn't on screen. Every route into the Log tab passes through here, so the
  // lists can't go stale via a path that forgot to refresh them.
  if (name === "log") {
    renderMeals();
    renderHistory();
  }
}

function showError(message, detail) {
  els.errorMessage.textContent = message;
  els.errorDetail.textContent = detail || "";
  els.errorDetail.hidden = !detail;
  setState("error");
}

function setDiagnostics(extra) {
  els.diagnostics.textContent = `engine: ${engineLabel}${extra ? ` · ${extra}` : ""}`;
}

// ────────────────────── scanner engine ────────────────────────
// iOS Safari has no BarcodeDetector at all. Android Chrome has one, but it
// delegates to Google Play Services — and when that is missing (China-ROM or
// de-Googled Xiaomi devices) the spec says getSupportedFormats() resolves to an
// empty array and detect() rejects with NotSupportedError. So existence is not
// enough: probe the formats, and keep the wasm decoder ready as a fallback.

let wasmCtor = null;
let detector = null;
let detectorReady = null;

async function loadWasmCtor() {
  if (!wasmCtor) {
    const mod = await import(WASM_PONYFILL);
    wasmCtor = mod.BarcodeDetector;
  }
  return wasmCtor;
}

async function nativeFormats() {
  const Native = globalThis.BarcodeDetector;
  if (!Native || typeof Native.getSupportedFormats !== "function") return [];
  try {
    const formats = await Native.getSupportedFormats();
    return Array.isArray(formats) ? formats : [];
  } catch {
    return [];
  }
}

async function buildDetector() {
  const supported = await nativeFormats();
  const usable = WANTED_FORMATS.filter((f) => supported.includes(f));

  // ean_13 is the format that matters for retail food products.
  if (usable.includes("ean_13")) {
    try {
      const made = new globalThis.BarcodeDetector({ formats: usable });
      engineLabel = "native";
      return made;
    } catch {
      // fall through to wasm
    }
  }

  const Ctor = await loadWasmCtor();
  const made = new Ctor({ formats: WANTED_FORMATS });
  engineLabel = "wasm";
  return made;
}

async function initDetector() {
  detector = await buildDetector();

  // Warm up now rather than on first tap, so the ~1 MB wasm is fetched and
  // compiled before the camera ever opens.
  const warm = document.createElement("canvas");
  warm.width = warm.height = 1;
  try { await detector.detect(warm); } catch { /* 1x1 decode failure is fine */ }

  setDiagnostics();
  return detector;
}

function ensureDetector() {
  if (!detectorReady) {
    detectorReady = initDetector().catch((err) => {
      detectorReady = null;
      engineLabel = "unavailable";
      setDiagnostics();
      throw err;
    });
  }
  return detectorReady;
}

// Covers the case where Play Services reports formats but cannot actually
// decode yet (the barcode module downloads lazily).
async function demoteToWasm() {
  const Ctor = await loadWasmCtor();
  detector = new Ctor({ formats: WANTED_FORMATS });
  engineLabel = "wasm (demoted from native)";
  setDiagnostics();
}

// ─────────────────────────── camera ───────────────────────────

let stream = null;
let scanTimer = null;
let scanning = false;

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return [
      "Camera access was denied.",
      "Allow the camera for this site and try again. On a Redmi or other MIUI phone, check two places: Chrome's own site permissions, and the system permission manager in Settings → Apps → Chrome.",
    ];
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return ["No camera found on this device.", "You can still use “Enter Barcode Manually”."];
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return ["The camera is already in use.", "Close other apps or tabs using the camera, then try again."];
  }
  return ["Could not start the camera.", err ? `${err.name}: ${err.message}` : ""];
}

async function startCamera() {
  // Both iOS and Android expose mediaDevices only in a secure context, so this
  // is exactly what a plain-HTTP LAN test looks like from the inside.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError(
      "Camera needs a secure (HTTPS) connection.",
      "Open this page over https:// or on localhost. A plain http:// address — including a http://192.168.x.x LAN address — gives the browser no camera access at all.",
    );
    return;
  }

  setState("scanning");
  const mine = flow;

  let opened;
  try {
    opened = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    if (mine !== flow) return;
    const [message, detail] = cameraErrorMessage(err);
    showError(message, detail);
    return;
  }

  // Left while the permission prompt was up: release the camera rather than
  // leave its indicator on behind whatever screen they went to.
  if (mine !== flow) {
    for (const track of opened.getTracks()) track.stop();
    return;
  }

  stream = opened;
  els.video.srcObject = stream;
  try { await els.video.play(); } catch { /* autoplay attrs normally cover it */ }

  try {
    await ensureDetector();
  } catch {
    stopCamera();
    if (mine !== flow) return;
    showError(
      "Could not load the barcode scanner.",
      "The decoder is fetched from a CDN on first load. Check your connection, or use “Enter Barcode Manually”.",
    );
    return;
  }

  if (mine !== flow) return;   // reset() has already stopped the stream
  scanning = true;
  setDiagnostics("scanning");
  scanLoop();
}

function stopCamera() {
  scanning = false;
  clearTimeout(scanTimer);
  scanTimer = null;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  els.video.srcObject = null;
}

// Decode only the centre band. Fewer pixels per attempt, and it matches the
// on-screen reticle — which nudges the user to fill the frame, the single
// biggest lever on 1D decode accuracy.
function cropBand() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;

  const bandHeight = Math.max(1, Math.round(vh * BAND_FRACTION));
  const top = Math.round((vh - bandHeight) / 2);

  els.crop.width = vw;
  els.crop.height = bandHeight;
  els.crop
    .getContext("2d", { willReadFrequently: true })
    .drawImage(els.video, 0, top, vw, bandHeight, 0, 0, vw, bandHeight);

  return els.crop;
}

async function scanLoop() {
  if (!scanning) return;

  try {
    const frame = cropBand();
    if (frame) {
      const found = await detector.detect(frame);
      if (scanning && found && found.length) {
        const raw = String(found[0].rawValue || "").replace(/\D/g, "");
        if (raw) {
          stopCamera();
          lookUp(raw);
          return;
        }
      }
    }
  } catch (err) {
    if (err && err.name === "NotSupportedError" && engineLabel === "native") {
      try { await demoteToWasm(); } catch { /* keep trying with what we have */ }
    }
    // Any other error here is a failed decode attempt — expected, keep going.
  }

  if (scanning) scanTimer = setTimeout(scanLoop, SCAN_INTERVAL_MS);
}

// ──────────────────────────── API ─────────────────────────────

class NetworkError extends Error {}

// UPC-A codes are often reported as a 13-digit EAN with a leading zero, and the
// native and wasm engines don't always agree on which form they hand back.
function barcodeVariants(code) {
  const variants = [code];
  if (code.length === 13 && code.startsWith("0")) variants.push(code.slice(1));
  else if (code.length === 12) variants.push(`0${code}`);
  return variants;
}

async function fetchProduct(code) {
  const url = `${API_BASE}${encodeURIComponent(code)}.json?fields=${API_FIELDS}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return null;
  if (!response.ok) throw new NetworkError();

  let data;
  try {
    data = await response.json();
  } catch {
    throw new NetworkError();
  }

  if (data.status !== 1 || !data.product) return null;
  return data.product;
}

async function lookUp(code) {
  const mine = flow;
  setState("loading");
  els.loadingText.textContent = `Looking up ${code}…`;

  try {
    for (const variant of barcodeVariants(code)) {
      const found = await fetchProduct(variant);
      // Navigated away mid-lookup: the answer is no longer wanted.
      if (mine !== flow) return;
      if (found) {
        product = found;
        renderResults(code);
        return;
      }
    }
    showError(
      "Product not found in database.",
      `Barcode ${code} isn't in Open Food Facts. It's a crowd-sourced database, so local and store-brand products are often missing — that isn't a scanning fault.`,
    );
  } catch (err) {
    if (mine !== flow) return;
    if (err instanceof NetworkError) {
      showError("Network error, please try again.", "The lookup could not reach Open Food Facts.");
    } else {
      showError("Something went wrong.", `${err.name}: ${err.message}`);
    }
  }
}

// ──────────────────── nutrition + calculation ─────────────────

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function kcalPer100(nutriments) {
  const direct = toNumber(nutriments["energy-kcal_100g"]);
  if (direct !== null) return direct;

  // Some entries only carry kJ. Converting beats blanking the headline number.
  const generic = toNumber(nutriments.energy_100g);
  if (generic !== null) {
    const unit = String(nutriments.energy_unit || "kJ").toLowerCase();
    return unit === "kcal" ? generic : generic / 4.184;
  }

  const kj = toNumber(nutriments["energy-kj_100g"]);
  return kj === null ? null : kj / 4.184;
}

function scale(per100, weight) {
  return per100 === null ? null : (weight / 100) * per100;
}

function format(value, decimals) {
  if (value === null) return "—";
  if (decimals === 0) return String(Math.round(value));
  const fixed = value.toFixed(decimals);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

// "100 g" is the usual basis, but drinks are per 100 ml.
function basisUnit(item) {
  return /\b\d*\s*(ml|cl|l|liter|litre)\b/i.test(item.quantity || "") ? "ml" : "g";
}

function renderResults(scannedCode) {
  const nutriments = product.nutriments || {};
  const core = {
    kcal: kcalPer100(nutriments),
    proteins: toNumber(nutriments.proteins_100g),
    carbohydrates: toNumber(nutriments.carbohydrates_100g),
    fat: toNumber(nutriments.fat_100g),
  };

  // Distinguishing this from "not found" tells the user the scan itself worked.
  if (Object.values(core).every((v) => v === null)) {
    showError(
      "This product has no nutrition data yet.",
      `${product.product_name || "The product"} was found in Open Food Facts, but nobody has filled in its nutrition facts. The barcode scanned correctly.`,
    );
    return;
  }

  const name = product.product_name || product.product_name_en || "Unnamed product";
  els.productName.textContent = name;
  els.productBrand.textContent = product.brands || "";
  els.productBrand.hidden = !product.brands;
  els.productBarcode.textContent = scannedCode;

  if (product.image_small_url) {
    els.productImage.src = product.image_small_url;
    els.productImage.alt = name;
    els.productImage.hidden = false;
  } else {
    els.productImage.hidden = true;
    els.productImage.removeAttribute("src");
  }

  els.weightResults.value = DEFAULT_GRAMS;
  renderNutrition();

  const notes = [];
  if (product.nutrition_data_per && product.nutrition_data_per !== "100g") {
    notes.push(`Heads up: this entry reports values per ${product.nutrition_data_per}, not per 100 g.`);
  }
  if (basisUnit(product) === "ml") {
    notes.push("This looks like a drink — values are per 100 ml, so grams and millilitres are being treated as equivalent.");
  }
  els.resultNote.textContent = notes.join(" ");
  els.resultNote.hidden = notes.length === 0;

  setState("results");
}

function readWeight() {
  const raw = els.weightResults.value.trim();
  if (raw === "") return { error: "Enter a weight in grams." };

  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: "That isn't a number — enter a weight in grams." };
  if (value <= 0) return { error: "Enter a weight greater than zero." };
  if (value > MAX_GRAMS) return { error: `That's over ${MAX_GRAMS} g — check for a typo.` };

  return { value };
}

// Every scaled number the results screen shows comes from here, and so does
// every number "Add to Daily Total" adds. One source of truth, so the total can
// never drift from what was on screen. Null for an invalid weight, which is
// what blocks Add and Save — not just their disabled state.
function currentValues() {
  const { value: weight } = readWeight();
  if (!product || weight === undefined) return null;

  const n = product.nutriments || {};
  return {
    weight,
    kcal: scale(kcalPer100(n), weight),
    proteins: scale(toNumber(n.proteins_100g), weight),
    carbohydrates: scale(toNumber(n.carbohydrates_100g), weight),
    fat: scale(toNumber(n.fat_100g), weight),
    sugars: scale(toNumber(n.sugars_100g), weight),
    saturatedFat: scale(toNumber(n["saturated-fat_100g"]), weight),
    fiber: scale(toNumber(n.fiber_100g), weight),
    salt: scale(toNumber(n.salt_100g), weight),
  };
}

// The grams field's input handler, and the first render of every result.
// Recalculates from the cached product — never refetches.
function renderNutrition() {
  const { error } = readWeight();
  els.weightError.textContent = error || "";
  els.weightError.hidden = !error;

  // While "Added! ✓" shows, the add has happened and the screen is on its way
  // home; re-enabling here would let a keystroke unlock a second add.
  if (!addedTimer) els.btnAddTotal.disabled = !!error;
  // A new weight is a new portion, so "Saved! ✓" no longer describes it.
  els.btnSaveMeal.textContent = "Save as Quick Add";
  els.btnSaveMeal.disabled = !!error;

  // An invalid weight blanks every figure to "—" rather than leaving the last
  // valid set on screen beside the error.
  const values = currentValues();
  const pick = (key) => (values ? values[key] : null);

  const headline = [
    { label: "Calories", value: pick("kcal"), unit: "kcal", decimals: 0 },
    { label: "Protein", value: pick("proteins"), unit: "g", decimals: 1 },
    { label: "Carbs", value: pick("carbohydrates"), unit: "g", decimals: 1 },
    { label: "Fat", value: pick("fat"), unit: "g", decimals: 1 },
  ];

  els.headline.replaceChildren(...headline.map((stat) => {
    const card = document.createElement("div");
    card.className = "stat";

    const value = document.createElement("div");
    value.className = "stat-value";
    value.textContent = format(stat.value, stat.decimals);

    const unitSpan = document.createElement("span");
    unitSpan.className = "stat-unit";
    unitSpan.textContent = ` ${stat.unit}`;
    value.append(unitSpan);

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = stat.label;

    card.append(value, label);
    return card;
  }));

  const secondary = [
    { label: "Sugars", value: pick("sugars"), decimals: 1 },
    { label: "Saturated fat", value: pick("saturatedFat"), decimals: 1 },
    { label: "Fiber", value: pick("fiber"), decimals: 1 },
    { label: "Salt", value: pick("salt"), decimals: 2 },
  ];

  els.secondary.replaceChildren(...secondary.map((row) => {
    const wrapper = document.createElement("div");
    wrapper.className = "secondary-row";

    const term = document.createElement("dt");
    term.textContent = row.label;

    const definition = document.createElement("dd");
    const formatted = format(row.value, row.decimals);
    definition.textContent = formatted === "—" ? "—" : `${formatted} g`;

    wrapper.append(term, definition);
    return wrapper;
  }));

  setDiagnostics(values
    ? `${format(values.weight, 1)} ${basisUnit(product)} of ${product.product_name || "product"}`
    : "");
}

// ────────────────────── daily counter ─────────────────────────
// Totals run until you press Reset Counter — there is no midnight rollover, so
// "daily" is the user's discipline rather than the app's.

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;   // absent, unreadable and unparseable all mean "start fresh"
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // iOS Safari in Private Browsing throws on every write. Swallowing it keeps
    // the feature working for the session; it just won't survive a reload.
  }
}

// A number from storage, or the fallback. Validating rather than trusting:
// one NaN would poison every later add and never recover without a reset.
function storedNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function loadTotals() {
  const parsed = readStored(TOTALS_KEY);
  const loaded = zeroTotals();
  for (const macro of MACROS) loaded[macro.key] = storedNumber(parsed?.[macro.key], 0);

  // Totals saved before carbs and fat existed used { kcal, protein }. Carry the
  // calories across rather than silently zeroing a counter mid-day.
  if (!Number.isFinite(parsed?.calories) && Number.isFinite(parsed?.kcal)) {
    loaded.calories = parsed.kcal;
  }
  return loaded;
}

function saveTotals() {
  writeStored(TOTALS_KEY, totals);
}

function loadTargets() {
  const parsed = readStored(TARGETS_KEY);
  const loaded = {};
  // Per-field fallback: one bad value shouldn't discard the other three.
  for (const macro of MACROS) {
    const value = parsed?.[macro.key];
    loaded[macro.key] = Number.isFinite(value) && value > 0 ? value : macro.fallback;
  }
  return loaded;
}

function progressPercent(current, target) {
  if (!(target > 0)) return 0;
  return Math.min(100, (current / target) * 100);
}

function renderTotals() {
  els.totalsGrid.replaceChildren(...MACROS.map((macro) => {
    const current = totals[macro.key] || 0;
    const target = targets[macro.key];
    const percent = progressPercent(current, target);

    const card = document.createElement("div");
    card.className = "stat";
    // Built and kept current even when hidden, so showing a macro again is a
    // one-flag change in MACROS.
    card.hidden = !macro.onHome;

    const value = document.createElement("div");
    value.className = "stat-value";

    const amount = document.createElement("span");
    amount.id = `total-${macro.key}`;
    amount.textContent = format(current, macro.decimals);

    const against = document.createElement("span");
    against.className = "stat-unit";
    against.textContent = ` / ${format(target, macro.decimals)} ${macro.unit}`;

    value.append(amount, against);

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = macro.label;

    const track = document.createElement("div");
    track.className = "meter";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${macro.label} progress`);
    track.setAttribute("aria-valuenow", String(Math.round(percent)));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");

    const fill = document.createElement("div");
    fill.className = percent >= 100 ? "meter-fill meter-full" : "meter-fill";
    fill.id = `meter-${macro.key}`;
    // Capped at 100% so an overshoot can't paint outside the track.
    fill.style.width = `${percent}%`;

    track.append(fill);
    card.append(value, label, track);
    return card;
  }));
}

// Reads back exactly what format() put on screen. Rounding the number a second
// time by any other route is not equivalent: 50 g of Nutella is 3.15 g protein,
// which toFixed(1) renders "3.1" (the stored double is 3.1499…) while
// Math.round(3.15 * 10) / 10 gives 3.2, because 3.15 * 10 lands on exactly 31.5
// in float64. Going through format() makes "adds what it showed you" literal.
function displayed(value, decimals) {
  return value === null ? 0 : Number(format(value, decimals));
}

// The single path into the daily totals. The results-screen button and a saved
// quick-add both go through here, and the log entry is written here too — so an
// item can't be credited without being logged, which is what keeps the log and
// the totals reconcilable.
function creditTotals(item) {
  for (const macro of MACROS) {
    totals[macro.key] = displayed((totals[macro.key] || 0) + (item[macro.key] || 0), macro.decimals);
  }
  saveTotals();

  history.push({ id: uniqueId(history), ...item, timestamp: Date.now() });
  writeStored(HISTORY_KEY, history);

  renderTotals();
  // A quick-add happens while the log is already on screen, so it has to
  // repaint now rather than waiting for the next visit to the Log tab.
  renderHistory();
}

function addToTotal() {
  const values = currentValues();
  if (!values) return;

  // Credit the rounded values the user actually saw, not full precision. Two
  // 50 g scoops of Nutella each display as 270 kcal; totalling 539 would read
  // as a bug even though it's nearer the truth. Worst case: 0.5 kcal/item.
  creditTotals(itemFrom(values));

  els.btnAddTotal.textContent = "Added! ✓";
  els.btnAddTotal.disabled = true;

  clearTimeout(addedTimer);
  addedTimer = setTimeout(() => {
    addedTimer = null;
    reset();
  }, ADDED_FEEDBACK_MS);
}

function resetCounter() {
  if (!confirm("Are you sure you want to reset your daily calories and protein counter?")) return;
  totals = zeroTotals();   // targets are settings, not daily data — left alone
  saveTotals();
  history = [];
  writeStored(HISTORY_KEY, history);
  renderTotals();
  renderHistory();
}

// ────────────────────── saved quick-add meals ─────────────────
// The in-memory array is the source of truth, loaded once at init. Re-reading
// storage on every visit to the Log tab would look equivalent but loses data
// on iOS Private Browsing, where writes throw: the meal just saved would
// vanish the moment you opened the tab to use it.

// Saved meals and log entries carry the same nutrition fields, so one shape
// check serves both. Only calories and protein are required: rows written
// before carbs and fat were tracked are still perfectly usable.
function hasItemShape(item) {
  return !!item
    && (typeof item.id === "number" || typeof item.id === "string")
    && typeof item.name === "string"
    && Number.isFinite(item.weight)
    && Number.isFinite(item.calories)
    && Number.isFinite(item.protein);
}

// Fills in any macro a stored row predates, so nothing downstream ever sees
// undefined and turns it into NaN.
function normalizeItem(item) {
  const filled = { ...item };
  for (const macro of MACROS) filled[macro.key] = storedNumber(item[macro.key], 0);
  return filled;
}

// Builds a meal / log item from whatever the results screen is showing, with
// every macro routed through displayed() so stored figures match the screen.
function itemFrom(values) {
  const item = { name: productLabel(), weight: values.weight };
  for (const macro of MACROS) item[macro.key] = displayed(values[macro.source], macro.decimals);
  return item;
}

function loadMeals() {
  const parsed = readStored(MEALS_KEY);
  // Drop bad rows rather than render NaN or let one of them take the list down.
  return Array.isArray(parsed) ? parsed.filter(hasItemShape).map(normalizeItem) : [];
}

// Delete targets by id, so a collision would remove the wrong row — or both.
// Date.now() alone repeats when two items land in the same millisecond.
function uniqueId(existing) {
  let id = Date.now();
  while (existing.some((item) => item.id === id)) id++;
  return id;
}

function productLabel() {
  return String(product.product_name || product.product_name_en || "Saved Item").slice(0, MAX_MEAL_NAME);
}

function saveMeal() {
  const values = currentValues();
  if (!values) return;

  meals.push({ id: uniqueId(meals), ...itemFrom(values) });
  writeStored(MEALS_KEY, meals);

  els.btnSaveMeal.textContent = "Saved! ✓";
  els.btnSaveMeal.disabled = true;
}

function addSavedMeal(id, button) {
  const meal = meals.find((item) => item.id === id);
  if (!meal) return;

  creditTotals(meal);   // already normalized, so every macro is present

  // The totals are on the Home tab, out of sight, so this and the new row in
  // Today's Log below are the confirmation. renderMeals() restores the label.
  button.textContent = "Added! ✓";
  button.disabled = true;
  clearTimeout(mealAddedTimer);
  mealAddedTimer = setTimeout(renderMeals, ADDED_FEEDBACK_MS);
}

function deleteMeal(id) {
  meals = meals.filter((meal) => meal.id !== id);
  writeStored(MEALS_KEY, meals);
  renderMeals();
}

// Shared by saved-meal buttons and log rows. The weight is omitted when there
// isn't one — a manually entered item has no portion weight, and "— 0g" would
// read as a measurement rather than an absence.
function itemLabel(item) {
  const parts = [item.name];
  if (item.weight > 0) parts.push(`— ${format(item.weight, 1)}g`);
  parts.push(`(${format(item.calories, 0)} kcal, ${format(item.protein, 1)}g)`);
  return parts.join(" ");
}

function mealRow(meal) {
  const row = document.createElement("div");
  row.className = "meal-row";

  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn btn-secondary meal-add";
  // textContent, never innerHTML: product names come from Open Food Facts,
  // which anyone can edit, and they are persisted and re-rendered here.
  add.textContent = itemLabel(meal);
  add.addEventListener("click", () => addSavedMeal(meal.id, add));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "meal-delete";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", `Delete ${meal.name}`);
  remove.addEventListener("click", () => deleteMeal(meal.id));

  row.append(add, remove);
  return row;
}

function renderMeals() {
  clearTimeout(mealAddedTimer);
  mealAddedTimer = null;
  els.mealsSection.hidden = meals.length === 0;
  els.mealsList.replaceChildren(...meals.map(mealRow));
}

// ────────────────────── custom manual entry ───────────────────
// Logs an item with no barcode and no API lookup, straight through
// creditTotals() — so it lands in the totals and today's log by the same path
// as a scan, with no separate bookkeeping to keep in step.

function readMacroField(key, label) {
  const raw = $(`custom-${key}`).value.trim();
  if (raw === "") return { value: 0 };          // a blank field means zero

  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${label} must be a number.` };
  if (value < 0) return { error: `${label} can't be negative.` };
  if (value > MAX_TARGET) return { error: `${label} is over ${MAX_TARGET} — check for a typo.` };
  return { value };
}

function closeCustomForm() {
  els.customForm.hidden = true;
  els.customError.hidden = true;
  els.btnCustomToggle.setAttribute("aria-expanded", "false");
}

function toggleCustomForm() {
  if (!els.customForm.hidden) {
    closeCustomForm();
    return;
  }
  els.customForm.hidden = false;
  els.customError.hidden = true;
  els.btnCustomToggle.setAttribute("aria-expanded", "true");
  els.customName.focus();
}

function clearCustomForm() {
  els.customName.value = "";
  for (const macro of MACROS) $(`custom-${macro.key}`).value = "";
  els.customSaveMeal.checked = false;
}

function submitCustom(event) {
  event.preventDefault();

  const item = { name: els.customName.value.trim().slice(0, MAX_MEAL_NAME) || "Custom Entry", weight: 0 };

  for (const macro of MACROS) {
    const { value, error } = readMacroField(macro.key, macro.label);
    if (error) {
      els.customError.textContent = error;
      els.customError.hidden = false;
      $(`custom-${macro.key}`).focus();
      return;
    }
    // Through displayed(), like every other route into the totals.
    item[macro.key] = displayed(value, macro.decimals);
  }

  // An all-blank submission would otherwise add a meaningless "0 kcal" row that
  // the user then has to delete.
  if (MACROS.every((macro) => item[macro.key] === 0)) {
    els.customError.textContent = "Enter at least one value.";
    els.customError.hidden = false;
    $(`custom-${MACROS[0].key}`).focus();
    return;
  }

  els.customError.hidden = true;
  creditTotals(item);

  if (els.customSaveMeal.checked) {
    meals.push({ id: uniqueId(meals), ...item });
    writeStored(MEALS_KEY, meals);
    renderMeals();
  }

  clearCustomForm();
  els.btnCustomSubmit.textContent = "Logged! ✓";
  els.btnCustomSubmit.disabled = true;

  clearTimeout(customTimer);
  customTimer = setTimeout(() => {
    customTimer = null;
    els.btnCustomSubmit.textContent = "Log it";
    els.btnCustomSubmit.disabled = false;
  }, ADDED_FEEDBACK_MS);
}

// ───────────────────────── daily targets ──────────────────────

function renderTargetInputs() {
  for (const macro of MACROS) {
    $(`target-${macro.key}`).value = String(targets[macro.key]);
  }
}

function closeTargetsForm() {
  els.targetsForm.hidden = true;
  els.targetsError.hidden = true;
}

// Reached from the options menu, which is on every screen. The form edits the
// goals shown on the Home cards, so it opens there.
function openTargetsForm() {
  if (view !== "home") reset();
  els.targetsForm.hidden = false;
  els.targetsError.hidden = true;
  renderTargetInputs();              // always opens showing what's actually saved
  $(`target-${MACROS[0].key}`).focus();
}

function saveTargets(event) {
  event.preventDefault();

  const next = {};
  for (const macro of MACROS) {
    const raw = $(`target-${macro.key}`).value.trim();
    const value = raw === "" ? NaN : Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
      els.targetsError.textContent = `${macro.label} must be a number greater than zero.`;
      els.targetsError.hidden = false;
      $(`target-${macro.key}`).focus();
      return;
    }
    if (value > MAX_TARGET) {
      els.targetsError.textContent = `${macro.label} is over ${MAX_TARGET} — check for a typo.`;
      els.targetsError.hidden = false;
      $(`target-${macro.key}`).focus();
      return;
    }
    next[macro.key] = value;
  }

  // Only commit once every field has passed, so a later failure can't leave
  // half the goals updated.
  targets = next;
  writeStored(TARGETS_KEY, targets);
  closeTargetsForm();
  renderTotals();
}

// ──────────────────────── today's log ─────────────────────────
// Every credit to the daily totals is written here by creditTotals(), so the
// log and the counter always describe the same set of items. Deleting an entry
// subtracts it back out.

function isLogEntry(entry) {
  return hasItemShape(entry) && Number.isFinite(entry.timestamp);
}

function loadHistory() {
  const parsed = readStored(HISTORY_KEY);
  return Array.isArray(parsed) ? parsed.filter(isLogEntry).map(normalizeItem) : [];
}

function deleteHistoryEntry(id) {
  const index = history.findIndex((entry) => entry.id === id);
  if (index === -1) return;

  const [entry] = history.splice(index, 1);

  // Clamped at zero: the totals are a running sum of rounded values, so a
  // sequence of adds and deletes can otherwise leave a stray -0.1 behind.
  // `|| 0` covers entries logged before carbs and fat were tracked.
  for (const macro of MACROS) {
    const next = displayed((totals[macro.key] || 0) - (entry[macro.key] || 0), macro.decimals);
    totals[macro.key] = Math.max(0, next);
  }

  saveTotals();
  writeStored(HISTORY_KEY, history);
  renderTotals();
  renderHistory();
}

function historyRow(entry) {
  const row = document.createElement("div");
  row.className = "log-row";

  const label = document.createElement("span");
  label.className = "log-label";
  // textContent: these names come from Open Food Facts or the custom-entry
  // field — both untrusted, and both persisted and re-rendered here.
  label.textContent = itemLabel(entry);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "meal-delete";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", `Remove ${entry.name} from today's log`);
  remove.addEventListener("click", () => deleteHistoryEntry(entry.id));

  row.append(label, remove);
  return row;
}

function renderHistory() {
  els.logEmpty.hidden = history.length > 0;
  // Newest first; slice() so the stored order stays append-ordered.
  els.logList.replaceChildren(...history.slice().reverse().map(historyRow));
}

// ───────────────────────── interactions ───────────────────────

// Ends whatever the scan flow was doing and lands on a tab — Home unless told
// otherwise. Every tab switch comes through here too.
function reset(target = "home") {
  flow++;
  stopCamera();

  // Cancel any pending "Added! ✓" hand-off, so a stray timer can't yank the
  // user back home after they've already navigated somewhere else.
  clearTimeout(addedTimer);
  addedTimer = null;
  els.btnAddTotal.textContent = "Add to Daily Total";
  els.btnAddTotal.disabled = false;
  els.btnSaveMeal.textContent = "Save as Quick Add";
  els.btnSaveMeal.disabled = false;

  product = null;
  els.weightResults.value = "";
  els.weightError.hidden = true;
  els.manualBarcode.value = "";
  els.manualError.hidden = true;
  els.manualForm.hidden = true;
  els.btnManualToggle.setAttribute("aria-expanded", "false");
  closeTargetsForm();
  closeCustomForm();
  clearCustomForm();
  els.headline.replaceChildren();
  els.secondary.replaceChildren();
  setState(target);
  setDiagnostics();
}

function openTab(tab) {
  if (view === tab) return;   // re-tapping the current tab keeps any open form
  reset(tab);
}

// ───────────────────────── options menu ───────────────────────

function closeMenu() {
  els.optionsMenu.hidden = true;
  els.btnOptions.setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  const opening = els.optionsMenu.hidden;
  els.optionsMenu.hidden = !opening;
  els.btnOptions.setAttribute("aria-expanded", String(opening));
}

// Wrapped rather than passed directly: as a listener, reset would receive the
// click event as its target view.
els.btnScan.addEventListener("click", startCamera);
els.btnCancelScan.addEventListener("click", () => reset());
els.btnReset.addEventListener("click", () => reset());
els.btnErrorReset.addEventListener("click", () => reset());
els.btnAddTotal.addEventListener("click", addToTotal);
els.btnSaveMeal.addEventListener("click", saveMeal);
els.btnOptions.addEventListener("click", toggleMenu);
els.btnResetCounter.addEventListener("click", () => { closeMenu(); resetCounter(); });
els.btnEditGoals.addEventListener("click", () => { closeMenu(); openTargetsForm(); });
els.btnGoalsCancel.addEventListener("click", closeTargetsForm);
els.targetsForm.addEventListener("submit", saveTargets);

for (const tab of TABS) $(`tab-${tab}`).addEventListener("click", () => openTab(tab));

// A click anywhere outside the menu closes it. The ⋮ button is excluded: its
// own handler has just toggled the menu, and the same click bubbles up here.
document.addEventListener("click", (event) => {
  if (els.optionsMenu.hidden) return;
  if (els.optionsMenu.contains(event.target) || els.btnOptions.contains(event.target)) return;
  closeMenu();
});
els.btnCustomToggle.addEventListener("click", toggleCustomForm);
els.customForm.addEventListener("submit", submitCustom);

els.weightResults.addEventListener("input", renderNutrition);

els.btnManualToggle.addEventListener("click", () => {
  const nowHidden = !els.manualForm.hidden;
  els.manualForm.hidden = nowHidden;
  els.btnManualToggle.setAttribute("aria-expanded", String(!nowHidden));
  if (!nowHidden) els.manualBarcode.focus();
});

els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const code = els.manualBarcode.value.replace(/\D/g, "");
  if (code.length < 8) {
    els.manualError.textContent = "Enter at least 8 barcode digits.";
    els.manualError.hidden = false;
    els.manualBarcode.focus();
    return;
  }

  els.manualError.hidden = true;
  lookUp(code);
});

// Don't leave the camera indicator on when the page is backgrounded.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && scanning) reset();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
}

targets = loadTargets();
totals = loadTotals();
meals = loadMeals();
history = loadHistory();
// The markup ships these hidden; own that state in code too.
closeMenu();
closeTargetsForm();
closeCustomForm();
renderTotals();
renderMeals();
renderHistory();
setState("home");
setDiagnostics();
ensureDetector().catch(() => { /* reported via the diagnostics line */ });
