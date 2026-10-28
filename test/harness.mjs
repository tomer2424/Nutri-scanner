// Test infrastructure for app.js.
//
// app.js exports nothing and touches the DOM at load, so it's tested the way a
// browser runs it: stub the few DOM APIs it uses, import the real file, fire the
// listeners it registered, and read back what it rendered. The logic under test
// is always the shipped file — nothing here reimplements it.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_PATH = fileURLToPath(new URL("../app.js", import.meta.url));
const VIEWS = ["home", "log", "scanning", "loading", "results", "error"];

// `register` mirrors a real DOM closely enough for our purposes: an element
// becomes findable by getElementById as soon as it is given an id, including
// one created by document.createElement and assigned an id afterwards — which
// is how the four counter cards are built.
function makeElement(id, register) {
  let currentId = id;
  const node = {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    className: "",
    src: undefined,
    alt: "",
    width: 0,
    height: 0,
    children: [],
    attrs: {},
    style: {},
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    // Only knows about children added from code: elements from the markup
    // are separate stubs with no parent link.
    contains(other) { return other === this || this.children.some((kid) => kid.contains(other)); },
    focus() {},
    play() { return Promise.resolve(); },
    getContext() { return { drawImage() {} }; },
  };

  Object.defineProperty(node, "id", {
    get: () => currentId,
    set: (value) => { currentId = value; register?.(value, node); },
    enumerable: true,
  });

  if (id) register?.(id, node);
  return node;
}

/** Flattens an element tree to the text a browser would show. */
export function textOf(node) {
  return (node.textContent || "") + node.children.map(textOf).join("");
}

export function install() {
  const elements = new Map();
  const register = (id, node) => elements.set(id, node);
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id, register));
    return elements.get(id);
  };

  // Each reload of app.js re-registers its listeners, replacing the previous
  // module's — the same one-per-type model the element stubs use.
  const documentListeners = {};
  globalThis.document = {
    hidden: false,
    getElementById: el,
    createElement: () => makeElement(undefined, register),
    addEventListener(type, fn) { documentListeners[type] = fn; },
  };

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  globalThis.confirm = () => true;

  let version = 0;

  // Loading a *copy* with a .mjs extension is deliberate, and the suite is
  // unsound without it. The repo has no package.json, so Node treats a bare
  // .js as CommonJS — and the CJS cache keys on filename alone, silently
  // ignoring `?v=` cache-busting. The module would never re-execute, leaving
  // stale rendered text that reads as a passing "reload" test. The browser
  // loads app.js as <script type="module">, so .mjs is also the truer match.
  const tmpDir = mkdtempSync(join(tmpdir(), "nutri-harness-"));
  const loadApp = () => {
    const copy = join(tmpDir, `app-${version++}.mjs`);
    writeFileSync(copy, readFileSync(APP_PATH));
    return import(pathToFileURL(copy).href);
  };

  return {
    el,
    store,
    loadApp,
    /** Which view sections are currently shown. */
    visible: () => VIEWS.filter((v) => !el(`view-${v}`).hidden),
    /** Calories and protein, as "<calories> / <protein>". */
    totals: () => `${el("total-calories").textContent} / ${el("total-protein").textContent}`,
    /** All four macros, as "<calories> / <protein> / <carbs> / <fat>". */
    macros: () => ["calories", "protein", "carbs", "fat"].map((k) => el(`total-${k}`).textContent).join(" / "),
    /** Each counter card flattened to text, e.g. "270 / 2000 kcalCalories". */
    cards: () => el("totals-grid").children.map(textOf),
    /** Only the counter cards actually shown on the home screen. */
    homeCards: () => el("totals-grid").children.filter((card) => !card.hidden).map(textOf),
    /** The rendered width of one progress bar, e.g. "13.5%". */
    meter: (key) => el(`meter-${key}`).style.width,
    /** The four headline stat cards, flattened to text. */
    headline: () => el("headline").children.map(textOf),
    /** The four secondary rows, flattened to text. */
    secondary: () => el("secondary").children.map(textOf),
    /**
     * Drives a manual-entry lookup and waits for it to settle, then — the way
     * a user would, once the product is on screen — types `grams` into the
     * results field. Omit `grams` to keep the default.
     */
    async lookup(barcode, grams, settleMs = 1500) {
      el("manual-barcode").value = String(barcode);
      el("manual-form").listeners.submit({ preventDefault() {} });
      await wait(settleMs);
      if (grams !== undefined && !el("view-results").hidden) {
        el("weight-results").value = String(grams);
        el("weight-results").listeners.input();
      }
    },
    click: (id) => el(id).listeners.click(),
    /**
     * A click as the document sees it once it has bubbled up from `id`. Call
     * it after click(id) to model a real tap, which reaches both listeners.
     */
    clickDocument: (id) => documentListeners.click?.({ target: el(id) }),
    /** Which bottom-nav tab is marked current. */
    activeTab: () => ["home", "log"].filter((t) => el(`tab-${t}`).attrs["aria-current"] === "page").join(),
    /**
     * Fakes a working camera and a native BarcodeDetector that sees nothing
     * until showBarcode() is called. Install before loadApp(): the detector is
     * built and warmed up as the module loads.
     */
    stubCamera() {
      let inView = null;
      globalThis.BarcodeDetector = class {
        static async getSupportedFormats() { return ["ean_13"]; }
        async detect() {
          const rawValue = inView;
          inView = null;
          return rawValue ? [{ rawValue }] : [];
        }
      };
      // Node's own navigator is a getter-only global, so redefine rather than assign.
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          mediaDevices: {
            getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          },
        },
      });
      el("video").videoWidth = 1280;
      el("video").videoHeight = 720;
      return { showBarcode(code) { inView = code; } };
    },
  };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Responds to app.js's Open Food Facts calls from a fixture, with no network. */
export function stubFetch(responder) {
  globalThis.fetch = async (url) => {
    const body = responder(String(url));
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

export function restoreFetch(original) {
  globalThis.fetch = original;
}

// ── reporting ──

let failures = 0;
let passes = 0;

export function check(label, ok, detail) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

export function section(name) {
  console.log(`\n── ${name} ──`);
}

export function finish() {
  console.log(`\n${passes} passed, ${failures} failed`);
  // Set the code and let the loop drain rather than calling process.exit():
  // a hard exit while a timer handle is still closing trips a libuv assertion
  // on Windows, which would fail CI with everything green.
  process.exitCode = failures ? 1 : 0;
}
