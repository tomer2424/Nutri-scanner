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
      app.store.get("nutri-scanner-totals") === JSON.stringify({ calories: 540, protein: 6.2, carbs: 57.6, fat: 30.8 }),
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
      app.store.get("nutri-scanner-totals") === JSON.stringify({ calories: 0, protein: 0, carbs: 0, fat: 0 }),
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

// ───────────────────── four macros and daily targets ──────────────────

section("four macros");

const TARGETS_KEY = "nutri-scanner-targets";
const storedTargets = () => JSON.parse(app.store.get(TARGETS_KEY) || "null");
const setTarget = (key, value) => { app.el(`target-${key}`).value = String(value); };
const submitTargets = () => app.el("targets-form").listeners.submit({ preventDefault() {} });

app.store.delete(TARGETS_KEY);
await clearAll();

check("four counter cards render", app.cards().length === 4, String(app.cards().length));
check("cards show current against the default target",
      app.cards()[0].startsWith("0 / 2000 kcal") && app.cards()[2].startsWith("0 / 250 g"),
      app.cards().join(" | "));
check("all four macros start at zero", app.macros() === "0 / 0 / 0 / 0", app.macros());

// ── crediting all four ──

await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
await wait(1200);

// 50 g of Nutella: 539/2 kcal, 6.3/2 protein, 57.5/2 carbs, 30.9/2 fat.
check("a scan credits all four macros", app.macros() === "270 / 3.1 / 28.8 / 15.4", app.macros());
check("the log entry stores all four",
      storedHistory()[0].carbs === 28.8 && storedHistory()[0].fat === 15.4,
      JSON.stringify(storedHistory()[0]));
check("progress bar reflects calories against target (270/2000)",
      app.meter("calories") === `${(270 / 2000) * 100}%`, app.meter("calories"));

// ── quick-add carries all four too ──

await app.lookup(NUTELLA_BARCODE, 100);
app.click("btn-save-meal");
check("a saved meal stores all four",
      storedMeals()[0].carbs === 57.5 && storedMeals()[0].fat === 30.9,
      JSON.stringify(storedMeals()[0]));
app.click("btn-reset");
tapMeal(0);
await wait(1200);
check("a quick-add credits all four", app.macros() === "809 / 9.4 / 86.3 / 46.3", app.macros());

// ── deleting decrements all four ──

tapLogDelete(0);
check("deleting decrements all four", app.macros() === "270 / 3.1 / 28.8 / 15.4", app.macros());

app.store.set(TOTALS_KEY, JSON.stringify({ calories: 5, protein: 0.1, carbs: 1, fat: 0.2 }));
await app.loadApp();
tapLogDelete(0);
check("every macro clamps at zero", app.macros() === "0 / 0 / 0 / 0", app.macros());

// ── targets: edit, validate, persist ──

await clearAll();
check("goals form starts hidden", app.el("targets-form").hidden === true);

app.click("btn-edit-goals");
check("Edit Goals opens the form", app.el("targets-form").hidden === false);
check("the form opens pre-filled with the saved targets",
      app.el("target-calories").value === "2000" && app.el("target-fat").value === "70",
      `${app.el("target-calories").value} / ${app.el("target-fat").value}`);

for (const [key, bad, why] of [
  ["calories", "", "empty"], ["protein", "0", "zero"],
  ["carbs", "-5", "negative"], ["fat", "abc", "not a number"],
]) {
  for (const macro of ["calories", "protein", "carbs", "fat"]) setTarget(macro, 100);
  setTarget(key, bad);
  app.el("targets-error").hidden = true;
  submitTargets();
  check(`a ${why} ${key} target is rejected`,
        !app.el("targets-error").hidden && app.el("targets-form").hidden === false,
        app.el("targets-error").textContent);
  check(`a rejected save commits nothing`, storedTargets() === null, JSON.stringify(storedTargets()));
}

setTarget("calories", 1500);
setTarget("protein", 120);
setTarget("carbs", 180);
setTarget("fat", 50);
submitTargets();

check("valid goals are saved",
      JSON.stringify(storedTargets()) === JSON.stringify({ calories: 1500, protein: 120, carbs: 180, fat: 50 }),
      JSON.stringify(storedTargets()));
check("saving closes the form", app.el("targets-form").hidden === true);
check("cards update to the new targets immediately",
      app.cards()[0].startsWith("0 / 1500 kcal"), app.cards()[0]);

await app.loadApp();
check("targets survive a reload", app.cards()[0].startsWith("0 / 1500 kcal"), app.cards()[0]);
check("a reset leaves targets alone", (() => {
  globalThis.confirm = () => true;
  app.click("btn-reset-counter");
  return app.cards()[0].startsWith("0 / 1500 kcal");
})(), app.cards()[0]);

// ── progress bar capping ──

app.store.set(TARGETS_KEY, JSON.stringify({ calories: 100, protein: 1, carbs: 1, fat: 1 }));
await clearAll();   // clearAll deliberately leaves targets in place
await app.lookup(NUTELLA_BARCODE, 50);
app.click("btn-add-total");
await wait(1200);
check("an overshooting bar caps at 100%", app.meter("calories") === "100%", app.meter("calories"));
check("the card still shows the real total, not the capped one",
      app.cards()[0].startsWith("270 / 100 kcal"), app.cards()[0]);

// ── legacy stored shapes ──

app.store.delete(TARGETS_KEY);
app.store.set(TOTALS_KEY, JSON.stringify({ kcal: 540, protein: 6.2 }));   // pre-carbs/fat
app.store.set(MEALS_KEY, JSON.stringify([
  { id: 1, name: "Legacy Meal", weight: 50, calories: 270, protein: 3.1 },
]));
app.store.set(HISTORY_KEY, JSON.stringify([
  { id: 2, name: "Legacy Entry", weight: 50, calories: 270, protein: 3.1, timestamp: 1 },
]));
await app.loadApp();

check("legacy totals keep their calories and default the rest to zero",
      app.macros() === "540 / 6.2 / 0 / 0", app.macros());
check("legacy meal still lists", mealLabels().length === 1 && mealLabels()[0].startsWith("Legacy Meal"), mealLabels().join(" | "));
check("legacy log entry still lists", logLabels().length === 1 && logLabels()[0].startsWith("Legacy Entry"), logLabels().join(" | "));
check("no NaN anywhere from the legacy shapes",
      !/NaN/.test(app.macros() + app.cards().join("") + mealLabels().join("") + logLabels().join("")),
      app.macros());

tapMeal(0);
await wait(1200);
check("adding a legacy meal treats its missing macros as zero",
      app.macros() === "810 / 9.3 / 0 / 0", app.macros());

tapLogDelete(0);
check("deleting a legacy log entry decrements without NaN",
      !/NaN/.test(app.macros()), app.macros());

await clearAll();
app.store.delete(TARGETS_KEY);

// ── corrupt targets ──

app.store.set(TARGETS_KEY, JSON.stringify({ calories: "abc", protein: -5, carbs: 180 }));
await app.loadApp();
check("bad target fields fall back individually, keeping the good one",
      app.cards()[0].startsWith("0 / 2000 kcal") && app.cards()[2].startsWith("0 / 180 g"),
      app.cards().join(" | "));

app.store.set(TARGETS_KEY, "not json");
await app.loadApp();
check("unparseable targets fall back to the defaults",
      app.cards()[0].startsWith("0 / 2000 kcal"), app.cards()[0]);

app.store.delete(TARGETS_KEY);
await clearAll();

// ───────────────────── custom manual entry ────────────────────────────

section("custom manual entry");

const setCustom = (key, value) => { app.el(`custom-${key}`).value = String(value); };
const fireCustom = () => app.el("custom-form").listeners.submit({ preventDefault() {} });
const customError = () => (app.el("custom-error").hidden ? null : app.el("custom-error").textContent);
const clearCustomFields = () => {
  app.el("custom-name").value = "";
  for (const key of ["calories", "protein", "carbs", "fat"]) setCustom(key, "");
  app.el("custom-save-meal").checked = false;
};

await clearAll();

check("the custom form starts hidden", app.el("custom-form").hidden === true);
app.click("btn-custom-toggle");
check("the toggle opens it", app.el("custom-form").hidden === false);

// ── validation ──

for (const [key, bad, why] of [
  ["calories", "-5", "a negative value"],
  ["protein", "abc", "a non-number"],
  ["carbs", "999999", "an implausible value"],
]) {
  clearCustomFields();
  setCustom("calories", 100);
  setCustom(key, bad);
  app.el("custom-error").hidden = true;
  fireCustom();
  check(`${why} in ${key} is rejected`, customError() !== null, customError());
  check(`nothing is logged when ${key} is rejected`, storedHistory().length === 0, JSON.stringify(storedHistory()));
}

clearCustomFields();
fireCustom();
check("an entirely blank submission is rejected",
      customError() === "Enter at least one value.", customError());
check("and logs nothing", storedHistory().length === 0);

// ── a valid custom entry ──

clearCustomFields();
app.el("custom-name").value = "Homemade Soup";
setCustom("calories", 250);
setCustom("protein", 20);
// carbs and fat deliberately blank — they must read as 0, not NaN
fireCustom();

check("a valid entry logs", storedHistory().length === 1, JSON.stringify(storedHistory()));
check("blank macro fields default to zero",
      storedHistory()[0].carbs === 0 && storedHistory()[0].fat === 0,
      JSON.stringify(storedHistory()[0]));
check("it credits every macro", app.macros() === "250 / 20 / 0 / 0", app.macros());
check("the log row omits the weight rather than printing 0g",
      logLabels()[0] === "Homemade Soup (250 kcal, 20g)", logLabels()[0]);
check("the form clears after logging",
      app.el("custom-name").value === "" && app.el("custom-calories").value === "",
      `${app.el("custom-name").value} / ${app.el("custom-calories").value}`);
check("the button confirms", app.el("btn-custom-submit").textContent === "Logged! ✓");

await wait(1200);
check("the button becomes usable again",
      app.el("btn-custom-submit").textContent === "Log it" && !app.el("btn-custom-submit").disabled);

// ── deleting a custom entry ──

tapLogDelete(0);
check("deleting a custom entry decrements the totals", app.macros() === "0 / 0 / 0 / 0", app.macros());
check("and removes it from storage", storedHistory().length === 0, JSON.stringify(storedHistory()));

// ── name fallback and length cap ──

await clearAll();
app.click("btn-custom-toggle");
clearCustomFields();
setCustom("calories", 100);
fireCustom();
check("a blank name falls back to Custom Entry",
      storedHistory()[0].name === "Custom Entry", storedHistory()[0].name);

clearCustomFields();
app.el("custom-name").value = "N".repeat(200);
setCustom("calories", 100);
fireCustom();
check("an absurdly long name is capped",
      storedHistory()[1].name.length === 60, `${storedHistory()[1].name.length} chars`);

// ── optionally saving as a quick-add ──

await clearAll();
app.click("btn-custom-toggle");
clearCustomFields();
app.el("custom-name").value = "Protein Shake";
setCustom("calories", 180);
setCustom("protein", 30);
fireCustom();
check("unchecked, it does not become a saved meal", storedMeals().length === 0, JSON.stringify(storedMeals()));

clearCustomFields();
app.el("custom-name").value = "Protein Shake";
setCustom("calories", 180);
setCustom("protein", 30);
app.el("custom-save-meal").checked = true;
fireCustom();
check("checked, it is also saved as a quick-add",
      storedMeals().length === 1 && storedMeals()[0].name === "Protein Shake"
      && storedMeals()[0].calories === 180, JSON.stringify(storedMeals()));
check("the saved meal shows without a weight",
      mealLabels()[0] === "Protein Shake (180 kcal, 30g)", mealLabels()[0]);

tapMeal(0);
await wait(1200);
check("the custom quick-add credits correctly when tapped",
      app.macros() === "540 / 90 / 0 / 0", app.macros());

// ── untrusted custom names ──

await clearAll();
app.click("btn-custom-toggle");
clearCustomFields();
app.el("custom-name").value = NASTY_NAME;
setCustom("calories", 100);
fireCustom();

const customNastyRow = logRows()[0].children[0];
check("a custom name is rendered as inert literal text",
      customNastyRow.textContent.includes(NASTY_NAME) && customNastyRow.children.length === 0,
      customNastyRow.textContent.slice(0, 40));
check("it is stored verbatim rather than mangled",
      storedHistory()[0].name === NASTY_NAME, storedHistory()[0].name);

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
