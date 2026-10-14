import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Mirror } from "./db.js";
import { SQL_TIMEOUT_MS } from "./constants.js";

/**
 * The user's own cellar: which bottles they have at home, where they are, and
 * what became of each one.
 *
 * It lives in its own file, never in the mirror. The mirror is opened read-only
 * and replaced wholesale by every weekly sync, so anything written into it would
 * vanish on Friday night. It is also the one thing on this server that cannot be
 * rebuilt -- the mirror is a 25-minute sync away, a cellar is years of buying --
 * so it has to be backed up, and it is kept in rollback-journal mode so that a
 * plain file copy between writes is a complete backup.
 *
 * Identity is copied in when a bottle is added rather than looked up later. The
 * mirror prunes delisted products after every complete sync, and a wine kept for
 * years has usually left the assortment by the time it is opened. Worse, and
 * measured: Systembolaget keeps a product's id and number when its vintage
 * changes -- 49 did in one five-day window -- so a live lookup of a 2022 bought
 * last year returns the 2024's tasting note and price, with nothing to say it
 * is a different wine.
 *
 * Much of a cellar will never have come from Systembolaget at all -- grower
 * Champagne, bottles from travels -- so a wine can also carry a profile written
 * by Claude, kept apart from Systembolaget's note and the user's own and always
 * stored with its sources. Facts that belong to one bottle (disgorgement, base
 * year, dosage) come from its label: a non-vintage cuvée changes with every
 * release, so the house's current sheet may describe a different wine from the
 * one on the rack.
 */

export const REMOVAL_REASONS = ["drunk", "gift", "sold", "broken", "other"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export const DRINK_WINDOWS = ["ready", "drink_soon", "not_yet", "unknown"] as const;
export type DrinkWindow = (typeof DRINK_WINDOWS)[number];

export const CELLAR_SORTS = ["drink_until", "name", "vintage", "added", "rating"] as const;
export type CellarSort = (typeof CELLAR_SORTS)[number];

/** Fields the user may set directly. `quantity` is not one: it moves by events. */
export interface WineFields {
  name?: string;
  producer?: string | null;
  vintage?: number | null;
  country?: string | null;
  region?: string | null;
  category?: string | null;
  grapes?: string | null;
  volume_ml?: number | null;
  purchase_price?: number | null;
  purchase_currency?: string | null;
  purchased_on?: string | null;
  purchased_from?: string | null;
  location?: string | null;
  drink_from?: number | null;
  drink_until?: number | null;
  notes?: string | null;
  abv?: number | null;
  sugar_g_l?: number | null;
  style?: string | null;
  base_vintage?: number | null;
  disgorged_on?: string | null;
  claude_profile?: string | null;
  claude_sources?: string | null;
}

const EDITABLE: (keyof WineFields)[] = [
  "name",
  "producer",
  "vintage",
  "country",
  "region",
  "category",
  "grapes",
  "volume_ml",
  "purchase_price",
  "purchase_currency",
  "purchased_on",
  "purchased_from",
  "location",
  "drink_from",
  "drink_until",
  "notes",
  "abv",
  "sugar_g_l",
  "style",
  "base_vintage",
  "disgorged_on",
  "claude_profile",
  "claude_sources",
];

export interface WineRow {
  id: number;
  product_id: string | null;
  product_number: string | null;
  name: string;
  producer: string | null;
  vintage: number | null;
  country: string | null;
  region: string | null;
  category: string | null;
  grapes: string | null;
  volume_ml: number | null;
  quantity: number;
  purchase_price: number | null;
  purchase_currency: string | null;
  purchased_on: string | null;
  purchased_from: string | null;
  location: string | null;
  drink_from: number | null;
  drink_until: number | null;
  notes: string | null;
  sb_taste: string | null;
  clock_body: number | null;
  clock_tannin: number | null;
  clock_sweetness: number | null;
  clock_fruitacid: number | null;
  abv: number | null;
  sugar_g_l: number | null;
  style: string | null;
  base_vintage: number | null;
  disgorged_on: string | null;
  claude_profile: string | null;
  claude_sources: string | null;
  claude_profiled_on: string | null;
  added_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  wine_id: number;
  kind: "added" | "removed" | "adjusted";
  reason: RemovalReason | null;
  quantity: number;
  on_date: string;
  rating: number | null;
  note: string | null;
}

/** What Systembolaget sells under this wine's product id today, if anything. */
export interface CurrentListing {
  vintage: number | null;
  price: number | null;
  availability: string | null;
  same_vintage: boolean;
}

export interface ListedWine extends WineRow {
  avg_rating: number | null;
  times_drunk: number;
  last_note: string | null;
  /** null when the wine is not from Systembolaget or is no longer sold there. */
  systembolaget: CurrentListing | null;
}

export interface ListFilter {
  wine_id?: number;
  search?: string;
  category?: string;
  drink_window?: DrinkWindow;
  min_rating?: number;
  needs_profile?: boolean;
  include_empty?: boolean;
  sort?: CellarSort;
  limit: number;
  offset: number;
}

const SCHEMA_VERSION = 3;

/** What a price means when no currency is recorded: every price before v3 was kronor. */
export const HOME_CURRENCY = "SEK";

/**
 * Systembolaget fills all four taste clocks with 0 when it has not rated a
 * product -- measured: every one of 11,543 wines without a tasting note -- while
 * a real rating has a body of at least 1. So all-zero means "not rated", and
 * copying it in as 0 would describe the wine as bone-dry, featherweight and
 * flat. Sweetness 0 on its own is a real and common rating, which is why only
 * the all-zero case counts.
 */
function rated(p: Record<string, unknown>): boolean {
  return ![p.clock_body, p.clock_tannin, p.clock_sweetness, p.clock_fruitacid].every((c) => Number(c) === 0);
}

/** 'eur' and ' EUR ' are the same currency; store one spelling. */
function normaliseCurrency(f: WineFields): void {
  if (typeof f.purchase_currency === "string") f.purchase_currency = f.purchase_currency.trim().toUpperCase();
}

/**
 * Columns added after the first release. Declared once: a fresh cellar and an
 * old one both get them from this list, so the two can never disagree.
 */
const ADDED_COLUMNS: [name: string, decl: string][] = [
  ["abv", "REAL"],
  // Residual sugar -- for sparkling wine, the dosage. Systembolaget reports
  // g/100 ml; stored here per litre, the unit a Champagne label uses.
  ["sugar_g_l", "REAL"],
  // As the label says it: 'Blanc de Blancs', 'Extra Brut', 'Grand Cru'.
  ["style", "TEXT"],
  // For a non-vintage wine, the harvest most of it comes from.
  ["base_vintage", "INTEGER"],
  // YYYY, YYYY-MM or YYYY-MM-DD, from the back label.
  ["disgorged_on", "TEXT"],
  // Claude's own profile of a wine nobody else describes, never blurred with
  // Systembolaget's note or the user's, and never stored without its sources.
  ["claude_profile", "TEXT"],
  ["claude_sources", "TEXT"],
  ["claude_profiled_on", "TEXT"],
  // ISO 4217 code of purchase_price. A grower's cellar door sells in euros, and
  // converting at entry needs a rate for a date that is often not known, so the
  // price is kept as paid. NULL means SEK, which is what every older price is.
  ["purchase_currency", "TEXT"],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wine (
  id              INTEGER PRIMARY KEY,
  product_id      TEXT,     -- Systembolaget's id; NULL for bottles bought elsewhere
  product_number  TEXT,     -- the "Nr" on the shelf label and the receipt
  name            TEXT NOT NULL,
  producer        TEXT,
  vintage         INTEGER,
  country         TEXT,
  region          TEXT,
  category        TEXT,     -- Systembolaget's cat2 where known, e.g. 'Rött vin'
  grapes          TEXT,
  volume_ml       INTEGER,
  quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  purchase_price  REAL,     -- per bottle, in purchase_currency (SEK when that is NULL)
  purchased_on    TEXT,
  purchased_from  TEXT,
  location        TEXT,     -- where in the cellar
  drink_from      INTEGER,  -- year
  drink_until     INTEGER,  -- year
  notes           TEXT,     -- the user's own
  -- Copied from the mirror when added, and only for the same vintage: the
  -- mirror moves on to the next vintage under the same id, then delists.
  sb_taste        TEXT,
  clock_body      INTEGER,
  clock_tannin    INTEGER,
  clock_sweetness INTEGER,
  clock_fruitacid INTEGER,
  added_at        TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wine_product ON wine(product_id, vintage);

-- Every change in quantity, so "what did I drink, and did I like it" survives
-- the last bottle leaving. A wine at quantity 0 is history, not garbage.
CREATE TABLE IF NOT EXISTS event (
  id          INTEGER PRIMARY KEY,
  wine_id     INTEGER NOT NULL REFERENCES wine(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'adjusted')),
  reason      TEXT,
  quantity    INTEGER NOT NULL,  -- signed change
  on_date     TEXT NOT NULL,
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  note        TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_wine ON event(wine_id);
`;

/** A profile without its sources is indistinguishable from an invented one. */
function requireSources(f: WineFields): void {
  if (f.claude_profile && !f.claude_sources) {
    throw new Error(
      "A claude_profile needs claude_sources: where each part came from -- the house's " +
        "technical sheet, a review, or 'general knowledge, unverified'.",
    );
  }
}

/** Today in the server's timezone, which the containers set to Europe/Stockholm. */
export function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export function thisYear(): number {
  return Number(today().slice(0, 4));
}

/**
 * The physical racks: lettered columns by numbered rows, one bottle per slot.
 * Configured as CELLAR_RACK, one columns:rows block per rack, side by side in
 * the order given, then any positions inside a block that hold no slot, each
 * with a leading minus: 'A-D:1-13 E-H:1-13 I-L:1-14 -D12 -D13 -H12 -H13'.
 * Without one, locations are free text and nothing is checked, which is how
 * the cellar behaved before racks existed.
 */
export interface RackSection {
  /** This rack's block as configured, e.g. 'A-D:1-13'. */
  rack: string;
  columns: string[];
  rows: number[];
  /** Positions inside the block that are not slots, e.g. beside a row of magnums. */
  missing: string[];
}

export interface Rack {
  spec: string;
  racks: RackSection[];
  /** Every slot that exists, rack by rack, each row by row. */
  slots: string[];
}

const SLOT = /^[A-Z]\d{1,3}$/;

export function parseRack(spec: string | undefined): Rack | null {
  if (!spec?.trim()) return null;
  const bad = (why: string) =>
    new Error(
      `CELLAR_RACK must be one columns:rows block per rack, then any missing slots with a leading minus, ` +
        `such as 'A-D:1-13 E-H:1-13 I-L:1-14 -D12 -H12' (${why}), got '${spec}'`,
    );
  const racks: RackSection[] = [];
  const missing: string[] = [];
  for (const token of spec.trim().toUpperCase().split(/[\s,;]+/)) {
    const gap = token.match(/^-([A-Z]\d{1,3})$/);
    if (gap) {
      missing.push(gap[1]);
      continue;
    }
    const m = token.match(/^([A-Z])-([A-Z]):(\d{1,3})-(\d{1,3})$/);
    if (!m) throw bad(`'${token}' is neither`);
    const [c0, c1, r0, r1] = [m[1].charCodeAt(0), m[2].charCodeAt(0), Number(m[3]), Number(m[4])];
    if (c1 < c0 || r0 < 1 || r1 < r0) throw bad(`'${token}' runs backwards`);
    racks.push({
      rack: `${m[1]}-${m[2]}:${r0}-${r1}`,
      columns: Array.from({ length: c1 - c0 + 1 }, (_, i) => String.fromCharCode(c0 + i)),
      rows: Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i),
      missing: [],
    });
  }
  if (!racks.length) throw bad("no rack");

  const owner = new Map<string, RackSection>();
  for (const r of racks) {
    for (const c of r.columns) {
      const shared = owner.get(c);
      if (shared) throw bad(`column ${c} is in both ${shared.rack} and ${r.rack}`);
      owner.set(c, r);
    }
  }
  for (const s of missing) {
    const r = owner.get(s[0]);
    if (!r || !r.rows.includes(Number(s.slice(1)))) throw bad(`-${s} is not inside any rack`);
    if (!r.missing.includes(s)) r.missing.push(s);
  }
  return {
    spec: [...racks.map((r) => r.rack), ...racks.flatMap((r) => r.missing.map((s) => `-${s}`))].join(" "),
    racks,
    slots: racks.flatMap((r) => r.rows.flatMap((row) => r.columns.map((c) => `${c}${row}`)).filter((s) => !r.missing.includes(s))),
  };
}

/** "columns A–D, rows 1–13 (no D12, D13); columns E–H, ..." */
export function rackText(rack: Rack): string {
  return rack.racks
    .map((r) => {
      const gaps = r.missing.length ? ` (no ${r.missing.join(", ")})` : "";
      return `columns ${r.columns[0]}–${r.columns.at(-1)}, rows ${r.rows[0]}–${r.rows.at(-1)}${gaps}`;
    })
    .join("; ");
}


/** "B3, c4 , fridge" -> ["B3", "C4", "fridge"]: slots upper-cased, free text kept as written. */
function locationParts(location: string | null | undefined): string[] {
  return (location ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (SLOT.test(p.toUpperCase()) ? p.toUpperCase() : p));
}

export function slotsIn(location: string | null | undefined): string[] {
  return locationParts(location).filter((p) => SLOT.test(p));
}

function wineLabel(w: { id: number; producer: string | null; name: string; vintage: number | null }): string {
  return `#${w.id} ${[w.producer, w.name, w.vintage ?? "NV"].filter(Boolean).join(" ")}`;
}

/**
 * Said in every rack answer, because a reader drawing the grid has nothing else
 * to go on: one session laid A–L out as rows and got the whole rack transposed.
 */
export const RACK_ORIENTATION =
  "Letters are columns, left to right; numbers are rows, top to bottom. B3 is column B, row 3.";

function orientation(rack: Rack): string {
  const parts = [RACK_ORIENTATION];
  if (rack.racks.length > 1) {
    const names = rack.racks.map((r) => `${r.columns[0]}–${r.columns.at(-1)}`);
    parts.push(`There are ${rack.racks.length} racks, side by side in this order: ${names.join(", ")}. Each has its own rows, so draw each as its own grid.`);
  }
  if (rack.racks.some((r) => r.missing.length)) parts.push("A position listed as missing has no slot: leave it blank, never fill it.");
  return parts.join(" ");
}

export interface RackMap {
  rack: string;
  orientation: string;
  /**
   * Each rack, left to right: its column letters left to right, row numbers
   * top to bottom, the positions that are not slots, and every slot row by row
   * with the wine in it, or null when it is free.
   */
  racks: (RackSection & { slots: { slot: string; wine_id: number | null }[] })[];
  /** Enough to draw and filter the rack from this one answer, without listing the cellar. */
  wines: {
    wine_id: number;
    label: string;
    slots: string[];
    producer: string | null;
    name: string;
    vintage: number | null;
    volume_ml: number | null;
    style: string | null;
    grapes: string | null;
    drink_until: number | null;
  }[];
  free: string[];
  /** Wines with bottles but a location that is not a slot ("fridge"), or none at all. */
  elsewhere: { wine_id: number; label: string; quantity: number; location: string | null }[];
}

export class Cellar {
  private db: DatabaseSync | null = null;

  constructor(
    readonly path: string,
    private readonly mirror: Mirror,
    readonly rack: Rack | null = null,
  ) {}

  private inRack(slot: string): boolean {
    return !!this.rack && this.rack.slots.includes(slot);
  }

  /** Which wine holds each slot, among wines that still have bottles. */
  private occupancy(db: DatabaseSync, exceptId: number | null): Map<string, WineRow> {
    const rows = db
      .prepare(`SELECT * FROM wine WHERE quantity > 0 AND location IS NOT NULL AND id IS NOT ?`)
      .all(exceptId) as unknown as WineRow[];
    const taken = new Map<string, WineRow>();
    for (const w of rows) for (const s of slotsIn(w.location)) taken.set(s, w);
    return taken;
  }

  /**
   * Check where a wine's bottles are said to be, and return the location as it
   * should be stored. Slots must be inside the rack, one per bottle, and not
   * held by another wine; free text such as "fridge" is accepted as written.
   * A wine with no bottles left has no place.
   */
  private place(db: DatabaseSync, id: number | null, location: string | null | undefined, quantity: number): string | null | undefined {
    if (!this.rack || location == null) return location;
    const parts = locationParts(location);
    const slots = parts.filter((p) => SLOT.test(p));
    if (!slots.length) return location;
    if (quantity === 0) return null;

    const outside = slots.filter((s) => !this.inRack(s));
    if (outside.length) {
      throw new Error(`${outside.join(", ")} is not a slot in the rack (${rackText(this.rack)}).`);
    }
    const twice = slots.filter((s, i) => slots.indexOf(s) !== i);
    if (twice.length) throw new Error(`${twice.join(", ")} is listed twice: one bottle per slot.`);
    if (parts.length !== quantity) {
      throw new Error(
        `${quantity} bottle(s) need ${quantity} place(s), one slot per bottle, but '${location}' gives ` +
          `${parts.length}. List a slot for each bottle, e.g. '${slots[0]}, ...'.`,
      );
    }
    const taken = this.occupancy(db, id);
    const clash = slots.filter((s) => taken.has(s));
    if (clash.length) {
      const who = clash.map((s) => `${s} holds ${wineLabel(taken.get(s)!)}`).join("; ");
      const free = this.freeSlots(taken).slice(0, 8);
      throw new Error(`Slot already taken: ${who}. Free slots include ${free.join(", ") || "none"}.`);
    }
    return parts.join(", ");
  }

  /** Free slots in reading order: rack by rack, each row by row. */
  private freeSlots(taken: Map<string, WineRow>): string[] {
    return this.rack!.slots.filter((s) => !taken.has(s));
  }

  /** The rack as it stands: who is where, what is free, and what lives elsewhere. */
  rackMap(): RackMap | null {
    if (!this.rack) return null;
    const db = this.handle();
    const taken = this.occupancy(db, null);
    const r = this.rack;
    const bottled = db
      .prepare(`SELECT * FROM wine WHERE quantity > 0 ORDER BY id`)
      .all() as unknown as WineRow[];
    return {
      rack: r.spec,
      orientation: orientation(r),
      racks: r.racks.map((section) => ({
        ...section,
        slots: r.slots
          .filter((s) => section.columns.includes(s[0]))
          .map((s) => ({ slot: s, wine_id: taken.get(s)?.id ?? null })),
      })),
      wines: bottled
        .filter((w) => slotsIn(w.location).length)
        .map((w) => ({
          wine_id: w.id,
          label: wineLabel(w),
          slots: slotsIn(w.location),
          producer: w.producer,
          name: w.name,
          vintage: w.vintage,
          volume_ml: w.volume_ml,
          style: w.style,
          grapes: w.grapes,
          drink_until: w.drink_until,
        })),
      free: this.freeSlots(taken),
      elsewhere: bottled
        .filter((w) => !slotsIn(w.location).length)
        .map((w) => ({ wine_id: w.id, label: wineLabel(w), quantity: w.quantity, location: w.location })),
    };
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const db = new DatabaseSync(this.path);
      db.exec(`PRAGMA busy_timeout = ${SQL_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
      db.exec(SCHEMA);
      const have = new Set(
        (db.prepare(`SELECT name FROM pragma_table_info('wine')`).all() as { name: string }[]).map((c) => c.name),
      );
      for (const [name, decl] of ADDED_COLUMNS) {
        if (!have.has(name)) db.exec(`ALTER TABLE wine ADD COLUMN ${name} ${decl}`);
      }
      const { user_version: version } = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
      if (version < 3) {
        // Before v3 an unrated product's all-zero clocks were copied in as if
        // they were a rating. See rated().
        db.exec(`UPDATE wine SET clock_body = NULL, clock_tannin = NULL, clock_sweetness = NULL, clock_fruitacid = NULL
                 WHERE clock_body = 0 AND clock_tannin = 0 AND clock_sweetness = 0 AND clock_fruitacid = 0`);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db = db;
      return db;
    } catch (err) {
      throw new Error(this.explain(err as Error));
    }
  }

  /**
   * The failure that will actually happen is a directory the server cannot
   * write, and SQLite reports it as "unable to open database file" or
   * "attempt to write a readonly database" -- neither says permissions.
   */
  private explain(err: Error): string {
    if (/unable to open|readonly|EACCES|permission/i.test(err.message)) {
      return (
        `Cannot write the cellar at ${this.path}. The directory must be writable by the ` +
        `server's user -- uid 10001 in the container: chown -R 10001:10001 ${dirname(this.path)}. ` +
        `(${err.message})`
      );
    }
    return `Cellar error: ${err.message}`;
  }

  private tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.handle();
    db.exec("BEGIN");
    try {
      const out = fn(db);
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  private wine(db: DatabaseSync, id: number): WineRow | undefined {
    return db.prepare(`SELECT * FROM wine WHERE id = ?`).get(id) as WineRow | undefined;
  }

  private event(
    db: DatabaseSync,
    e: Omit<EventRow, "id" | "reason" | "rating" | "note"> &
      Partial<Pick<EventRow, "reason" | "rating" | "note">>,
  ): void {
    db.prepare(
      `INSERT INTO event (wine_id, kind, reason, quantity, on_date, rating, note, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.wine_id,
      e.kind,
      e.reason ?? null,
      e.quantity,
      e.on_date,
      e.rating ?? null,
      e.note ?? null,
      new Date().toISOString(),
    );
  }

  /**
   * Add bottles. With a product id or number, identity comes from the mirror;
   * without one the caller supplies at least a name. The two are separate
   * arguments because they are not interchangeable: 12 products have an id that
   * is another product's number. Adding a Systembolaget wine that is already
   * in the cellar in the same vintage tops up that row rather than duplicating
   * it, so "I bought two more" needs no lookup first.
   */
  add(
    input: WineFields & { product_id?: string; product_number?: string; quantity: number },
  ): { wine: WineRow; merged: boolean; warnings: string[] } {
    requireSources(input);
    normaliseCurrency(input);
    const warnings: string[] = [];
    const fields: Record<string, unknown> = {};
    let productId: string | null = null;
    let productNumber: string | null = null;

    if (input.product_id || input.product_number) {
      const match: string[] = [];
      const binds: string[] = [];
      if (input.product_id) {
        match.push("product_id = ?");
        binds.push(input.product_id);
      }
      if (input.product_number) {
        match.push("product_number = ?");
        binds.push(input.product_number);
      }
      const p = this.mirror.get<Record<string, unknown>>(
        `SELECT product_id, product_number, full_name, producer, vintage, country, origin1, origin2,
                cat2, volume_ml, abv, sugar_g_per_100ml, taste,
                clock_body, clock_tannin, clock_sweetness, clock_fruitacid
         FROM product WHERE ${match.join(" AND ")}`,
        ...binds,
      );
      if (!p) {
        const asked = [
          input.product_id ? `id ${input.product_id}` : null,
          input.product_number ? `number ${input.product_number}` : null,
        ].filter(Boolean);
        throw new Error(
          `No Systembolaget product with ${asked.join(" and ")}. Search for it with ` +
            `systembolaget_search_products, or add it by name instead.`,
        );
      }
      productId = String(p.product_id);
      productNumber = p.product_number == null ? null : String(p.product_number);
      const grapes = this.mirror
        .all<{ grape: string }>(
          `SELECT grape FROM product_grape WHERE product_id = ? ORDER BY grape`,
          productId,
        )
        .map((g) => g.grape);

      const listed = p.vintage == null ? null : Number(p.vintage);
      const vintage = input.vintage !== undefined ? input.vintage : listed;
      Object.assign(fields, {
        name: p.full_name,
        producer: p.producer,
        vintage,
        country: p.country,
        region: [p.origin1, p.origin2].filter(Boolean).join(", ") || null,
        category: p.cat2,
        grapes: grapes.length ? grapes.join(", ") : null,
        volume_ml: p.volume_ml,
      });
      if (vintage === listed) {
        const sugar = p.sugar_g_per_100ml == null ? null : Math.round(Number(p.sugar_g_per_100ml) * 100) / 10;
        const clocks = rated(p);
        Object.assign(fields, {
          abv: p.abv,
          sugar_g_l: sugar,
          sb_taste: p.taste,
          clock_body: clocks ? p.clock_body : null,
          clock_tannin: clocks ? p.clock_tannin : null,
          clock_sweetness: clocks ? p.clock_sweetness : null,
          clock_fruitacid: clocks ? p.clock_fruitacid : null,
        });
      } else {
        warnings.push(
          `Systembolaget now lists this wine as the ${listed ?? "non-vintage"}; yours is the ` +
            `${vintage ?? "non-vintage"}. Its tasting note, taste clocks, alcohol and sugar were ` +
            `not copied, because they describe a different vintage.`,
        );
      }
    }

    for (const k of EDITABLE) {
      if (input[k] !== undefined) fields[k] = input[k];
    }
    if (!fields.name) {
      throw new Error("A wine needs a name, or a Systembolaget product_id or product_number to take it from.");
    }

    return this.tx((db) => {
      const now = new Date().toISOString();
      const existing = productId
        ? (db
            .prepare(`SELECT * FROM wine WHERE product_id = ? AND vintage IS ? ORDER BY id LIMIT 1`)
            .get(productId, (fields.vintage as number | null) ?? null) as WineRow | undefined)
        : undefined;

      let id: number;
      if (existing) {
        id = existing.id;
        // The new bottles need slots too: a wine kept in the rack cannot be
        // topped up without saying where the extra bottles went.
        const total = existing.quantity + input.quantity;
        if (input.location === undefined && slotsIn(existing.location).length && this.rack) {
          throw new Error(
            `${wineLabel(existing)} is kept in ${existing.location}. Give 'location' with a slot for ` +
              `each of its ${total} bottles, the new ones included.`,
          );
        }
        if (input.location !== undefined) input.location = this.place(db, existing.id, input.location, total);
        // Topping up keeps the row's identity; only what the caller said
        // explicitly (a new location, price, note) is applied.
        const explicit = EDITABLE.filter((k) => input[k] !== undefined);
        const sets = ["quantity = quantity + ?", "updated_at = ?", ...explicit.map((k) => `${k} = ?`)];
        const args: unknown[] = [input.quantity, now, ...explicit.map((k) => input[k])];
        if (input.claude_profile !== undefined) {
          sets.push("claude_profiled_on = ?");
          args.push(input.claude_profile ? today() : null);
        }
        db.prepare(`UPDATE wine SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]), id);
      } else {
        const row: Record<string, unknown> = {
          ...fields,
          location: this.place(db, null, fields.location as string | null | undefined, input.quantity),
          ...(fields.claude_profile ? { claude_profiled_on: today() } : {}),
          product_id: productId,
          product_number: productNumber,
          quantity: input.quantity,
          added_at: now,
          updated_at: now,
        };
        const cols = Object.keys(row);
        const res = db
          .prepare(`INSERT INTO wine (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
          .run(...cols.map((c) => (row[c] ?? null) as never));
        id = Number(res.lastInsertRowid);
      }

      this.event(db, { wine_id: id, kind: "added", quantity: input.quantity, on_date: today() });
      return { wine: this.wine(db, id)!, merged: Boolean(existing), warnings };
    });
  }

  /**
   * Edit a wine's details. Passing null clears a field; leaving it out keeps it.
   * `quantity` sets the count outright and is recorded as an adjustment -- for
   * correcting a miscount, not for bottles drunk, which go through remove().
   */
  update(id: number, patch: WineFields & { quantity?: number }): WineRow {
    requireSources(patch);
    normaliseCurrency(patch);
    return this.tx((db) => {
      const before = this.wine(db, id);
      if (!before) throw new Error(`No wine #${id} in the cellar. List the cellar to find its id.`);

      // A move, or a recount, has to leave every bottle in a valid place.
      const recount = patch.quantity !== undefined && patch.quantity !== before.quantity;
      if (this.rack && (patch.location !== undefined || recount)) {
        const quantity = patch.quantity ?? before.quantity;
        if (patch.location === undefined && recount && quantity > 0 && slotsIn(before.location).length) {
          throw new Error(
            `${wineLabel(before)} is kept in ${before.location}. Give 'location' with a slot for each of ` +
              `its ${quantity} bottles along with the new count.`,
          );
        }
        const placed = this.place(db, id, patch.location !== undefined ? patch.location : before.location, quantity);
        if (placed !== before.location) patch = { ...patch, location: placed };
      }

      const keys = EDITABLE.filter((k) => patch[k] !== undefined);
      if (keys.includes("name") && !patch.name) throw new Error("A wine's name cannot be cleared.");
      const sets = keys.map((k) => `${k} = ?`);
      const args: unknown[] = keys.map((k) => patch[k]);

      // The copied note and clocks belong to the vintage they were copied for.
      if (patch.vintage !== undefined && patch.vintage !== before.vintage) {
        sets.push(
          "sb_taste = NULL",
          "clock_body = NULL",
          "clock_tannin = NULL",
          "clock_sweetness = NULL",
          "clock_fruitacid = NULL",
        );
      }
      if (patch.claude_profile !== undefined) {
        sets.push("claude_profiled_on = ?");
        args.push(patch.claude_profile ? today() : null);
      }

      if (patch.quantity !== undefined && patch.quantity !== before.quantity) {
        sets.push("quantity = ?");
        args.push(patch.quantity);
        this.event(db, {
          wine_id: id,
          kind: "adjusted",
          quantity: patch.quantity - before.quantity,
          on_date: today(),
        });
      }
      if (!sets.length) return before;

      sets.push("updated_at = ?");
      args.push(new Date().toISOString());
      db.prepare(`UPDATE wine SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]), id);
      return this.wine(db, id)!;
    });
  }

  /** Take bottles out: drunk, given away, sold or broken. History is kept. */
  remove(
    id: number,
    r: { quantity: number; reason: RemovalReason; on_date?: string; rating?: number; note?: string; slots?: string[] },
  ): WineRow {
    return this.tx((db) => {
      const before = this.wine(db, id);
      if (!before) throw new Error(`No wine #${id} in the cellar. List the cellar to find its id.`);
      if (r.quantity > before.quantity) {
        throw new Error(
          `Only ${before.quantity} bottle(s) of ${before.name} in the cellar, so ${r.quantity} ` +
            `cannot be taken out. If the count was wrong, correct it with systembolaget_cellar_update.`,
        );
      }

      // Free the slots the bottles came from. When a wine is spread over
      // several slots and the user has not said which, ask rather than guess:
      // a wrong guess leaves the rack map pointing at an empty slot.
      const parts = locationParts(before.location);
      const left = before.quantity - r.quantity;
      let location: string | null | undefined; // undefined: unchanged
      if (r.slots?.length) {
        const out = r.slots.map((s) => s.trim().toUpperCase());
        const missing = out.filter((s) => !parts.includes(s));
        if (missing.length) {
          throw new Error(`${wineLabel(before)} is not in ${missing.join(", ")}; it is in ${before.location ?? "no recorded place"}.`);
        }
        if (out.length !== r.quantity) {
          throw new Error(`Taking out ${r.quantity} bottle(s) but naming ${out.length} slot(s): one slot per bottle.`);
        }
        const remaining = [...parts];
        for (const s of out) remaining.splice(remaining.indexOf(s), 1);
        location = remaining.length ? remaining.join(", ") : null;
      } else if (slotsIn(before.location).length) {
        if (left === 0) location = null;
        else if (this.rack && parts.length > 1) {
          throw new Error(
            `${wineLabel(before)} is in ${before.location}. Say which slot the bottle came from, ` +
              `e.g. slots: ['${parts[0]}'].`,
          );
        }
      }

      db.prepare(`UPDATE wine SET quantity = quantity - ?, updated_at = ? WHERE id = ?`).run(
        r.quantity,
        new Date().toISOString(),
        id,
      );
      if (location !== undefined) db.prepare(`UPDATE wine SET location = ? WHERE id = ?`).run(location, id);
      this.event(db, {
        wine_id: id,
        kind: "removed",
        reason: r.reason,
        quantity: -r.quantity,
        on_date: r.on_date ?? today(),
        rating: r.rating,
        note: r.note,
      });
      return this.wine(db, id)!;
    });
  }

  list(f: ListFilter): { total: number; items: ListedWine[] } {
    const db = this.handle();
    const year = thisYear();
    const where: string[] = [];
    const params: unknown[] = [];

    if (f.wine_id !== undefined) {
      where.push("id = ?");
      params.push(f.wine_id);
    } else if (!f.include_empty) {
      where.push("quantity > 0");
    }
    if (f.search) {
      const like = `%${f.search}%`;
      where.push(
        `(name LIKE ? OR producer LIKE ? OR region LIKE ? OR country LIKE ? OR grapes LIKE ?
          OR style LIKE ? OR notes LIKE ? OR claude_profile LIKE ?)`,
      );
      params.push(like, like, like, like, like, like, like, like);
    }
    if (f.category) {
      where.push("category = ? COLLATE NOCASE");
      params.push(f.category);
    }
    switch (f.drink_window) {
      case "ready":
        where.push(
          `(drink_from IS NOT NULL OR drink_until IS NOT NULL)
           AND COALESCE(drink_from, 0) <= ? AND COALESCE(drink_until, 9999) >= ?`,
        );
        params.push(year, year);
        break;
      case "drink_soon":
        // Includes anything already past its window: that is the most urgent.
        where.push("drink_until IS NOT NULL AND drink_until <= ?");
        params.push(year + 1);
        break;
      case "not_yet":
        where.push("drink_from > ?");
        params.push(year);
        break;
      case "unknown":
        where.push("drink_from IS NULL AND drink_until IS NULL");
        break;
    }
    if (f.needs_profile) {
      // Nobody has described it: no Systembolaget note, no profile yet.
      where.push("sb_taste IS NULL AND claude_profile IS NULL");
    }
    if (f.min_rating !== undefined) {
      where.push("avg_rating >= ?");
      params.push(f.min_rating);
    }

    const order: Record<CellarSort, string> = {
      drink_until: "drink_until IS NULL, drink_until, drink_from IS NULL, drink_from, name",
      name: "name COLLATE NOCASE, vintage",
      vintage: "vintage IS NULL, vintage, name",
      added: "added_at DESC",
      rating: "avg_rating IS NULL, avg_rating DESC, name",
    };

    // Ratings live on events, so they are derived first and filtered after.
    const base = `
      WITH w AS (
        SELECT wine.*,
          (SELECT ROUND(AVG(rating), 1) FROM event e WHERE e.wine_id = wine.id AND rating IS NOT NULL) AS avg_rating,
          (SELECT -COALESCE(SUM(quantity), 0) FROM event e
             WHERE e.wine_id = wine.id AND kind = 'removed' AND reason = 'drunk') AS times_drunk,
          (SELECT note FROM event e WHERE e.wine_id = wine.id AND note IS NOT NULL
             ORDER BY on_date DESC, id DESC LIMIT 1) AS last_note
        FROM wine
      )
      SELECT * FROM w ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const { total } = db.prepare(`SELECT count(*) AS total FROM (${base})`).get(
      ...(params as never[]),
    ) as { total: number };
    const rows = db
      .prepare(`${base} ORDER BY ${order[f.sort ?? "drink_until"]} LIMIT ? OFFSET ?`)
      .all(...(params as never[]), f.limit, f.offset) as unknown as Omit<ListedWine, "systembolaget">[];

    return { total, items: this.withListings(rows) };
  }

  history(id: number): EventRow[] {
    return this.handle()
      .prepare(`SELECT * FROM event WHERE wine_id = ? ORDER BY on_date, id`)
      .all(id) as unknown as EventRow[];
  }

  /**
   * Attach what Systembolaget sells under each wine's id today. Best effort:
   * the cellar must stay usable when the mirror is missing or mid-publish, so a
   * failed lookup leaves the listing out rather than failing the call.
   */
  private withListings(rows: Omit<ListedWine, "systembolaget">[]): ListedWine[] {
    const ids = [...new Set(rows.map((r) => r.product_id).filter((x): x is string => !!x))];
    const current = new Map<string, { vintage: number | null; price: number | null; availability: string | null }>();
    if (ids.length) {
      try {
        const found = this.mirror.all<{
          product_id: string;
          vintage: number | null;
          price: number | null;
          availability: string | null;
        }>(
          `SELECT product_id, vintage, price, availability FROM product
           WHERE product_id IN (${ids.map(() => "?").join(", ")}) AND is_discontinued = 0`,
          ...ids,
        );
        for (const p of found) current.set(p.product_id, p);
      } catch {
        // No mirror: list the cellar without current listings.
      }
    }
    return rows.map((r) => {
      const c = r.product_id ? current.get(r.product_id) : undefined;
      return {
        ...r,
        systembolaget: c
          ? {
              vintage: c.vintage,
              price: c.price,
              availability: c.availability,
              same_vintage: (c.vintage == null ? null : Number(c.vintage)) === r.vintage,
            }
          : null,
      };
    });
  }

  /**
   * Totals. What was paid is summed per currency and never converted: the
   * server has no exchange rates, and a total in kronor that silently treated
   * €23.50 as 23.50 kr -- or converted at a guessed rate -- would be wrong
   * without looking it. `value` is the kronor part, as before.
   */
  summary(): { wines: number; bottles: number; value: number | null; value_by_currency: Record<string, number> } {
    const db = this.handle();
    const row = db
      .prepare(`SELECT count(*) AS wines, COALESCE(SUM(quantity), 0) AS bottles FROM wine WHERE quantity > 0`)
      .get() as { wines: number; bottles: number };
    const paid = db
      .prepare(
        `SELECT COALESCE(purchase_currency, '${HOME_CURRENCY}') AS currency, SUM(quantity * purchase_price) AS total
         FROM wine WHERE quantity > 0 AND purchase_price IS NOT NULL
         GROUP BY currency ORDER BY currency = '${HOME_CURRENCY}' DESC, currency`,
      )
      .all() as { currency: string; total: number }[];
    const value_by_currency = Object.fromEntries(paid.map((p) => [p.currency, Math.round(p.total * 100) / 100]));
    return { wines: row.wines, bottles: row.bottles, value: value_by_currency[HOME_CURRENCY] ?? null, value_by_currency };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
