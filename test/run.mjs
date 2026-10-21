// Checks for app.js. Run with:  node test/run.mjs   (add --offline to skip the
// live Open Food Facts contract checks).
//
// Everything except the final section is deterministic and network-free: it
// answers app.js's lookups from test/fixtures/nutella.json. Open Food Facts is
// crowd-sourced and editable, so asserting exact kcal against the live entry
// would make this suite fail for reasons that have nothing to do with our code.
// The live API is still checked — but for its *contract*, not its values.

import { readFileSync } from "node:fs";
import { install, wait, stubFetch, check, section, finish } from "./harness.mjs";

const NUTELLA = JSON.parse(readFileSync(new URL("./fixtures/nutella.json", import.meta.url)));
const NUTELLA_BARCODE = "3017620422003";
const LIVE = !process.argv.includes("--offline");

// Answers only the barcodes a test puts in `routes`; anything else 404s.
let routes = new Map();
const realFetch = globalThis.fetch;
const serveFixtures = () =>
  stubFetch((url) => {
    const match = url.match(/product\/(\d+)\.json/);
    return match ? routes.get(match[1]) : undefined;
  });

const app = install();
serveFixtures();
routes.set(NUTELLA_BARCODE, NUTELLA);
await app.loadApp();

// ─────────────────────────── input handling ───────────────────────────

section("input validation");

for (const [input, shouldReject] of [
  ["", true], ["0", true], ["-5", true], ["abc", true], ["99999", true], ["50", false],
]) {
  app.el("weight").value = input;
  app.el("manual-barcode").value = NUTELLA_BARCODE;
  app.el("weight-error").hidden = true;
  app.el("manual-form").listeners.submit({ preventDefault() {} });
  const rejected = !app.el("weight-error").hidden;
  check(`weight ${JSON.stringify(input)} rejected = ${shouldReject}`,
        rejected === shouldReject, app.el("weight-error").textContent);
}
await wait(200);

// ──────────────────────────── calculation ─────────────────────────────

section("scaling");

await app.lookup(NUTELLA_BARCODE, 50);
check("results view shown", app.visible().join() === "results", app.visible().join());
check("50 g of Nutella = 270 kcal", /^270 kcal/.test(app.headline()[0]), app.headline()[0]);
check("50 g of Nutella = 3.1 g protein", /^3\.1 g/.test(app.headline()[1]), app.headline()[1]);
check("carbs and fat scale too",
      /^28\.8 g/.test(app.headline()[2]) && /^15\.4 g/.test(app.headline()[3]),
      app.headline().slice(2).join(" | "));
check("secondary nutrients render", app.secondary().join(" | ").includes("28.1"), app.secondary().join(" | "));
check("no NaN anywhere", !app.headline().concat(app.secondary()).some((t) => /NaN/.test(t)));

let fetchCalls = 0;
const counting = globalThis.fetch;
globalThis.fetch = (...args) => { fetchCalls++; return counting(...args); };
app.el("weight-results").value = "200";
app.el("weight-results").listeners.input();
check("editing weight recalculates to 1078 kcal", /^1078 kcal/.test(app.headline()[0]), app.headline()[0]);
check("editing weight makes no network request", fetchCalls === 0, `${fetchCalls} requests`);
globalThis.fetch = counting;

// kJ-only entries must still produce a calorie figure rather than a blank.
routes.set("1111111111111", {
  status: 1,
  product: {
    product_name: "kJ Only",
    nutriments: { energy_100g: 2252, energy_unit: "kJ", proteins_100g: 10 },
  },
});
await app.lookup("1111111111111", 100);
check("kJ-only entry converts to kcal (2252 kJ -> 538 kcal)", /^538 kcal/.test(app.headline()[0]), app.headline()[0]);

// ──────────────────────── barcode normalisation ───────────────────────

section("barcode normalisation");

// A 12-digit UPC-A must be retried as a zero-padded 13-digit EAN...
routes.set("0123456789012", { status: 1, product: { product_name: "Padded Match", nutriments: { "energy-kcal_100g": 100 } } });
await app.lookup("123456789012", 100);
check("12-digit UPC-A retried with a leading zero",
      app.el("product-name").textContent === "Padded Match", app.el("product-name").textContent);

// ...and a 13-digit EAN beginning with 0 retried with it stripped.
routes.set("987654321098", { status: 1, product: { product_name: "Stripped Match", nutriments: { "energy-kcal_100g": 100 } } });
await app.lookup("0987654321098", 100);
check("13-digit EAN retried with the leading zero stripped",
      app.el("product-name").textContent === "Stripped Match", app.el("product-name").textContent);

// ───────────────────────────── daily counter ──────────────────────────

section("daily counter");

check("cold start totals are 0 / 0", app.totals() === "0 / 0", app.totals());

await app.lookup(NUTELLA_BARCODE, 50);
const shownKcal = app.headline()[0].match(/^(\d+) kcal/)[1];
const shownProtein = app.headline()[1].match(/^([\d.]+) g/)[1];
app.click("btn-add-total");

check("button confirms the add", app.el("btn-add-total").textContent === "Added! ✓", app.el("btn-add-total").textContent);

// The invariant the whole rounding design exists to protect: a single add from
// zero must equal the numbers that were on screen. Derived from the rendered
// text, not hardcoded, so it keeps holding as the data changes.
check("totals equal the values displayed (no rounding drift)",
      app.totals() === `${shownKcal} / ${shownProtein}`,
      `${app.totals()} vs displayed ${shownKcal} / ${shownProtein}`);

await wait(1200);
check("returns to idle after the feedback delay", app.visible().join() === "idle", app.visible().join());
check("add button is reusable again",
      app.el("btn-add-total").textContent === "Add to Daily Total" && !app.el("btn-add-total").disabled);

await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
check("the same item twice totals 540 / 6.2", app.totals() === "540 / 6.2", app.totals());
await wait(1200);

// ───────────────────────────── persistence ────────────────────────────

section("persistence");

check("totals are written to localStorage",
      app.store.get("nutri-scanner-totals") === JSON.stringify({ kcal: 540, protein: 6.2 }),
      app.store.get("nutri-scanner-totals"));

// Scribbling over the rendered text first: without this, "stale text that was
// never re-rendered" is indistinguishable from "reloaded and rendered the same
// value", and the check passes for the wrong reason.
app.el("total-kcal").textContent = "STALE";
app.el("total-protein").textContent = "STALE";
await app.loadApp();
check("totals survive a reload", app.totals() === "540 / 6.2", app.totals());

app.store.set("nutri-scanner-totals", '{"kcal":"abc","protein":null}');
await app.loadApp();
check("corrupt storage loads as 0 / 0, never NaN", app.totals() === "0 / 0", app.totals());

app.store.set("nutri-scanner-totals", "not json at all");
await app.loadApp();
check("unparseable storage loads as 0 / 0", app.totals() === "0 / 0", app.totals());

// iOS Safari in Private Browsing throws on every write. Unguarded, this would
// break the add button outright on one of the two target phones.
const workingSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
await app.lookup(NUTELLA_BARCODE, 50);
let thrown = null;
try { app.click("btn-add-total"); } catch (err) { thrown = err; }
check("a throwing setItem doesn't break the add", thrown === null, thrown && thrown.message);
check("totals still update on screen without storage", app.totals() === "270 / 3.1", app.totals());
globalThis.localStorage.setItem = workingSetItem;
await wait(1200);

// ─────────────────────────────── reset ────────────────────────────────

section("reset");

globalThis.confirm = () => false;
app.click("btn-reset-counter");
check("cancelling the confirm leaves totals alone", app.totals() === "270 / 3.1", app.totals());

globalThis.confirm = () => true;
app.click("btn-reset-counter");
check("confirming zeroes the totals", app.totals() === "0 / 0", app.totals());
check("reset clears storage",
      app.store.get("nutri-scanner-totals") === JSON.stringify({ kcal: 0, protein: 0 }),
      app.store.get("nutri-scanner-totals"));

// ────────────────────────────── edge cases ────────────────────────────

section("missing and bad data");

routes.set("2222222222222", {
  status: 1,
  product: {
    product_name: "No Protein Listed",
    nutriments: { "energy-kcal_100g": 200, carbohydrates_100g: 10, fat_100g: 5 },
  },
});
await app.lookup("2222222222222", 100);
check("a missing nutrient renders as —", /^— g/.test(app.headline()[1]), app.headline()[1]);
app.click("btn-add-total");
check("missing protein contributes 0, not NaN", app.totals() === "200 / 0", app.totals());
await wait(1200);

// Found, but nobody has filled in the nutrition facts — distinct from missing.
routes.set("3333333333333", { status: 1, product: { product_name: "Empty Entry", nutriments: {} } });
await app.lookup("3333333333333", 100);
check("product with no nutrition data gets its own message",
      app.visible().join() === "error" && /no nutrition data/i.test(app.el("error-message").textContent),
      app.el("error-message").textContent);

routes = new Map();
await app.lookup("9999999999999", 100);
check("unknown barcode says not found",
      app.el("error-message").textContent === "Product not found in database.",
      app.el("error-message").textContent);

globalThis.fetch = () => Promise.reject(new TypeError("offline"));
await app.lookup(NUTELLA_BARCODE, 100);
check("network failure says network error",
      app.el("error-message").textContent === "Network error, please try again.",
      app.el("error-message").textContent);
serveFixtures();

// ──────────────────────── live API contract ───────────────────────────
// Values aren't asserted — only that the response still has the shape app.js
// reads. This is what would break silently if Open Food Facts changed its API.

if (LIVE) {
  section("live Open Food Facts contract");
  globalThis.fetch = realFetch;

  // An explicit controller rather than AbortSignal.timeout(): the latter leaves
  // a 15 s timer alive after the fetch resolves, holding the process open.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const fields = "product_name,brands,quantity,nutriments,nutrition_data_per";
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${NUTELLA_BARCODE}.json?fields=${fields}`,
      { signal: controller.signal },
    );
    check("live API responds 200", response.ok, `HTTP ${response.status}`);

    const data = await response.json();
    check("live API still returns status: 1", data.status === 1, `status=${data.status}`);

    const nutriments = data.product?.nutriments ?? {};
    const required = [
      "energy-kcal_100g", "proteins_100g", "carbohydrates_100g", "fat_100g",
      "sugars_100g", "saturated-fat_100g", "fiber_100g", "salt_100g",
    ];
    const missing = required.filter((key) => !Number.isFinite(Number(nutriments[key])));
    check("every nutriment key app.js reads is still present and numeric",
          missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all 8 present");
    check("nutrition_data_per is still reported", typeof data.product?.nutrition_data_per === "string",
          data.product?.nutrition_data_per);
  } catch (err) {
    check("live API reachable", false, `${err.name}: ${err.message} (re-run with --offline to skip)`);
  } finally {
    clearTimeout(timeout);
  }
} else {
  section("live Open Food Facts contract");
  console.log("skipped (--offline)");
}

finish();
