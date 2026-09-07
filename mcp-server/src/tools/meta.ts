import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Mirror } from "../db.js";
import { CHARACTER_LIMIT, SQL_ROW_CAP } from "../constants.js";
import { guard, textResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * The columns the `query` tool advertises, read from the mirror itself.
 *
 * This list used to be typed out here, which is the same duplication the Go
 * side removed by generating everything from one declaration -- and it had
 * already drifted: `is_web_launch` was missing, so an agent writing SQL had no
 * way to know web allocations could be told apart from shop releases.
 *
 * The database is the artefact both languages share, so it is the thing to ask.
 * `raw` is left out deliberately: it is the verbatim API JSON for every row and
 * selecting it would blow the response budget on one product.
 */
const FALLBACK_PRODUCT_COLUMNS =
  "product_id, full_name, name, producer, country, cat1, cat2, cat3, vintage, " +
  "price, volume_ml, abv, sek_per_litre, availability, availability_rank, " +
  "assortment_code, launch_date, sell_start_time, is_news, is_web_launch";

function productColumnList(db: Mirror): string {
  try {
    const cols = db.all<{ name: string }>(
      // xinfo, not info: table_info hides generated columns, and sek_per_litre
      // is one -- the very column this description tells an agent to compare
      // value with.
      `SELECT name FROM pragma_table_xinfo('product') ORDER BY cid`,
    );
    const usable = cols.map((c) => c.name).filter((n) => n !== "raw");
    if (usable.length > 0) return usable.join(", ");
  } catch {
    // The server starts without a mirror on purpose and reports that through
    // /health. A tool description is no place to fail over it.
  }
  return FALLBACK_PRODUCT_COLUMNS;
}

export function registerMetaTools(server: McpServer, db: Mirror): void {
  server.registerTool(
    "systembolaget_data_freshness",
    {
      title: "How current is the mirror",
      description: `Report when the mirror was last synced, how much it holds, and which stores have mirrored assortments.

Worth checking before quoting prices: the mirror is refreshed on a schedule, so prices are as of the last sync, not today. If products carry two different sync timestamps, a sync was interrupted and the mirror is half-refreshed.

Returns counts by category, the last sync time, and the mirrored stores.

Examples:
  - Call before quoting a price if the answer needs to be precise.
  - Call when results look stale or a product the user saw in store is missing.`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async () =>
      guard(() => {
        const totals = db.get<{ products: number; last_sync: string; sync_dates: number }>(
          `SELECT count(*) AS products, max(synced_at) AS last_sync,
                  count(DISTINCT substr(synced_at,1,10)) AS sync_dates FROM product`,
        )!;
        const byCategory = db.all<{ cat1: string; n: number; stocked: number }>(
          `SELECT cat1, count(*) AS n, sum(availability_rank = 1) AS stocked
           FROM product GROUP BY cat1 ORDER BY n DESC`,
        );
        const stores = db.all<{ site_id: string; name: string; products: number }>(
          `SELECT s.site_id, s.name, count(*) AS products
           FROM store_product sp JOIN store s ON s.site_id = sp.site_id
           GROUP BY sp.site_id ORDER BY s.name`,
        );
        const releases = db.get<{ upcoming: number; furthest: string }>(
          `SELECT count(*) AS upcoming, max(substr(launch_date,1,10)) AS furthest
           FROM product WHERE substr(launch_date,1,10) > date('now')`,
        )!;

        const output = { ...totals, categories: byCategory, mirrored_stores: stores, releases };
        const lines = [
          "# Mirror status",
          "",
          `- **Products**: ${totals.products}`,
          `- **Last sync**: ${totals.last_sync}`,
          `- **Announced future releases**: ${releases.upcoming}` +
            (releases.furthest ? `, out to ${releases.furthest}` : ""),
          "",
        ];
        if (totals.sync_dates > 1) {
          lines.push(
            `> Products carry ${totals.sync_dates} different sync dates, so a sync was interrupted ` +
              `and the mirror is part-refreshed. Treat older rows with caution.`,
            "",
          );
        }
        lines.push("| Category | Products | On shelves |", "|---|---|---|");
        for (const c of byCategory) lines.push(`| ${c.cat1} | ${c.n} | ${c.stocked} |`);
        lines.push("", "**Mirrored stores** (the only ones with assortment data):");
        for (const s of stores) lines.push(`- ${s.name} (${s.site_id}): ${s.products} products`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: output,
        };
      }),
  );

  server.registerTool(
    "systembolaget_query",
    {
      title: "Run read-only SQL against the mirror",
      description: `Run a single read-only SQL query against the mirror, for questions the other tools do not cover -- aggregations, unusual joins, counting, grouping.

The whole point of this mirror is that Systembolaget's own API is a product search rather than a query engine: no aggregation, no boolean logic, no derived sorting. This tool is that escape hatch. Prefer the purpose-built tools when they fit; reach for this to count, group or correlate.

Tables:
  - product: ${productColumnList(db)}
    plus 'raw', the verbatim API JSON for that product -- never select it in a list query
  - product_grape (product_id, grape, raw_name) -- grape is canonical, so 'Syrah' also finds 'Shiraz'
  - product_pairing (product_id, pairing)
  - product_fts -- FTS5 over name, producer, taste, color, usage; join on p.rowid = f.rowid
  - store (site_id, name, city, county), store_product (site_id, product_id)

Gotchas that produce wrong answers silently:
  - cat3 is NULL for ~62% of wine, so filtering on it drops most of a category
  - compare value with sek_per_litre, never price -- volumes run 60 ml to 30 litres
  - the same wine appears once per vintage and per bottle size; group by full_name and producer
  - is_vegan and friends are NULL when unknown, which is not the same as 0
  - taste is present for 99.7% of shelf-stocked products but ~12% of order-only ones

Args:
  - sql (string): one SELECT (or WITH ... SELECT) statement
  - response_format ('markdown' | 'json')

Returns the result rows. A query without its own LIMIT is capped at ${SQL_ROW_CAP} rows.

Error Handling:
  - Only SELECT/WITH is accepted; the connection is read-only, so writes are impossible.
  - ATTACH, DETACH, PRAGMA and VACUUM are refused.
  - SQLite errors are returned verbatim so the query can be corrected.`,
      inputSchema: z
        .object({
          sql: z.string().min(1).max(4000).describe("A single SELECT or WITH ... SELECT statement"),
          response_format: z.enum(["markdown", "json"]).default("markdown"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ sql, response_format }) =>
      guard(() => {
        const { rows, capped } = db.query(sql);
        if (!rows.length) return textResult("Query returned no rows.");

        const output: Record<string, unknown> = { count: rows.length, rows };
        if (capped && rows.length === SQL_ROW_CAP) {
          output.capped = true;
          output.cap_message = `Results capped at ${SQL_ROW_CAP} rows. Add your own LIMIT, or aggregate.`;
        }

        let text: string;
        if (response_format === "json") {
          text = JSON.stringify(output, null, 2);
        } else {
          const cols = Object.keys(rows[0]);
          const cell = (v: unknown) => (v === null ? "" : String(v).replace(/\|/g, "\\|"));
          text = [
            `| ${cols.join(" | ")} |`,
            `|${cols.map(() => "---").join("|")}|`,
            ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`),
          ].join("\n");
          if (output.capped) text += `\n\n${output.cap_message}`;
        }

        if (text.length > CHARACTER_LIMIT) {
          text =
            text.slice(0, CHARACTER_LIMIT) +
            `\n\n[truncated at ${CHARACTER_LIMIT} characters -- add a LIMIT, select fewer columns, or aggregate]`;
        }
        return { content: [{ type: "text" as const, text }], structuredContent: output };
      }),
  );
}
