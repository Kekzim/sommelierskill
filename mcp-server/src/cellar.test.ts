import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "./db.js";
import { Cellar, thisYear } from "./cellar.js";

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
      clock_body INTEGER, clock_tannin INTEGER, clock_sweetness INTEGER, clock_fruitacid INTEGER);
    CREATE TABLE product_grape (product_id TEXT, grape TEXT, raw_name TEXT);`);
  for (const p of products) {
    db.prepare(
      `INSERT INTO product VALUES (?, ?, ?, ?, ?, 'Frankrike', 'Frankrike sydväst', 'Madiran',
         'Rött vin', 750, ?, ?, 0, ?, 11, 11, 1, 7)`,
    ).run(p.product_id, p.product_number, p.full_name, p.producer, p.vintage, p.price, p.availability ?? "order_only", p.taste);
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
  assert.deepEqual(again.summary(), { wines: 1, bottles: 4, value: null });
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
