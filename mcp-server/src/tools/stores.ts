import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Mirror } from "../db.js";
import { MAX_STOCK_CHECKS, STOCK_API, STOCK_TIMEOUT_MS } from "../constants.js";
import { guard, textResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface StockResult {
  product_id: string;
  full_name: string | null;
  stock: number | null;
  shelf: string | null;
  error?: string;
}

export function registerStoreTools(server: McpServer, db: Mirror, apiKey: string | undefined): void {
  server.registerTool(
    "systembolaget_list_stores",
    {
      title: "Find Systembolaget stores",
      description: `Look up store ids by town or name, and see which stores have their assortment mirrored.

Only mirrored stores can answer "does my shop carry this" -- a store present here but not mirrored simply has no assortment data, which is NOT the same as carrying nothing.

Args:
  - search (string): match against store name, city or county, e.g. 'karlskrona'
  - mirrored_only (boolean): only stores whose assortment is mirrored (default: false)
  - limit, response_format

Returns store id, name, city, county and whether the assortment is mirrored.

Examples:
  - "My local is Wachtmeister" -> search='wachtmeister' to get site_id 1001
  - "Which shops can you actually check?" -> mirrored_only=true`,
      inputSchema: z
        .object({
          search: z.string().min(1).optional().describe("Match store name, city or county"),
          mirrored_only: z
            .boolean()
            .default(false)
            .describe("Only stores with a mirrored assortment (default: false)"),
          limit: z.number().int().min(1).max(100).default(20),
          response_format: z.enum(["markdown", "json"]).default("markdown"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const where: string[] = [];
        const binds: unknown[] = [];
        if (params.search) {
          where.push("(s.name LIKE ? OR s.city LIKE ? OR s.county LIKE ?)");
          const q = `%${params.search}%`;
          binds.push(q, q, q);
        }
        if (params.mirrored_only) {
          where.push("EXISTS (SELECT 1 FROM store_product sp WHERE sp.site_id = s.site_id)");
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const rows = db.all<{
          site_id: string;
          name: string;
          city: string | null;
          county: string | null;
          products: number;
        }>(
          `SELECT s.site_id, s.name, s.city, s.county,
                  (SELECT count(*) FROM store_product sp WHERE sp.site_id = s.site_id) AS products
           FROM store s ${whereSql} ORDER BY products DESC, s.name LIMIT ?`,
          ...binds,
          params.limit,
        );

        if (!rows.length) {
          return textResult(
            `No stores matched${params.search ? ` '${params.search}'` : ""}. Try a town name, ` +
              `or drop mirrored_only to see every store.`,
          );
        }

        const output = {
          count: rows.length,
          stores: rows.map((r) => ({ ...r, mirrored: r.products > 0 })),
        };
        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }
        const lines = ["# Stores", ""];
        for (const r of rows) {
          lines.push(
            `- **${r.name}** (${r.site_id}) — ${r.city ?? "?"}` +
              (r.products > 0 ? `, ${r.products} products mirrored` : ", assortment not mirrored"),
          );
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: output,
        };
      }),
  );

  server.registerTool(
    "systembolaget_check_stock",
    {
      title: "Check live shelf stock at a store",
      description: `Check how many bottles a store has on the shelf right now, and where in the shop they are.

This is the only tool that leaves the mirror and calls Systembolaget live. Stock changes hourly and is never mirrored, so this is the only way to answer "is there one there now" rather than "does that shop carry it". Never cache the answer.

Use it for a shortlist only -- at most ${MAX_STOCK_CHECKS} products per call. This is an undocumented API and should not be hit harder than a person browsing.

Args:
  - store_id (string): site id, e.g. '1001' (find it with systembolaget_list_stores)
  - product_ids (string[]): up to ${MAX_STOCK_CHECKS} ids from search results

Returns per product: stock count and shelf position where available.

Examples:
  - After narrowing to three candidates, check all three at the user's shop.
  - Don't use to explore -- filter with systembolaget_search_products first.

Error Handling:
  - A product with no stock entry returns stock 0 rather than an error; the store may simply not carry it.
  - Network or API failures are reported per product, so one failure does not lose the rest.`,
      inputSchema: z
        .object({
          store_id: z.string().min(1).describe("Store site id, e.g. '1001'"),
          product_ids: z
            .array(z.string().min(1))
            .min(1)
            .max(MAX_STOCK_CHECKS)
            .describe(`Product ids to check, at most ${MAX_STOCK_CHECKS}`),
        })
        .strict(),
      // The one tool that reaches outside: it calls Systembolaget's live API.
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    },
    async ({ store_id, product_ids }) =>
      guard(async () => {
        if (!apiKey) {
          return textResult(
            "Live stock checks are not configured: set SYSTEMBOLAGET_API_KEY on the server. " +
              "Product facts still work; only today's shelf count is unavailable.",
          );
        }

        const store = db.get<{ name: string }>(`SELECT name FROM store WHERE site_id = ?`, store_id);

        const results: StockResult[] = await Promise.all(
          product_ids.map(async (id): Promise<StockResult> => {
            const named = db.get<{ full_name: string }>(
              `SELECT full_name FROM product WHERE product_id = ?`,
              id,
            );
            try {
              const res = await fetch(`${STOCK_API}/${encodeURIComponent(store_id)}/${encodeURIComponent(id)}/`, {
                headers: {
                  Origin: "https://www.systembolaget.se",
                  Accept: "application/json",
                  "Ocp-Apim-Subscription-Key": apiKey,
                },
                signal: AbortSignal.timeout(STOCK_TIMEOUT_MS),
              });
              if (res.status === 404) {
                return { product_id: id, full_name: named?.full_name ?? null, stock: 0, shelf: null };
              }
              if (!res.ok) {
                return {
                  product_id: id,
                  full_name: named?.full_name ?? null,
                  stock: null,
                  shelf: null,
                  error: `stock API returned ${res.status}`,
                };
              }
              const body = (await res.json()) as { stock?: number; shelf?: string };
              return {
                product_id: id,
                full_name: named?.full_name ?? null,
                stock: body.stock ?? 0,
                shelf: body.shelf ?? null,
              };
            } catch (err) {
              return {
                product_id: id,
                full_name: named?.full_name ?? null,
                stock: null,
                shelf: null,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );

        const output = {
          store_id,
          store_name: store?.name ?? null,
          checked_at: new Date().toISOString(),
          results,
        };
        const lines = [`# Stock at ${store?.name ?? store_id}`, "", `Checked ${output.checked_at}`, ""];
        for (const r of results) {
          const label = r.full_name ?? r.product_id;
          if (r.error) lines.push(`- **${label}**: could not check (${r.error})`);
          else if (r.stock === 0) lines.push(`- **${label}**: none on the shelf`);
          else lines.push(`- **${label}**: ${r.stock} in stock${r.shelf ? `, shelf ${r.shelf}` : ""}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: output,
        };
      }),
  );
}
