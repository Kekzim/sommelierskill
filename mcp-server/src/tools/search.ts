import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Mirror } from "../db.js";
import {
  LIST_COLUMNS,
  ProductRow,
  availabilitySchema,
  commonFilters,
  pagingSchema,
  productMarkdown,
} from "../product.js";
import { Page, guard, paginate, textResult, toolResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function render(title: string) {
  return (page: Page<ProductRow>): string => {
    const head = [`# ${title}`, `${page.total} matches (showing ${page.count})`];
    return head.concat(page.items.map(productMarkdown)).join("\n\n");
  };
}

export function registerSearchTools(server: McpServer, db: Mirror): void {
  const searchSchema = z
    .object({
      name: z
        .string()
        .min(2)
        .max(200)
        .optional()
        .describe("Match against product name and producer, e.g. 'Barolo' or 'Torres'"),
      category: z
        .string()
        .optional()
        .describe("Category: cat1 like 'Vin', 'Öl', 'Sprit', or cat2 like 'Rött vin', 'Whisky'"),
      country: z.string().optional().describe("Country as Systembolaget spells it, e.g. 'Italien'"),
      grape: z
        .string()
        .optional()
        .describe(
          "Canonical grape name, e.g. 'Syrah' -- also matches wines the API labelled 'Shiraz'",
        ),
      pairing: z
        .string()
        .optional()
        .describe("Food pairing, e.g. 'Lamm', 'Fisk', 'Ost', 'Vilt', 'Sällskapsdryck'"),
      exclude_grape: z.string().optional().describe("Exclude wines containing this grape"),
      min_price: z.number().min(0).optional().describe("Minimum price in SEK"),
      max_price: z.number().min(0).optional().describe("Maximum price in SEK"),
      store_id: z
        .string()
        .optional()
        .describe(
          "Only products this store carries, e.g. '1001'. Only mirrored stores have assortment " +
            "data -- check with systembolaget_list_stores first.",
        ),
      organic: z.boolean().optional().describe("Only organic products"),
      vegan: z.boolean().optional().describe("Only products confirmed vegan"),
      min_body: z.number().int().min(0).max(12).optional().describe("Minimum clock_body (0-12)"),
      max_body: z.number().int().min(0).max(12).optional().describe("Maximum clock_body (0-12)"),
      min_tannin: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .describe("Minimum clock_tannin, Systembolaget's strävhet (0-12)"),
      max_tannin: z.number().int().min(0).max(12).optional().describe("Maximum clock_tannin (0-12)"),
      max_sweetness: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .describe("Maximum clock_sweetness; <= 2 is dry"),
      min_fruitacid: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .describe("Minimum clock_fruitacid; >= 8 reads as fresh or crisp"),
      sort: z
        .enum(["price_asc", "price_desc", "value", "body_desc", "name"])
        .default("price_asc")
        .describe(
          "Ordering. 'value' is price per litre, the only fair comparison across bottle sizes " +
            "(volumes range from 60 ml to 30 litres).",
        ),
      ...availabilitySchema,
      ...pagingSchema,
    })
    .strict();

  server.registerTool(
    "systembolaget_search_products",
    {
      title: "Search Systembolaget products",
      description: `Search the mirrored Systembolaget assortment by name, category, grape, food pairing, price, taste profile, dietary flags and store.

This is the main discovery tool. It searches ~27,000 products that Systembolaget lists in Sweden, including order-only ones. It reads a local mirror, so it does NOT know today's shelf count -- use systembolaget_check_stock for that.

Args:
  - name, category, country, grape, pairing, exclude_grape: content filters
  - min_price / max_price (number): SEK
  - min_body / max_body / min_tannin / max_tannin / max_sweetness / min_fruitacid (0-12): taste clocks
  - organic / vegan (boolean): dietary filters
  - store_id (string): restrict to a mirrored store's assortment
  - max_availability_rank (1-3): 1 = on shelves (default), 2 = while stocks last, 3 = order-only
  - sort: price_asc | price_desc | value | body_desc | name
  - limit, offset, response_format

Returns a page of products with id, name, producer, country, price, availability and taste.

Examples:
  - "A spicy red under 200 kr my local shop has" -> category='Rött vin', max_price=200, store_id='1001'
  - "Something like Barolo but cheaper" -> prefer systembolaget_find_similar
  - "What's dropping on Friday" -> use systembolaget_upcoming_releases

Error Handling:
  - Returns "No products found" with the filters echoed back, so you can loosen them.
  - An over-constrained search returning nothing is a worse answer than a looser one returning near misses.`,
      inputSchema: searchSchema,
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const { sql, params: binds } = commonFilters(params);

        if (params.name) {
          sql.push("(p.full_name LIKE ? OR p.producer LIKE ?)");
          binds.push(`%${params.name}%`, `%${params.name}%`);
        }
        if (params.grape) {
          sql.push(
            "EXISTS (SELECT 1 FROM product_grape g WHERE g.product_id = p.product_id AND g.grape = ?)",
          );
          binds.push(params.grape);
        }
        if (params.exclude_grape) {
          sql.push(
            "NOT EXISTS (SELECT 1 FROM product_grape g WHERE g.product_id = p.product_id AND g.grape = ?)",
          );
          binds.push(params.exclude_grape);
        }
        if (params.pairing) {
          sql.push(
            "EXISTS (SELECT 1 FROM product_pairing r WHERE r.product_id = p.product_id AND r.pairing = ?)",
          );
          binds.push(params.pairing);
        }
        if (params.organic) sql.push("p.is_organic = 1");
        // NULL means "not yet enriched", not false, so test for 1 explicitly.
        if (params.vegan) sql.push("p.is_vegan = 1");

        const clocks: [string, number | undefined][] = [
          ["p.clock_body >= ?", params.min_body],
          ["p.clock_body <= ?", params.max_body],
          ["p.clock_tannin >= ?", params.min_tannin],
          ["p.clock_tannin <= ?", params.max_tannin],
          ["p.clock_sweetness <= ?", params.max_sweetness],
          ["p.clock_fruitacid >= ?", params.min_fruitacid],
        ];
        for (const [frag, val] of clocks) {
          if (val !== undefined) {
            sql.push(frag);
            binds.push(val);
          }
        }

        const order = {
          price_asc: "p.price ASC",
          price_desc: "p.price DESC",
          value: "p.sek_per_litre ASC",
          body_desc: "p.clock_body DESC, p.price ASC",
          name: "p.full_name ASC",
        }[params.sort];

        const where = sql.join(" AND ");
        const { total } = db.get<{ total: number }>(
          `SELECT count(*) AS total FROM product p WHERE ${where}`,
          ...binds,
        )!;
        const rows = db.all<ProductRow>(
          `SELECT ${LIST_COLUMNS} FROM product p WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
          ...binds,
          params.limit,
          params.offset,
        );

        if (!rows.length) {
          return textResult(
            `No products found. Filters applied: ${JSON.stringify(
              Object.fromEntries(
                Object.entries(params).filter(
                  ([k, v]) => v !== undefined && !["limit", "offset", "response_format"].includes(k),
                ),
              ),
            )}. Try loosening the taste clocks, raising max_price, or raising max_availability_rank to 2.`,
          );
        }

        return toolResult(
          paginate(rows, total, params.offset),
          render("Search results"),
          params.response_format,
        );
      }),
  );

  const notesSchema = z
    .object({
      match: z
        .string()
        .min(2)
        .max(300)
        .describe(
          "FTS5 query over Swedish tasting notes. Supports AND, OR, NOT and column filters, " +
            "e.g. \"taste:(tobak AND körsbär) NOT taste:ek\". Diacritics fold, so 'korsbar' " +
            "matches 'körsbär'.",
        ),
      category: z
        .string()
        .optional()
        .describe("Restrict to a category, e.g. 'Rött vin' -- notes exist for beer and spirits too"),
      country: z.string().optional().describe("Country, e.g. 'Italien'"),
      min_price: z.number().min(0).optional().describe("Minimum price in SEK"),
      max_price: z.number().min(0).optional().describe("Maximum price in SEK"),
      store_id: z.string().optional().describe("Only products a mirrored store carries"),
      ...availabilitySchema,
      ...pagingSchema,
    })
    .strict();

  server.registerTool(
    "systembolaget_search_tasting_notes",
    {
      title: "Boolean search over tasting notes",
      description: `Full-text search across tasting notes, colour and serving suggestions, with real boolean logic.

Systembolaget's own site cannot do this -- it offers single-term search only. Notes are in Swedish: körsbär (cherry), hallon (raspberry), svarta vinbär (blackcurrant), plommon (plum), läder (leather), tobak (tobacco), choklad (chocolate), vanilj (vanilla), ek (oak), kryddig (spicy), mineralisk (mineral), smörig (buttery), rostad (toasted).

Args:
  - match (string): an FTS5 expression, e.g. "taste:(tobak AND körsbär) NOT taste:ek"
  - category, country, min_price, max_price, store_id: narrow the matches -- notes exist for beer and spirits too, not only wine
  - max_availability_rank, limit, offset, response_format

Column-filter syntax matters: "taste:(a AND b)" works, but "taste:a AND taste:b" does not match the way you expect.

Returns a page of matching products.

Examples:
  - "Smoky but not oaky" -> match="taste:rök NOT taste:ek"
  - "Cherry and leather" -> match="taste:(körsbär AND läder)"

Error Handling:
  - Malformed FTS syntax returns the SQLite parse error plus a corrected example.
  - Note that taste is present for 99.7% of shelf-stocked products but only ~12% of order-only ones, so raising max_availability_rank adds few matches here.`,
      inputSchema: notesSchema,
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const { sql, params: filterBinds } = commonFilters(params);
        const where = ["product_fts MATCH ?", ...sql].join(" AND ");
        const binds: unknown[] = [params.match, ...filterBinds];
        let total: number;
        try {
          total = db.get<{ total: number }>(
            `SELECT count(*) AS total FROM product_fts f JOIN product p ON p.rowid = f.rowid WHERE ${where}`,
            ...binds,
          )!.total;
        } catch (err) {
          throw new Error(
            `Invalid full-text query: ${(err as Error).message}. ` +
              `Use FTS5 syntax such as "taste:(tobak AND körsbär) NOT taste:ek".`,
          );
        }

        const rows = db.all<ProductRow>(
          `SELECT ${LIST_COLUMNS} FROM product_fts f JOIN product p ON p.rowid = f.rowid
           WHERE ${where} ORDER BY p.price ASC LIMIT ? OFFSET ?`,
          ...binds,
          params.limit,
          params.offset,
        );

        if (!rows.length) {
          return textResult(
            `No tasting notes matched '${params.match}'. Notes are in Swedish -- try a Swedish ` +
              `flavour word, drop a NOT clause, or broaden with OR.`,
          );
        }

        return toolResult(
          paginate(rows, total, params.offset),
          render(`Tasting notes matching '${params.match}'`),
          params.response_format,
        );
      }),
  );
}
