import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CELLAR_SORTS,
  Cellar,
  DRINK_WINDOWS,
  EventRow,
  ListedWine,
  REMOVAL_REASONS,
  WineRow,
  thisYear,
} from "../cellar.js";
import { pagingSchema } from "../product.js";
import { Page, ToolResult, errorResult, guard, kr, paginate, textResult, toolResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const year = z.number().int().min(1800).max(2200);
const text = (max: number, what: string) =>
  z.string().trim().min(1).max(max).nullable().optional().describe(what);

/** Shared by add and update. In update, null clears a field and omitting it keeps it. */
const wineFields = {
  producer: text(200, "Producer"),
  vintage: year.nullable().optional().describe("Vintage on the label; null for non-vintage"),
  country: text(100, "Country, as Systembolaget spells it where possible, e.g. 'Frankrike'"),
  region: text(200, "Region or appellation, e.g. 'Bourgogne, Chablis'"),
  category: text(100, "Systembolaget's category name where possible: 'Rött vin', 'Vitt vin', 'Mousserande vin'"),
  grapes: text(300, "Grapes, comma separated"),
  volume_ml: z.number().int().min(20).max(30000).nullable().optional().describe("Bottle size in ml"),
  purchase_price: z.number().min(0).max(1_000_000).nullable().optional().describe("Price paid per bottle, SEK"),
  purchased_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .nullable()
    .optional()
    .describe("Purchase date, YYYY-MM-DD"),
  purchased_from: text(200, "Where it was bought, e.g. 'Systembolaget', 'a vineyard in Alsace', 'gift'"),
  location: text(200, "Where it is in the cellar, e.g. 'rack B, row 3'"),
  drink_from: year.nullable().optional().describe("First year it is ready to drink"),
  drink_until: year.nullable().optional().describe("Last year it should be drunk by"),
  notes: z.string().trim().max(4000).nullable().optional().describe("The user's own notes about this wine"),
  abv: z.number().min(0).max(80).nullable().optional().describe("Alcohol, % by volume"),
  sugar_g_l: z
    .number()
    .min(0)
    .max(400)
    .nullable()
    .optional()
    .describe("Residual sugar in g/L -- for Champagne and other sparkling wine, the dosage"),
  style: text(200, "Style words from the label, e.g. 'Blanc de Blancs, Extra Brut, Grand Cru'"),
  base_vintage: year
    .nullable()
    .optional()
    .describe("For a non-vintage wine: the base year, often printed on grower Champagne"),
  disgorged_on: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD")
    .nullable()
    .optional()
    .describe("Disgorgement date from the back label: YYYY, YYYY-MM or YYYY-MM-DD"),
  claude_profile: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .nullable()
    .optional()
    .describe("Your own profile of a wine nobody else describes: style, taste, what to eat with it. Requires claude_sources"),
  claude_sources: text(2000, "Where the profile came from: URLs of the house's sheet or reviews, or 'general knowledge, unverified'"),
};

function checkWindow(from?: number | null, until?: number | null): string | null {
  if (from != null && until != null && from > until) {
    return `drink_from (${from}) is after drink_until (${until}).`;
  }
  return null;
}

function windowText(w: WineRow): string | null {
  if (w.drink_from == null && w.drink_until == null) return null;
  const y = thisYear();
  const range = `${w.drink_from ?? "now"}–${w.drink_until ?? "open"}`;
  let state = "ready";
  if (w.drink_until != null && w.drink_until < y) state = "past its window";
  else if (w.drink_from != null && w.drink_from > y) state = "not ready yet";
  else if (w.drink_until != null && w.drink_until <= y + 1) state = "ready, drink soon";
  return `${range} (${state})`;
}

function wineMarkdown(w: ListedWine | WineRow, history?: EventRow[]): string {
  const lines: string[] = [];
  const bottles = `${w.quantity} bottle${w.quantity === 1 ? "" : "s"}`;
  lines.push(`## ${w.name}${w.vintage ? ` ${w.vintage}` : ""} — ${bottles} · #${w.id}`);

  const where = [w.country, w.region].filter(Boolean).join(", ");
  const ident = [w.producer, where, w.category, w.volume_ml && w.volume_ml !== 750 ? `${w.volume_ml} ml` : null]
    .filter(Boolean)
    .join(" · ");
  if (ident) lines.push(`*${ident}*`);

  const label = [
    w.style,
    w.abv != null ? `${w.abv}%` : null,
    w.sugar_g_l != null ? `${w.sugar_g_l} g/L sugar` : null,
    w.base_vintage != null ? `base ${w.base_vintage}` : null,
    w.disgorged_on ? `disgorged ${w.disgorged_on}` : null,
  ].filter(Boolean);
  if (label.length) lines.push(`- **Label**: ${label.join(" · ")}`);

  const window = windowText(w);
  if (window) lines.push(`- **Drink**: ${window}`);
  if (w.location) lines.push(`- **Where**: ${w.location}`);
  if (w.grapes) lines.push(`- **Grapes**: ${w.grapes}`);
  if (w.purchase_price != null || w.purchased_on || w.purchased_from) {
    const how = [w.purchased_on, w.purchased_from].filter(Boolean).join(", ");
    lines.push(`- **Paid**: ${w.purchase_price != null ? kr(w.purchase_price) : "price not recorded"}${how ? ` (${how})` : ""}`);
  }
  // Three voices, and they must never blur: Systembolaget's note for this
  // vintage, Claude's profile with its sources, and the user's own.
  if (w.sb_taste) lines.push(`- **Systembolaget's note** (recorded when added): ${w.sb_taste}`);
  if (w.claude_profile) {
    lines.push(`- **Claude's profile** (${w.claude_profiled_on ?? "undated"}): ${w.claude_profile}`);
    lines.push(`  - *Sources*: ${w.claude_sources ?? "none recorded"}`);
  }
  if (w.notes) lines.push(`- **Your notes**: ${w.notes}`);

  if ("avg_rating" in w) {
    if (w.avg_rating != null) {
      lines.push(
        `- **Your rating**: ${w.avg_rating}/5` +
          (w.times_drunk ? ` (${w.times_drunk} drunk)` : "") +
          (w.last_note ? ` — last: "${w.last_note}"` : ""),
      );
    } else if (w.last_note) {
      lines.push(`- **Last note**: "${w.last_note}"`);
    }
    if (w.systembolaget) {
      const s = w.systembolaget;
      lines.push(
        s.same_vintage
          ? `- **At Systembolaget now**: ${kr(s.price)}, ${s.availability}`
          : `- **At Systembolaget now**: the ${s.vintage ?? "non-vintage"} at ${kr(s.price)}, ` +
              `${s.availability} — a different vintage from yours`,
      );
    } else if (w.product_id) {
      lines.push(`- **At Systembolaget now**: no longer sold`);
    }
  }
  if (w.product_id) lines.push(`- Systembolaget \`${w.product_id}\``);

  if (history?.length) {
    lines.push("", "**History**");
    for (const e of history) {
      const what =
        e.kind === "removed" ? `${-e.quantity} ${e.reason ?? "removed"}` : `${e.quantity > 0 ? "+" : ""}${e.quantity} ${e.kind}`;
      const extra = [e.rating != null ? `${e.rating}/5` : null, e.note ? `"${e.note}"` : null].filter(Boolean);
      lines.push(`- ${e.on_date}: ${what}${extra.length ? ` — ${extra.join(", ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

function written(cellar: Cellar, w: WineRow, headline: string, extra: Record<string, unknown> = {}): ToolResult {
  const s = cellar.summary();
  const text = [
    headline,
    ...((extra.warnings as string[] | undefined) ?? []).map((m) => `> ${m}`),
    "",
    wineMarkdown(w),
    "",
    `Cellar: ${s.bottles} bottle(s) of ${s.wines} wine(s).`,
  ].join("\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { wine: w, ...extra, cellar: s },
  };
}

export function registerCellarTools(server: McpServer, cellar: Cellar): void {
  server.registerTool(
    "systembolaget_cellar_list",
    {
      title: "List the user's cellar",
      description: `List the wines the user has at home: how many bottles, where they are, when to drink them, what they paid, and their own ratings and notes.

Start here for "what should I open tonight", "what goes with lamb from what I have", and "what needs drinking soon". Check it too before recommending a purchase -- they may already own something that fits, or already have six of what you were about to suggest.

Three kinds of description appear and must not be confused: Systembolaget's note, recorded for that exact vintage when the bottle was added; Claude's profile, written for wines nobody else describes and stored with its sources; and the user's own notes and ratings. Quote the user's as theirs, and present Claude's as Claude's, with its sources.

Args:
  - wine_id (number): one wine, with its full history of additions, bottles drunk, ratings and notes
  - search (string): matches name, producer, region, country, grapes and the user's notes
  - category (string): Systembolaget's category name, e.g. 'Rött vin'
  - drink_window ('ready' | 'drink_soon' | 'not_yet' | 'unknown'): 'drink_soon' includes anything past its window, most urgent first
  - min_rating (number 1-5): wines the user has rated at least this highly -- "the ones I loved"
  - needs_profile (boolean): wines with neither a Systembolaget note nor a Claude profile -- the queue for filling in
  - include_empty (boolean): include wines with no bottles left, for "what was that wine I had" (default: false)
  - sort ('drink_until' | 'name' | 'vintage' | 'added' | 'rating'), limit, offset, response_format

Returns each wine with bottles, drinking window, location, price paid, both kinds of note, the user's average rating, and what Systembolaget sells under that product now -- flagged when it has moved on to a different vintage.

Examples:
  - "What should I open with lamb tonight?" -> drink_window='ready', then match on the taste clocks and notes
  - "Anything I should drink before it's too late?" -> drink_window='drink_soon'
  - "What was that Riesling I liked?" -> search='Riesling', include_empty=true, min_rating=4
  - "Fill in the Champagnes I just added" -> needs_profile=true, then research each and systembolaget_cellar_update

Error Handling:
  - An empty cellar returns a message saying so; wines are added with systembolaget_cellar_add.`,
      inputSchema: z
        .object({
          wine_id: z.number().int().min(1).optional().describe("One wine, with its full history"),
          search: z.string().trim().min(2).max(200).optional().describe("Free text over name, producer, region, grapes and notes"),
          category: z.string().optional().describe("Systembolaget's category name, e.g. 'Rött vin'"),
          drink_window: z.enum(DRINK_WINDOWS).optional().describe("Filter by drinking window relative to this year"),
          min_rating: z.number().min(1).max(5).optional().describe("Only wines the user rated at least this highly"),
          needs_profile: z
            .boolean()
            .optional()
            .describe("Only wines nobody has described yet: no Systembolaget note and no Claude profile"),
          include_empty: z.boolean().default(false).describe("Include wines with no bottles left (default: false)"),
          sort: z.enum(CELLAR_SORTS).default("drink_until").describe("Sort order (default: drink_until, soonest first)"),
          ...pagingSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const { total, items } = cellar.list(params);
        if (!items.length) {
          const s = cellar.summary();
          return textResult(
            s.wines === 0 && !params.include_empty
              ? "The cellar is empty. Add wines with systembolaget_cellar_add."
              : `No wines match. The cellar holds ${s.bottles} bottle(s) of ${s.wines} wine(s); ` +
                  `loosen the filters, or set include_empty=true to search wines already drunk.`,
          );
        }

        if (params.wine_id !== undefined) {
          const w = items[0];
          const history = cellar.history(w.id);
          const output = { ...w, history };
          return {
            content: [
              {
                type: "text" as const,
                text: params.response_format === "json" ? JSON.stringify(output, null, 2) : wineMarkdown(w, history),
              },
            ],
            structuredContent: output,
          };
        }

        const s = cellar.summary();
        const value = s.value != null ? `, ${kr(Math.round(s.value))} paid for what is recorded` : "";
        return toolResult(
          paginate(items, total, params.offset),
          (page: Page<ListedWine>) =>
            [`# Your cellar`, `${s.bottles} bottle(s) of ${s.wines} wine(s)${value}. ${page.total} match (showing ${page.count}).`]
              .concat(page.items.map((w) => wineMarkdown(w)))
              .join("\n\n"),
          params.response_format,
        );
      }),
  );

  server.registerTool(
    "systembolaget_cellar_add",
    {
      title: "Add bottles to the user's cellar",
      description: `Record bottles the user has put in their cellar.

For anything bought at Systembolaget, pass 'product_id' from a search result, or 'product_number' -- the "Nr" printed on the shelf label and receipt, e.g. "5630501". They are different numbers and not interchangeable. Name, producer, region, grapes and Systembolaget's tasting note are copied in, so they survive the wine being delisted, as long-kept wine usually is.

Pass 'vintage' whenever the label shows one. Systembolaget keeps a product's id when the next vintage arrives, so the vintage it lists today may not be the bottle on the user's shelf. When they differ, the tasting note is deliberately not copied.

Adding a Systembolaget wine already in the cellar in the same vintage tops up that entry rather than creating a second one. Wines bought elsewhere always create a new entry: give at least a name, and whatever the label says. For Champagne that is the house as producer, the cuvée as name, vintage or null for NV, and from the back label the blend in 'grapes' ('Chardonnay 60%, Pinot noir 40%'), dosage as sugar_g_l, base_vintage and disgorged_on when printed -- those belong to that bottle and change with every release.

Args:
  - product_id (string): Systembolaget product id, from a search result
  - product_number (string): the "Nr" on the shelf label or receipt
  - name (string): required when there is neither
  - quantity (number): bottles added (default: 1)
  - producer, vintage, country, region, category, grapes, volume_ml: override or supply identity
  - purchase_price (per bottle, SEK), purchased_on (YYYY-MM-DD), purchased_from
  - abv, sugar_g_l (dosage for sparkling), style, base_vintage, disgorged_on: label facts
  - location, drink_from, drink_until (years), notes
  - claude_profile, claude_sources: see systembolaget_cellar_update

Returns the wine as stored, whether an existing entry was topped up, and the cellar's new total.

Examples:
  - "I just bought 3 of the Château Montus" -> find it, then product_id=<id>, quantity=3, purchased_from='Systembolaget'
  - "Add two bottles of the 2019 Barolo my uncle gave me" -> name, vintage=2019, quantity=2, purchased_from='gift'
  - "Six Egly-Ouriet Brut Tradition, NV, 2 g/L, base 2019, disgorged March 2024" -> producer='Egly-Ouriet', name='Brut Tradition', vintage=null, sugar_g_l=2, base_vintage=2019, disgorged_on='2024-03', category='Mousserande vin', quantity=6

Error Handling:
  - An unknown product_id or product_number returns an error suggesting a search, or adding by name.`,
      inputSchema: z
        .object({
          product_id: z.string().trim().regex(/^\d{1,12}$/).optional().describe("Systembolaget product id, from a search result"),
          product_number: z
            .string()
            .trim()
            .regex(/^\d{1,12}$/)
            .optional()
            .describe("The 'Nr' on Systembolaget's shelf label or receipt, e.g. '5630501'"),
          name: z.string().trim().min(1).max(200).optional().describe("Wine name; required without a product_id or product_number"),
          quantity: z.number().int().min(1).max(1000).default(1).describe("Bottles added (default: 1)"),
          ...wineFields,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) =>
      guard(() => {
        const bad = checkWindow(params.drink_from, params.drink_until);
        if (bad) return errorResult(bad);
        const { wine, merged, warnings } = cellar.add(params);
        const n = params.quantity;
        return written(
          cellar,
          wine,
          merged
            ? `Added ${n} to the existing entry: now ${wine.quantity} bottle(s).`
            : `Added ${n} bottle(s) as #${wine.id}.`,
          { merged, warnings },
        );
      }),
  );

  server.registerTool(
    "systembolaget_cellar_update",
    {
      title: "Edit a wine in the user's cellar",
      description: `Change details of a cellar wine: where it is, its drinking window, the user's notes, what was paid, or a corrected identity.

A field left out is kept; a field set to null is cleared. Notes are replaced, not appended -- to add a line, send the old notes with the new line.

This is also how a wine nobody describes gets filled in -- a grower Champagne, a bottle from a trip. Research first: the house's own technical sheet for that cuvée, then reputable reviews, and only then general knowledge. Write claude_profile in plain words -- style, how it tastes, what to eat with it, how it will age -- and give claude_sources, which is required: URLs, or 'general knowledge, unverified' for anything that is. Fill in missing label facts only when a source covers this exact bottle: a non-vintage cuvée changes blend, base year and dosage with every release, so the house's current sheet may describe a different wine from the one in the cellar. A drinking window you estimate goes in drink_from/drink_until, and the estimate is named in claude_sources.

'quantity' sets the count outright and is recorded as a correction. Bottles drunk, given away or broken go through systembolaget_cellar_remove instead, which keeps the rating and the occasion.

Args:
  - wine_id (number): from systembolaget_cellar_list
  - quantity (number): corrected bottle count
  - name, producer, vintage, country, region, category, grapes, volume_ml, purchase_price, purchased_on, purchased_from, location, drink_from, drink_until, notes
  - abv, sugar_g_l, style, base_vintage, disgorged_on: label facts
  - claude_profile, claude_sources: your profile and where it came from -- always together

Returns the wine as stored.

Examples:
  - "Moved the Barolos to the bottom rack" -> location
  - "That one is ready from 2028" -> drink_from=2028
  - Filling in a Champagne: claude_profile='Pinot-led and vinous, ...', claude_sources='house tech sheet (url); drinking window: Claude's estimate'


Error Handling:
  - An unknown wine_id returns an error; list the cellar to find it.
  - Changing the vintage of a Systembolaget wine drops the copied tasting note, which described the old one.
  - A claude_profile without claude_sources is refused.`,
      inputSchema: z
        .object({
          wine_id: z.number().int().min(1).describe("Cellar wine id"),
          name: z.string().trim().min(1).max(200).optional().describe("Wine name"),
          quantity: z.number().int().min(0).max(10000).optional().describe("Corrected bottle count"),
          ...wineFields,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ wine_id, ...patch }) =>
      guard(() => {
        const bad = checkWindow(patch.drink_from, patch.drink_until);
        if (bad) return errorResult(bad);
        const wine = cellar.update(wine_id, patch);
        return written(cellar, wine, `Updated #${wine.id}.`);
      }),
  );

  server.registerTool(
    "systembolaget_cellar_remove",
    {
      title: "Take bottles out of the user's cellar",
      description: `Record bottles leaving the cellar: drunk, given away, sold or broken. The wine and its history stay, so a rating given now informs recommendations later.

When a bottle was drunk, ask how it was if they have not said -- a rating and one line on the occasion or the food is what makes later recommendations theirs rather than generic. Never supply a rating or a note on their behalf.

Args:
  - wine_id (number): from systembolaget_cellar_list
  - quantity (number): bottles taken out (default: 1)
  - reason ('drunk' | 'gift' | 'sold' | 'broken' | 'other'): default 'drunk'
  - on_date (YYYY-MM-DD): default today
  - rating (1-5), note: the user's verdict

Returns the wine with its remaining count.

Examples:
  - "We had the Montus with the lamb, fantastic" -> wine_id, rating=5, note='with lamb, fantastic'
  - "Gave a bottle of the Chablis to my neighbour" -> reason='gift'

Error Handling:
  - Taking out more bottles than are recorded is refused; correct the count with systembolaget_cellar_update if it was wrong.`,
      inputSchema: z
        .object({
          wine_id: z.number().int().min(1).describe("Cellar wine id"),
          quantity: z.number().int().min(1).max(1000).default(1).describe("Bottles taken out (default: 1)"),
          reason: z.enum(REMOVAL_REASONS).default("drunk").describe("Why they left the cellar (default: drunk)"),
          on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional().describe("When, YYYY-MM-DD (default: today)"),
          rating: z.number().int().min(1).max(5).optional().describe("The user's rating, 1-5"),
          note: z.string().trim().min(1).max(2000).optional().describe("The user's note: how it was, the food, the occasion"),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ wine_id, ...r }) =>
      guard(() => {
        const wine = cellar.remove(wine_id, r);
        const left = wine.quantity === 0 ? "none left" : `${wine.quantity} left`;
        return written(cellar, wine, `Took out ${r.quantity} (${r.reason}): ${left}.`);
      }),
  );
}
