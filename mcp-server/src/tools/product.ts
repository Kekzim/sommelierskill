import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Mirror } from "../db.js";
import { LIST_COLUMNS, ProductRow, availabilitySchema, pagingSchema, productMarkdown } from "../product.js";
import { Page, guard, kr, paginate, textResult, toolResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerProductTools(server: McpServer, db: Mirror): void {
  server.registerTool(
    "systembolaget_get_product",
    {
      title: "Get one product in full",
      description: `Fetch every mirrored detail for a single product: taste clocks, grapes, food pairings, dietary flags, release date and which mirrored stores carry it.

Args:
  - product_id (string): the id from a search result, e.g. '60142790'
  - response_format ('markdown' | 'json')

Returns the full record, its grape list, its pairings, and the mirrored stores carrying it.

Examples:
  - Use after a search to check grapes or pairings before recommending.
  - Use to confirm identity: name search is unreliable in both directions, so check the producer.

Error Handling:
  - Returns "No product with id X" and suggests searching by name instead.`,
      inputSchema: z
        .object({
          product_id: z.string().min(1).describe("Product id from a search result"),
          response_format: z.enum(["markdown", "json"]).default("markdown"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ product_id, response_format }) =>
      guard(() => {
        const p = db.get<Record<string, unknown>>(
          `SELECT product_id, product_number, full_name, producer, supplier, country, origin1,
                  origin2, cat1, cat2, cat3, vintage, price, volume_ml, abv, sek_per_litre,
                  availability, availability_rank, assortment_text, assortment_code,
                  launch_date, sell_start_time, is_news,
                  is_organic, is_vegan, is_natural, is_gluten_free, is_kosher,
                  clock_body, clock_tannin, clock_sweetness, clock_bitter, clock_fruitacid,
                  clock_smokiness, packaging, taste, color, usage
           FROM product WHERE product_id = ?`,
          product_id,
        );
        if (!p) {
          return textResult(
            `No product with id ${product_id}. Ids come from search results -- try ` +
              `systembolaget_search_products with a name instead.`,
          );
        }

        const grapes = db
          .all<{ grape: string }>(`SELECT grape FROM product_grape WHERE product_id = ? ORDER BY grape`, product_id)
          .map((r) => r.grape);
        const pairings = db
          .all<{ pairing: string }>(`SELECT pairing FROM product_pairing WHERE product_id = ? ORDER BY pairing`, product_id)
          .map((r) => r.pairing);
        const stores = db.all<{ site_id: string; name: string }>(
          `SELECT s.site_id, s.name FROM store_product sp JOIN store s ON s.site_id = sp.site_id
           WHERE sp.product_id = ? ORDER BY s.name`,
          product_id,
        );

        const output = { ...p, grapes, pairings, carried_by: stores };

        if (response_format === "json") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        const lines = [productMarkdown(p as ProductRow)];
        if (grapes.length) lines.push(`- **Grapes**: ${grapes.join(", ")}`);
        if (pairings.length) lines.push(`- **Pairs with**: ${pairings.join(", ")}`);
        if (p.color) lines.push(`- **Colour**: ${p.color}`);
        if (p.usage) lines.push(`- **Serving**: ${p.usage}`);
        if (p.launch_date) {
          lines.push(
            `- **Listed**: ${String(p.launch_date).slice(0, 10)}` +
              (p.sell_start_time ? ` at ${p.sell_start_time}` : ""),
          );
        }
        const diet = [
          p.is_organic ? "organic" : null,
          p.is_vegan === 1 ? "vegan" : null,
          p.is_natural === 1 ? "natural" : null,
          p.is_gluten_free === 1 ? "gluten-free" : null,
          p.is_kosher === 1 ? "kosher" : null,
        ].filter(Boolean);
        if (diet.length) lines.push(`- **Flags**: ${diet.join(", ")}`);
        lines.push(
          stores.length
            ? `- **Carried by**: ${stores.map((s) => `${s.name} (${s.site_id})`).join(", ")} ` +
              `-- carried, not necessarily on the shelf today`
            : `- **Carried by**: none of the mirrored stores (other stores are not mirrored, ` +
              `which is not the same as not stocking it)`,
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: output,
        };
      }),
  );

  server.registerTool(
    "systembolaget_find_similar",
    {
      title: "Find something similar to a product",
      description: `Given a product the user liked, find others close to it on taste, preferring shared grapes and the same category.

Similarity is taste-clock distance (body, tannin, sweetness, fruit acidity) with shared grapes ranked first. Given a Barolo this returns Langhe Nebbiolo and Barbaresco.

Args:
  - product_id (string): the reference product, from a search result
  - cheaper_only (boolean): only products below the reference price (default: true) -- the common ask is a cheaper alternative
  - max_availability_rank, limit, offset, response_format

Returns products ordered by shared grapes, then taste distance, then price.

Examples:
  - "Something like the Barolo I had, but cheaper" -> find the Barolo, then this with cheaper_only=true
  - "More like this" -> cheaper_only=false

Error Handling:
  - Returns "No product with id X" if the reference is unknown.
  - Confirm the reference is the wine they meant before trusting the result -- name search is unreliable.`,
      inputSchema: z
        .object({
          product_id: z.string().min(1).describe("Reference product id"),
          cheaper_only: z
            .boolean()
            .default(true)
            .describe("Only return products cheaper than the reference (default: true)"),
          ...availabilitySchema,
          ...pagingSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const ref = db.get<ProductRow>(
          `SELECT ${LIST_COLUMNS} FROM product p WHERE p.product_id = ?`,
          params.product_id,
        );
        if (!ref) {
          return textResult(
            `No product with id ${params.product_id}. Search for it by name first, and check the ` +
              `producer matches before using it as a reference.`,
          );
        }

        const where = [
          "p.product_id <> ?",
          "p.cat2 IS ?",
          "p.availability_rank <= ?",
          "p.is_discontinued = 0",
        ];
        const binds: unknown[] = [ref.product_id, ref.cat2, params.max_availability_rank];
        if (params.cheaper_only && ref.price !== null) {
          where.push("p.price < ?");
          binds.push(ref.price);
        }

        // COALESCE so a missing clock counts as a moderate difference rather
        // than silently scoring as a perfect match.
        const distance = `
          ABS(COALESCE(p.clock_body,6) - ?) + ABS(COALESCE(p.clock_tannin,6) - ?)
        + ABS(COALESCE(p.clock_sweetness,0) - ?) + ABS(COALESCE(p.clock_fruitacid,6) - ?)`;
        const clockBinds = [
          ref.clock_body ?? 6,
          ref.clock_tannin ?? 6,
          ref.clock_sweetness ?? 0,
          ref.clock_fruitacid ?? 6,
        ];

        const whereSql = where.join(" AND ");
        const { total } = db.get<{ total: number }>(
          `SELECT count(*) AS total FROM product p WHERE ${whereSql}`,
          ...binds,
        )!;

        const rows = db.all<ProductRow & { distance: number; shared_grapes: number }>(
          `SELECT ${LIST_COLUMNS},
                  ${distance} AS distance,
                  (SELECT count(*) FROM product_grape g
                    WHERE g.product_id = p.product_id
                      AND g.grape IN (SELECT grape FROM product_grape WHERE product_id = ?)
                  ) AS shared_grapes
           FROM product p
           WHERE ${whereSql}
           ORDER BY shared_grapes DESC, distance ASC, p.price ASC
           LIMIT ? OFFSET ?`,
          ...clockBinds,
          ref.product_id,
          ...binds,
          params.limit,
          params.offset,
        );

        if (!rows.length) {
          return textResult(
            `Nothing similar to ${ref.full_name} found. Try cheaper_only=false, or raise ` +
              `max_availability_rank to 2.`,
          );
        }

        const title = `Similar to ${ref.full_name} (${kr(ref.price)})`;
        return toolResult(
          paginate(rows, total, params.offset),
          (page: Page<ProductRow & { distance: number; shared_grapes: number }>) =>
            [`# ${title}`, `${page.total} candidates (showing ${page.count})`]
              .concat(
                page.items.map(
                  (r) =>
                    `${productMarkdown(r)}\n- *${r.shared_grapes} shared grape(s), taste distance ${r.distance}*`,
                ),
              )
              .join("\n\n"),
          params.response_format,
        );
      }),
  );
}
