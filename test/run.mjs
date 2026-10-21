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

// ──────────────────────────── saved meals ─────────────────────────────

section("saved meals");

const MEALS_KEY = "nutri-scanner-meals";
const mealRows = () => app.el("meals-list").children;
const mealLabels = () => mealRows().map((row) => row.children[0].textContent);
const tapMeal = (i) => mealRows()[i].children[0].listeners.click();
const tapDelete = (i) => mealRows()[i].children[1].listeners.click();
const storedMeals = () => JSON.parse(app.store.get(MEALS_KEY) || "[]");

// The not-found checks above reset `routes`, so re-register the fixture.
routes.set(NUTELLA_BARCODE, NUTELLA);

app.store.delete(MEALS_KEY);
app.store.delete("nutri-scanner-totals");
await app.loadApp();
check("with nothing saved, the section is hidden", app.el("meals-section").hidden === true);

await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-save-meal");
check("save button confirms and disables",
      app.el("btn-save-meal").textContent === "Saved! ✓" && app.el("btn-save-meal").disabled);
check("meal stored with the values that were displayed",
      storedMeals().length === 1 && storedMeals()[0].name === "Nutella"
      && storedMeals()[0].weight === 50 && storedMeals()[0].calories === 270
      && storedMeals()[0].protein === 3.1, JSON.stringify(storedMeals()[0]));

app.click("btn-reset");
check("section appears on idle once something is saved", app.el("meals-section").hidden === false);
check("label matches the addendum's format",
      mealLabels()[0] === "Nutella — 50g (270 kcal, 3.1g)", mealLabels()[0]);
check("save button is usable again after reset",
      app.el("btn-save-meal").textContent === "Save as Quick Add" && !app.el("btn-save-meal").disabled);

check("totals start at 0 / 0", app.totals() === "0 / 0", app.totals());
tapMeal(0);
const viaQuickAdd = app.totals();
check("tapping a saved meal credits the totals", viaQuickAdd === "270 / 3.1", viaQuickAdd);

// Both paths run through creditTotals(), and the saved figures came from
// displayed() — so a quick-add must land on exactly the same total as scanning
// the item and pressing Add. This is the invariant that keeps them in step.
globalThis.confirm = () => true;
app.click("btn-reset-counter");
await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
await wait(1200);
check("a quick-add equals adding the same item live",
      app.totals() === viaQuickAdd, `live ${app.totals()} vs quick-add ${viaQuickAdd}`);
app.click("btn-reset-counter");

// Delete targets by id, so ids must stay distinct even when the clock doesn't move.
app.store.delete(MEALS_KEY);
await app.loadApp();
const realNow = Date.now;
Date.now = () => 1700000000000;
await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-save-meal");
app.click("btn-reset");
await app.lookup(NUTELLA_BARCODE, 100);
app.click("btn-save-meal");
app.click("btn-reset");
Date.now = realNow;

const bothMeals = storedMeals();
check("two saves in the same millisecond still get distinct ids",
      bothMeals.length === 2 && bothMeals[0].id !== bothMeals[1].id,
      bothMeals.map((meal) => meal.id).join(", "));
check("both meals are listed", mealRows().length === 2, mealLabels().join(" | "));

tapDelete(0);
check("delete removes only that row",
      mealRows().length === 1 && mealLabels()[0].includes("100g"), mealLabels().join(" | "));
check("delete is persisted",
      storedMeals().length === 1 && storedMeals()[0].id === bothMeals[1].id,
      JSON.stringify(storedMeals()));

// ── storage robustness ──

app.store.set(MEALS_KEY, '{"not":"an array"}');
await app.loadApp();
check("non-array meals storage loads as an empty list",
      mealRows().length === 0 && app.el("meals-section").hidden === true);

app.store.set(MEALS_KEY, "garbage");
await app.loadApp();
check("unparseable meals storage loads as an empty list", mealRows().length === 0);

app.store.set(MEALS_KEY, JSON.stringify([
  { id: 1, name: "Good Row", weight: 50, calories: 100, protein: 5 },
  { id: 2, name: "Bad Weight", weight: "abc", calories: 100, protein: 5 },
  { id: 3, name: "Null Calories", weight: 50, calories: null, protein: 5 },
  { name: "No Id", weight: 50, calories: 100, protein: 5 },
  null,
]));
await app.loadApp();
check("malformed rows are dropped and the good one kept",
      mealRows().length === 1 && mealLabels()[0].startsWith("Good Row"), mealLabels().join(" | "));
check("no NaN reaches the rendered list", !mealLabels().some((label) => /NaN/.test(label)));

// ── iOS Private Browsing ──
// The addendum says to re-read storage on every idle transition. Done literally
// that fails here: the write throws, so the meal just saved would vanish the
// moment the app returned home. Rendering from memory is why this passes.

app.store.delete(MEALS_KEY);
await app.loadApp();
const realSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };

await app.lookup(NUTELLA_BARCODE, 50);
let saveThrew = null;
try { app.click("btn-save-meal"); } catch (err) { saveThrew = err; }
check("saving survives a throwing setItem", saveThrew === null, saveThrew && saveThrew.message);

app.click("btn-reset");
check("the meal still lists for the session when storage is unavailable",
      mealRows().length === 1, mealLabels().join(" | "));
tapMeal(0);
check("and it still credits the totals", app.totals() === "270 / 3.1", app.totals());
globalThis.localStorage.setItem = realSetItem;

// ── untrusted product names ──
// Open Food Facts is editable by anyone, and these names are persisted and
// re-rendered on every idle transition.

const NASTY_NAME = '<img src=x onerror="alert(1)">';
routes.set("4444444444444", {
  status: 1,
  product: {
    product_name: NASTY_NAME + "A".repeat(200),
    nutriments: { "energy-kcal_100g": 100, proteins_100g: 2 },
  },
});

app.store.delete(MEALS_KEY);
await app.loadApp();
await app.lookup("4444444444444", 100);
app.click("btn-save-meal");
app.click("btn-reset");

const nastyButton = mealRows()[0].children[0];
check("an untrusted product name renders as inert literal text",
      nastyButton.textContent.includes(NASTY_NAME) && nastyButton.children.length === 0,
      nastyButton.textContent.slice(0, 40));
check("absurdly long names are capped",
      storedMeals()[0].name.length === 60, `${storedMeals()[0].name.length} chars`);

app.store.delete(MEALS_KEY);
app.store.delete("nutri-scanner-totals");

// ──────────────────────────── today's log ─────────────────────────────

section("today's log");

const HISTORY_KEY = "nutri-scanner-history";
const TOTALS_KEY = "nutri-scanner-totals";
const logRows = () => app.el("log-list").children;
const logLabels = () => logRows().map((row) => row.children[0].textContent);
const tapLogDelete = (i) => logRows()[i].children[1].listeners.click();
const storedHistory = () => JSON.parse(app.store.get(HISTORY_KEY) || "[]");
const emptyStateShown = () => !app.el("log-empty").hidden;
const sumOf = (field, decimals) =>
  Number(storedHistory().reduce((total, entry) => total + entry[field], 0).toFixed(decimals));

const clearAll = async () => {
  app.store.delete(HISTORY_KEY);
  app.store.delete(MEALS_KEY);
  app.store.delete(TOTALS_KEY);
  await app.loadApp();
};

routes.set(NUTELLA_BARCODE, NUTELLA);
await clearAll();

check("an empty log shows the empty-state message",
      emptyStateShown() && logRows().length === 0);

// ── logged from a scan ──

await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
await wait(1200);

check("adding from a scan writes a log entry", storedHistory().length === 1, JSON.stringify(storedHistory()));
const logged = storedHistory()[0];
check("the entry carries the whole schema",
      logged.id !== undefined && logged.name === "Nutella" && logged.weight === 50
      && logged.calories === 270 && logged.protein === 3.1 && Number.isFinite(logged.timestamp),
      JSON.stringify(logged));
check("the empty-state message hides once something is logged", !emptyStateShown());
check("the row renders in the specified format",
      logLabels()[0] === "Nutella — 50g (270 kcal, 3.1g)", logLabels()[0]);
check("totals agree with the log", app.totals() === "270 / 3.1", app.totals());

// ── logged from a quick-add ──

await app.lookup(NUTELLA_BARCODE, 100);
app.click("btn-save-meal");
app.click("btn-reset");
tapMeal(0);
await wait(1200);

check("adding from a quick-add also writes a log entry", storedHistory().length === 2, JSON.stringify(storedHistory()));
check("the log renders newest first",
      logLabels()[0].includes("100g") && logLabels()[1].includes("50g"), logLabels().join(" | "));
check("totals cover both routes", app.totals() === "809 / 9.4", app.totals());

// ── deleting an entry ──

tapLogDelete(0);
check("deleting removes just that entry", storedHistory().length === 1, JSON.stringify(storedHistory()));
check("deleting decrements the totals exactly", app.totals() === "270 / 3.1", app.totals());
check("the remaining entry is untouched",
      logRows().length === 1 && logLabels()[0].includes("50g"), logLabels().join(" | "));

// Totals and log can only disagree if storage was tampered with, but the
// subtraction must never leave a negative counter on screen.
app.store.set(TOTALS_KEY, JSON.stringify({ kcal: 10, protein: 0.5 }));
await app.loadApp();
tapLogDelete(0);
check("totals clamp at zero instead of going negative", app.totals() === "0 / 0", app.totals());

// ── reset clears the log too ──

await clearAll();
await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
await wait(1200);
check("something is logged before the reset", storedHistory().length === 1);

globalThis.confirm = () => false;
app.click("btn-reset-counter");
check("a cancelled reset leaves the log alone", storedHistory().length === 1, JSON.stringify(storedHistory()));

globalThis.confirm = () => true;
app.click("btn-reset-counter");
check("reset clears the log", storedHistory().length === 0 && logRows().length === 0, JSON.stringify(storedHistory()));
check("reset brings the empty state back", emptyStateShown());
check("reset zeroes the totals", app.totals() === "0 / 0", app.totals());

// ── storage robustness ──

app.store.set(HISTORY_KEY, "not json at all");
await app.loadApp();
check("unparseable history loads as an empty log", logRows().length === 0 && emptyStateShown());

app.store.set(HISTORY_KEY, '{"not":"an array"}');
await app.loadApp();
check("non-array history loads as an empty log", logRows().length === 0);

app.store.set(HISTORY_KEY, JSON.stringify([
  { id: 1, name: "Good Entry", weight: 50, calories: 100, protein: 5, timestamp: 1 },
  { id: 2, name: "No Timestamp", weight: 50, calories: 100, protein: 5 },
  { id: 3, name: "Bad Calories", weight: 50, calories: "abc", protein: 5, timestamp: 2 },
  null,
]));
await app.loadApp();
check("malformed log entries are dropped and the good one kept",
      logRows().length === 1 && logLabels()[0].startsWith("Good Entry"), logLabels().join(" | "));
check("no NaN reaches the log", !logLabels().some((label) => /NaN/.test(label)));

// ── iOS Private Browsing ──

await clearAll();
const logSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };

await app.lookup(NUTELLA_BARCODE, 50);
let logThrew = null;
try { app.click("btn-add-total"); } catch (err) { logThrew = err; }
await wait(1200);
check("logging survives a throwing setItem", logThrew === null, logThrew && logThrew.message);
check("the entry still lists for the session without storage",
      logRows().length === 1, logLabels().join(" | "));
globalThis.localStorage.setItem = logSetItem;

// ── untrusted names reach the log too ──

routes.set("5555555555555", {
  status: 1,
  product: { product_name: NASTY_NAME, nutriments: { "energy-kcal_100g": 100, proteins_100g: 2 } },
});
await clearAll();
await app.lookup("5555555555555", 100);
app.click("btn-add-total");
await wait(1200);
const nastyLogLabel = logRows()[0].children[0];
check("an untrusted name in the log renders as inert text",
      nastyLogLabel.textContent.includes(NASTY_NAME) && nastyLogLabel.children.length === 0,
      nastyLogLabel.textContent.slice(0, 40));

// ── the invariant: the counter is the log's sum ──

await clearAll();
for (const grams of [50, 100, 25]) {
  await app.lookup(NUTELLA_BARCODE, grams);
  app.click("btn-add-total");
  await wait(1200);
}
check("totals equal the sum of the log",
      app.totals() === `${sumOf("calories", 0)} / ${sumOf("protein", 1)}`,
      `${app.totals()} vs log sum ${sumOf("calories", 0)} / ${sumOf("protein", 1)}`);

tapLogDelete(1);   // remove the middle entry
check("totals still equal the sum after a delete",
      app.totals() === `${sumOf("calories", 0)} / ${sumOf("protein", 1)}`,
      `${app.totals()} vs log sum ${sumOf("calories", 0)} / ${sumOf("protein", 1)}`);

await clearAll();

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
