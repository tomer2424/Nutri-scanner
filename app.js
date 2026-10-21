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

const $ = (id) => document.getElementById(id);

const els = {
  weight: $("weight"),
  weightError: $("weight-error"),
  btnScan: $("btn-scan"),
  btnManualToggle: $("btn-manual-toggle"),
  manualForm: $("manual-form"),
  manualBarcode: $("manual-barcode"),
  video: $("video"),
  btnCancelScan: $("btn-cancel-scan"),
  loadingText: $("loading-text"),
  productImage: $("product-image"),
  productName: $("product-name"),
  productBrand: $("product-brand"),
  productBarcode: $("product-barcode"),
  weightResults: $("weight-results"),
  headline: $("headline"),
  secondary: $("secondary"),
  resultNote: $("result-note"),
  btnReset: $("btn-reset"),
  errorMessage: $("error-message"),
  errorDetail: $("error-detail"),
  btnErrorReset: $("btn-error-reset"),
  diagnostics: $("diagnostics"),
  crop: $("crop"),
};

const VIEWS = ["idle", "scanning", "loading", "results", "error"];

let grams = null;        // weight committed when the scan started
let product = null;      // cached OFF product, so weight edits never refetch
let engineLabel = "starting…";

// ───────────────────────── view state ─────────────────────────

function setState(name) {
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
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
    return ["No camera found on this device.", "You can still use “Enter barcode manually”."];
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

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    const [message, detail] = cameraErrorMessage(err);
    showError(message, detail);
    return;
  }

  els.video.srcObject = stream;
  try { await els.video.play(); } catch { /* autoplay attrs normally cover it */ }

  try {
    await ensureDetector();
  } catch {
    stopCamera();
    showError(
      "Could not load the barcode scanner.",
      "The decoder is fetched from a CDN on first load. Check your connection, or use “Enter barcode manually”.",
    );
    return;
  }

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
  setState("loading");
  els.loadingText.textContent = `Looking up ${code}…`;

  try {
    for (const variant of barcodeVariants(code)) {
      const found = await fetchProduct(variant);
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

  els.weightResults.value = String(grams);
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

// Recalculates from the cached product — never refetches.
function renderNutrition() {
  const weight = toNumber(els.weightResults.value);
  if (weight === null || weight <= 0) return;

  const n = product.nutriments || {};
  const unit = basisUnit(product);

  const headline = [
    { label: "Calories", value: scale(kcalPer100(n), weight), unit: "kcal", decimals: 0 },
    { label: "Protein", value: scale(toNumber(n.proteins_100g), weight), unit: "g", decimals: 1 },
    { label: "Carbs", value: scale(toNumber(n.carbohydrates_100g), weight), unit: "g", decimals: 1 },
    { label: "Fat", value: scale(toNumber(n.fat_100g), weight), unit: "g", decimals: 1 },
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
    { label: "Sugars", value: scale(toNumber(n.sugars_100g), weight), decimals: 1 },
    { label: "Saturated fat", value: scale(toNumber(n["saturated-fat_100g"]), weight), decimals: 1 },
    { label: "Fiber", value: scale(toNumber(n.fiber_100g), weight), decimals: 1 },
    { label: "Salt", value: scale(toNumber(n.salt_100g), weight), decimals: 2 },
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

  setDiagnostics(`${format(weight, 1)} ${unit} of ${product.product_name || "product"}`);
}

// ───────────────────────── interactions ───────────────────────

function readWeight() {
  const raw = els.weight.value.trim();
  if (raw === "") return { error: "Enter a weight in grams first." };

  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: "That isn't a number — enter a weight in grams." };
  if (value <= 0) return { error: "Enter a weight greater than zero." };
  if (value > MAX_GRAMS) return { error: `That's over ${MAX_GRAMS} g — check for a typo.` };

  return { value };
}

function beginScan() {
  const { value, error } = readWeight();
  if (error) {
    els.weightError.textContent = error;
    els.weightError.hidden = false;
    els.weight.focus();
    return;
  }

  els.weightError.hidden = true;
  grams = value;
  startCamera();
}

function reset() {
  stopCamera();
  product = null;
  grams = null;
  els.weight.value = "";
  els.weightResults.value = "";
  els.weightError.hidden = true;
  els.manualBarcode.value = "";
  els.manualForm.hidden = true;
  els.btnManualToggle.setAttribute("aria-expanded", "false");
  els.headline.replaceChildren();
  els.secondary.replaceChildren();
  setState("idle");
  setDiagnostics();
  els.weight.focus();
}

els.btnScan.addEventListener("click", beginScan);
els.btnCancelScan.addEventListener("click", reset);
els.btnReset.addEventListener("click", reset);
els.btnErrorReset.addEventListener("click", reset);

els.weight.addEventListener("input", () => { els.weightError.hidden = true; });
els.weight.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); beginScan(); }
});

els.weightResults.addEventListener("input", renderNutrition);

els.btnManualToggle.addEventListener("click", () => {
  const nowHidden = !els.manualForm.hidden;
  els.manualForm.hidden = nowHidden;
  els.btnManualToggle.setAttribute("aria-expanded", String(!nowHidden));
  if (!nowHidden) els.manualBarcode.focus();
});

els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const { value, error } = readWeight();
  if (error) {
    els.weightError.textContent = error;
    els.weightError.hidden = false;
    els.weight.focus();
    return;
  }

  const code = els.manualBarcode.value.replace(/\D/g, "");
  if (code.length < 8) {
    els.weightError.textContent = "Enter at least 8 barcode digits.";
    els.weightError.hidden = false;
    return;
  }

  els.weightError.hidden = true;
  grams = value;
  lookUp(code);
});

// Don't leave the camera indicator on when the page is backgrounded.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && scanning) {
    stopCamera();
    setState("idle");
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
}

setState("idle");
setDiagnostics();
ensureDetector().catch(() => { /* reported via the diagnostics line */ });
