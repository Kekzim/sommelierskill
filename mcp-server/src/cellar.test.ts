import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "./db.js";
import { Cellar, parseRack, thisYear, today } from "./cellar.js";

interface Fixture {
  product_id: string;
  product_number: string;
  full_name: string;
  producer: string;
  vintage: number | null;
  price: number;
  taste: string | null;
  availability?: string;
  grapes?: string[];
  /** body, tannin, sweetness, fruit acid. All zero is how Systembolaget writes "not rated". */
  clocks?: [number, number, number, number];
}

/** A mirror with just the columns the cellar reads, written the way the sync publishes it. */
function writeMirror(path: string, products: Fixture[]): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(`
    CREATE TABLE product (
      product_id TEXT PRIMARY KEY, product_number TEXT, full_name TEXT, producer TEXT,
      vintage INTEGER, country TEXT, origin1 TEXT, origin2 TEXT, cat2 TEXT, volume_ml INTEGER,
      price REAL, availability TEXT, is_discontinued INTEGER DEFAULT 0, taste TEXT,
      clock_body INTEGER, clock_tannin INTEGER, clock_sweetness INTEGER, clock_fruitacid INTEGER,
      abv REAL, sugar_g_per_100ml REAL);
    CREATE TABLE product_grape (product_id TEXT, grape TEXT, raw_name TEXT);`);
  for (const p of products) {
    db.prepare(
      `INSERT INTO product VALUES (?, ?, ?, ?, ?, 'Frankrike', 'Frankrike sydväst', 'Madiran',
         'Rött vin', 750, ?, ?, 0, ?, ?, ?, ?, ?, 14.5, 0.35)`,
    ).run(
      p.product_id,
      p.product_number,
      p.full_name,
      p.producer,
      p.vintage,
      p.price,
      p.availability ?? "order_only",
      p.taste,
      ...(p.clocks ?? [11, 11, 1, 7]),
    );
    for (const g of p.grapes ?? []) {
      db.prepare(`INSERT INTO product_grape VALUES (?, ?, ?)`).run(p.product_id, g, g);
    }
  }
  db.close();
  // Renamed into place, like the publish step, so the Mirror sees a new inode.
  renameSync(tmp, path);
}

const MONTUS: Fixture = {
  product_id: "56305",
  product_number: "5630501",
  full_name: "Château Montus",
  producer: "Alain Brumont",
  vintage: 2012,
  price: 429,
  taste: "Kryddig smak med inslag av mörka körsbär, tobak och ek.",
  grapes: ["Tannat", "Cabernet sauvignon"],
};

let dir: string;
let mirrorPath: string;
let mirror: Mirror;
let cellar: Cellar;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-test-"));
  mirrorPath = join(dir, "bolaget.db");
  writeMirror(mirrorPath, [MONTUS]);
  mirror = new Mirror(mirrorPath);
  cellar = new Cellar(join(dir, "cellar", "cellar.db"), mirror);
});

afterEach(() => {
  cellar.close();
  mirror.close();
  rmSync(dir, { recursive: true, force: true });
});

test("adding by product number copies identity, grapes and the tasting note", () => {
  const { wine, merged, warnings } = cellar.add({ product_number: "5630501", quantity: 3 });
  assert.equal(merged, false);
  assert.deepEqual(warnings, []);
  assert.equal(wine.product_id, "56305");
  assert.equal(wine.name, "Château Montus");
  assert.equal(wine.vintage, 2012);
  assert.equal(wine.region, "Frankrike sydväst, Madiran");
  assert.equal(wine.grapes, "Cabernet sauvignon, Tannat");
  assert.equal(wine.sb_taste, MONTUS.taste);
  assert.equal(wine.clock_tannin, 11);
  assert.equal(wine.abv, 14.5);
  assert.equal(wine.sugar_g_l, 3.5, "g/100 ml becomes g/L without float noise");
  assert.equal(wine.quantity, 3);
});

test("the same wine and vintage tops up one entry; explicit fields apply", () => {
  cellar.add({ product_id: "56305", quantity: 2, location: "rack A" });
  const { wine, merged } = cellar.add({ product_id: "56305", quantity: 1, location: "rack B" });
  assert.equal(merged, true);
  assert.equal(wine.quantity, 3);
  assert.equal(wine.location, "rack B");
  assert.equal(cellar.list({ limit: 10, offset: 0 }).total, 1);
});

test("an older vintage under the same id is a separate entry without the new vintage's note", () => {
  cellar.add({ product_id: "56305", quantity: 1 });
  const { wine, merged, warnings } = cellar.add({ product_id: "56305", vintage: 2010, quantity: 1 });
  assert.equal(merged, false);
  assert.equal(wine.vintage, 2010);
  assert.equal(wine.sb_taste, null);
  assert.equal(wine.clock_tannin, null);
  assert.equal(wine.sugar_g_l, null);
  assert.match(warnings[0], /lists this wine as the 2012; yours is the 2010/);
});

test("when Systembolaget moves on to the next vintage, the cellar keeps its own note and says so", () => {
  cellar.add({ product_id: "56305", quantity: 1 });
  writeMirror(mirrorPath, [{ ...MONTUS, vintage: 2016, price: 499, taste: "Helt annan årgång." }]);

  const [w] = cellar.list({ limit: 10, offset: 0 }).items;
  assert.equal(w.vintage, 2012);
  assert.equal(w.sb_taste, MONTUS.taste);
  assert.deepEqual(w.systembolaget, { vintage: 2016, price: 499, availability: "order_only", same_vintage: false });
});

test("a delisted wine stays in the cellar, marked as no longer sold", () => {
  cellar.add({ product_id: "56305", quantity: 1 });
  writeMirror(mirrorPath, []);
  const [w] = cellar.list({ limit: 10, offset: 0 }).items;
  assert.equal(w.name, "Château Montus");
  assert.equal(w.product_id, "56305");
  assert.equal(w.systembolaget, null);
});

test("an id and a number that collide are told apart", () => {
  // Real: 12 products have an id that is another product's number.
  writeMirror(mirrorPath, [
    { ...MONTUS, product_id: "111", product_number: "222", full_name: "By number" },
    { ...MONTUS, product_id: "222", product_number: "333", full_name: "By id" },
  ]);
  assert.equal(cellar.add({ product_number: "222", quantity: 1 }).wine.name, "By number");
  assert.equal(cellar.add({ product_id: "222", quantity: 1 }).wine.name, "By id");
  assert.throws(() => cellar.add({ product_id: "222", product_number: "222", quantity: 1 }), /id 222 and number 222/);
});

test("an unknown product is refused, and a wine from elsewhere needs a name", () => {
  assert.throws(() => cellar.add({ product_id: "999", quantity: 1 }), /No Systembolaget product/);
  assert.throws(() => cellar.add({ quantity: 1 }), /needs a name/);
});

test("wines from elsewhere work with no mirror at all", () => {
  const lonely = new Cellar(join(dir, "other.db"), new Mirror(join(dir, "missing.db")));
  const { wine } = lonely.add({ name: "Barolo Cannubi", vintage: 2019, quantity: 2, purchased_from: "gift" });
  const [w] = lonely.list({ limit: 10, offset: 0 }).items;
  assert.equal(w.id, wine.id);
  assert.equal(w.systembolaget, null);
  lonely.close();
});

test("removing keeps history and ratings, and refuses more than is there", () => {
  const { wine } = cellar.add({ product_id: "56305", quantity: 2 });
  cellar.remove(wine.id, { quantity: 1, reason: "drunk", rating: 5, note: "with lamb" });
  assert.throws(() => cellar.remove(wine.id, { quantity: 2, reason: "drunk" }), /Only 1 bottle/);
  const after = cellar.remove(wine.id, { quantity: 1, reason: "gift" });
  assert.equal(after.quantity, 0);

  assert.equal(cellar.list({ limit: 10, offset: 0 }).total, 0, "empty wines are hidden by default");
  const [w] = cellar.list({ include_empty: true, limit: 10, offset: 0 }).items;
  assert.equal(w.avg_rating, 5);
  assert.equal(w.times_drunk, 1, "a gift is not a bottle drunk");
  assert.equal(w.last_note, "with lamb");
  assert.deepEqual(
    cellar.history(wine.id).map((e) => [e.kind, e.reason, e.quantity]),
    [
      ["added", null, 2],
      ["removed", "drunk", -1],
      ["removed", "gift", -1],
    ],
  );
  assert.equal(cellar.list({ include_empty: true, min_rating: 4, limit: 10, offset: 0 }).total, 1);
  assert.equal(cellar.list({ include_empty: true, min_rating: 5.5, limit: 10, offset: 0 }).total, 0);
});

test("update: omitted keeps, null clears, and a count correction is recorded", () => {
  const { wine } = cellar.add({ product_id: "56305", quantity: 2, location: "rack A", notes: "for the wedding" });
  const w = cellar.update(wine.id, { location: null, drink_from: 2027, quantity: 5 });
  assert.equal(w.location, null);
  assert.equal(w.notes, "for the wedding");
  assert.equal(w.drink_from, 2027);
  assert.equal(w.quantity, 5);
  assert.deepEqual(cellar.history(wine.id).at(-1)?.quantity, 3);
  assert.throws(() => cellar.update(wine.id, { name: "" }), /cannot be cleared/);
  assert.throws(() => cellar.update(9999, { notes: "x" }), /No wine #9999/);
});

test("correcting the vintage drops the note copied for the old one", () => {
  const { wine } = cellar.add({ product_id: "56305", quantity: 1 });
  const w = cellar.update(wine.id, { vintage: 2011 });
  assert.equal(w.sb_taste, null);
  assert.equal(w.clock_body, null);
});

test("drinking windows are judged against this year", () => {
  const y = thisYear();
  const add = (name: string, drink_from: number | null, drink_until: number | null) =>
    cellar.add({ name, drink_from, drink_until, quantity: 1 });
  add("ready", y - 2, y + 5);
  add("soon", y - 5, y + 1);
  add("past", y - 10, y - 1);
  add("young", y + 3, y + 10);
  add("unknown", null, null);

  const names = (drink_window: "ready" | "drink_soon" | "not_yet" | "unknown") =>
    cellar.list({ drink_window, limit: 10, offset: 0 }).items.map((w) => w.name).sort();
  assert.deepEqual(names("ready"), ["ready", "soon"]);
  assert.deepEqual(names("drink_soon"), ["past", "soon"]);
  assert.deepEqual(names("not_yet"), ["young"]);
  assert.deepEqual(names("unknown"), ["unknown"]);
});

test("the cellar survives a restart", () => {
  cellar.add({ product_id: "56305", quantity: 4 });
  cellar.close();
  const again = new Cellar(join(dir, "cellar", "cellar.db"), mirror);
  assert.deepEqual(again.summary(), { wines: 1, bottles: 4, value: null, value_by_currency: {} });
  again.close();
});

test("an unwritable directory is explained as a permissions problem", { skip: process.getuid?.() === 0 }, () => {
  const locked = join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  const c = new Cellar(join(locked, "cellar.db"), mirror);
  assert.throws(() => c.summary(), /chown -R 10001:10001/);
  chmodSync(locked, 0o700);
});

test("a Champagne nobody describes is queued, filled in with sources, and dated", () => {
  const { wine } = cellar.add({
    producer: "Egly-Ouriet",
    name: "Brut Tradition",
    vintage: null,
    category: "Mousserande vin",
    grapes: "Pinot noir 70%, Chardonnay 30%",
    style: "Grand Cru, Brut",
    sugar_g_l: 2,
    base_vintage: 2019,
    disgorged_on: "2024-03",
    quantity: 6,
  });
  cellar.add({ product_id: "56305", quantity: 1 }); // described by Systembolaget

  const queue = () => cellar.list({ needs_profile: true, limit: 10, offset: 0 }).items.map((w) => w.name);
  assert.deepEqual(queue(), ["Brut Tradition"]);

  assert.throws(
    () => cellar.update(wine.id, { claude_profile: "Vinous and Pinot-led." }),
    /needs claude_sources/,
  );
  const filled = cellar.update(wine.id, {
    claude_profile: "Vinous and Pinot-led.",
    claude_sources: "house sheet (https://example.com); drinking window: Claude's estimate",
    drink_from: 2025,
    drink_until: 2030,
  });
  assert.equal(filled.claude_profiled_on, today());
  assert.equal(filled.base_vintage, 2019, "label facts are untouched by a profile");
  assert.deepEqual(queue(), []);
  assert.equal(cellar.list({ search: "Grand Cru", limit: 10, offset: 0 }).total, 1);
  assert.equal(cellar.list({ search: "Pinot-led", limit: 10, offset: 0 }).total, 1);

  const cleared = cellar.update(wine.id, { claude_profile: null, claude_sources: null });
  assert.equal(cleared.claude_profiled_on, null);
  assert.deepEqual(queue(), ["Brut Tradition"]);
});

test("a cellar written by the first release gains the new columns and keeps its wines", () => {
  const path = join(dir, "v1.db");
  const old = new DatabaseSync(path);
  // The first release's wine table, as it shipped.
  old.exec(`
    CREATE TABLE wine (
      id INTEGER PRIMARY KEY, product_id TEXT, product_number TEXT, name TEXT NOT NULL,
      producer TEXT, vintage INTEGER, country TEXT, region TEXT, category TEXT, grapes TEXT,
      volume_ml INTEGER, quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      purchase_price REAL, purchased_on TEXT, purchased_from TEXT, location TEXT,
      drink_from INTEGER, drink_until INTEGER, notes TEXT, sb_taste TEXT, clock_body INTEGER,
      clock_tannin INTEGER, clock_sweetness INTEGER, clock_fruitacid INTEGER,
      added_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO wine (name, quantity, added_at, updated_at) VALUES ('Old friend', 3, 'x', 'x');
    PRAGMA user_version = 1;`);
  old.close();

  const upgraded = new Cellar(path, mirror);
  assert.deepEqual(upgraded.summary(), { wines: 1, bottles: 3, value: null, value_by_currency: {} });
  const w = upgraded.update(1, { disgorged_on: "2023", claude_profile: "x", claude_sources: "y" });
  assert.equal(w.disgorged_on, "2023");
  upgraded.close();

  const check = new DatabaseSync(path);
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  check.close();
});

const GOSSET: Fixture = {
  product_id: "65330504",
  product_number: "9061306",
  full_name: "Gosset Grand Millésime",
  producer: "Champagne Gosset",
  vintage: 2015,
  price: 1899,
  taste: null,
  clocks: [0, 0, 0, 0],
};

test("an unrated product's all-zero clocks are not copied in as a rating", () => {
  writeMirror(mirrorPath, [MONTUS, GOSSET]);
  const unrated = cellar.add({ product_id: "65330504", quantity: 1 }).wine;
  assert.deepEqual(
    [unrated.clock_body, unrated.clock_tannin, unrated.clock_sweetness, unrated.clock_fruitacid],
    [null, null, null, null],
  );
  const rated = cellar.add({ product_id: "56305", quantity: 1 }).wine;
  assert.deepEqual([rated.clock_body, rated.clock_tannin, rated.clock_sweetness, rated.clock_fruitacid], [11, 11, 1, 7]);
});

test("opening a v2 cellar clears clocks copied in as all zeros, and keeps real ones", () => {
  const path = join(dir, "v2", "cellar.db");
  const first = new Cellar(path, mirror);
  first.add({ name: "placeholder", quantity: 1 }); // creates the schema
  first.close();

  const raw = new DatabaseSync(path);
  raw.exec(`
    INSERT INTO wine (name, quantity, clock_body, clock_tannin, clock_sweetness, clock_fruitacid, added_at, updated_at)
      VALUES ('Unrated', 1, 0, 0, 0, 0, 'x', 'x'), ('Bone dry', 1, 4, 0, 0, 9, 'x', 'x');
    PRAGMA user_version = 2;`);
  raw.close();

  const upgraded = new Cellar(path, mirror);
  const clocks = (name: string) => {
    const w = upgraded.list({ search: name, limit: 5, offset: 0 }).items[0];
    return [w.clock_body, w.clock_tannin, w.clock_sweetness, w.clock_fruitacid];
  };
  assert.deepEqual(clocks("Unrated"), [null, null, null, null]);
  assert.deepEqual(clocks("Bone dry"), [4, 0, 0, 9], "a sweetness of 0 is a real rating");
  upgraded.close();
});

test("prices keep the currency they were paid in, and totals are never mixed", () => {
  cellar.add({ name: "Symphonie", vintage: 2019, quantity: 2, purchase_price: 23.5, purchase_currency: " eur " });
  cellar.add({ name: "Cuvée Prestige", quantity: 2, purchase_price: 23, purchase_currency: "EUR" });
  cellar.add({ product_id: "56305", quantity: 1, purchase_price: 429 });
  const w = cellar.list({ search: "Symphonie", limit: 5, offset: 0 }).items[0];
  assert.equal(w.purchase_currency, "EUR");
  assert.equal(w.purchase_price, 23.5);

  // value stays the kronor part; euros are totalled on their own, unconverted.
  assert.deepEqual(cellar.summary(), {
    wines: 3,
    bottles: 5,
    value: 429,
    value_by_currency: { SEK: 429, EUR: 93 },
  });
  assert.deepEqual(Object.keys(cellar.summary().value_by_currency), ["SEK", "EUR"], "kronor first, then by code");

  const relabelled = cellar.update(w.id, { purchase_currency: null });
  assert.equal(relabelled.purchase_currency, null, "null clears it back to kronor");
});

test("a rack spec is parsed, and a malformed one is refused", () => {
  const rack = parseRack("a-l:1-14")!;
  assert.equal(rack.spec, "A-L:1-14");
  assert.equal(rack.columns.length, 12);
  assert.equal(rack.rows.length, 14);
  assert.equal(parseRack(""), null);
  assert.throws(() => parseRack("A-L"), /columns:rows/);
  assert.throws(() => parseRack("L-A:1-14"), /columns:rows/);
});

test("with a rack, slots must be inside it, one per bottle, and not shared", () => {
  const rack = new Cellar(join(dir, "rack", "cellar.db"), mirror, parseRack("A-L:1-14"));
  try {
    const pertois = rack.add({ name: "Cuvée Prestige", quantity: 2, location: "b3, C3" }).wine;
    assert.equal(pertois.location, "B3, C3", "slots are stored upper-cased");

    assert.throws(() => rack.add({ name: "Too far right", quantity: 1, location: "M3" }), /M3 is outside the rack \(columns A–L, rows 1–14\)/);
    assert.throws(() => rack.add({ name: "Too low", quantity: 1, location: "A15" }), /outside the rack/);
    assert.throws(() => rack.add({ name: "Squatter", quantity: 1, location: "B3" }), /B3 holds #1 Cuvée Prestige NV/);
    assert.throws(() => rack.add({ name: "Short", quantity: 2, location: "D4" }), /2 bottle\(s\) need 2 place\(s\)/);
    assert.throws(() => rack.add({ name: "Twice", quantity: 2, location: "D4, d4" }), /D4 is listed twice/);

    const fridge = rack.add({ name: "Kept cold", quantity: 3, location: "fridge" }).wine;
    assert.equal(fridge.location, "fridge", "free text is accepted as written");

    // Moving into another wine's slot is refused; moving to free ones frees the old.
    assert.throws(() => rack.update(fridge.id, { location: "C3, D4, E4" }), /C3 holds #1/);
    rack.update(pertois.id, { location: "E6, F6" });
    const squatter = rack.add({ name: "Now welcome", quantity: 1, location: "B3" }).wine;
    assert.equal(squatter.location, "B3");

    // A recount of a racked wine needs the slots to match.
    assert.throws(() => rack.update(pertois.id, { quantity: 3 }), /Give 'location' with a slot for each of its 3 bottles/);
    assert.equal(rack.update(pertois.id, { quantity: 3, location: "E6, F6, G6" }).location, "E6, F6, G6");
  } finally {
    rack.close();
  }
});

test("taking a bottle out frees its slot, and asks which slot when the wine has several", () => {
  const rack = new Cellar(join(dir, "rack", "cellar.db"), mirror, parseRack("A-L:1-14"));
  try {
    const w = rack.add({ name: "Symphonie", vintage: 2019, quantity: 2, location: "B7, C7" }).wine;
    assert.throws(() => rack.remove(w.id, { quantity: 1, reason: "drunk" }), /is in B7, C7\. Say which slot/);
    assert.throws(() => rack.remove(w.id, { quantity: 1, reason: "drunk", slots: ["D7"] }), /not in D7/);

    const after = rack.remove(w.id, { quantity: 1, reason: "drunk", slots: ["b7"], rating: 4 });
    assert.equal(after.quantity, 1);
    assert.equal(after.location, "C7");
    assert.ok(rack.rackMap()!.free.includes("B7"), "B7 is free again");

    // The last bottle needs no slot named, and leaves no place behind.
    const gone = rack.remove(w.id, { quantity: 1, reason: "drunk" });
    assert.equal(gone.quantity, 0);
    assert.equal(gone.location, null);
    assert.ok(rack.rackMap()!.free.includes("C7"));
  } finally {
    rack.close();
  }
});

test("the rack map shows who is where, what is free, and what lives elsewhere", () => {
  const rack = new Cellar(join(dir, "rack", "cellar.db"), mirror, parseRack("A-B:1-2"));
  try {
    rack.add({ name: "Left", quantity: 2, location: "A1, A2" });
    rack.add({ name: "Cold", quantity: 1, location: "fridge" });
    const map = rack.rackMap()!;
    assert.deepEqual(map.free, ["B1", "B2"]);
    assert.deepEqual(map.slots.map((s) => [s.slot, s.wine_id]), [["A1", 1], ["B1", null], ["A2", 1], ["B2", null]]);
    assert.deepEqual(map.wines, [{ wine_id: 1, label: "#1 Left NV", slots: ["A1", "A2"] }]);
    assert.deepEqual(map.elsewhere, [{ wine_id: 2, label: "#2 Cold NV", quantity: 1, location: "fridge" }]);
  } finally {
    rack.close();
  }
});

test("without a rack, locations are free text and nothing is checked", () => {
  const a = cellar.add({ name: "One", quantity: 1, location: "B3" }).wine;
  const b = cellar.add({ name: "Two", quantity: 2, location: "B3" }).wine;
  assert.equal(a.location, "B3");
  assert.equal(b.location, "B3");
  assert.equal(cellar.rackMap(), null);
});
