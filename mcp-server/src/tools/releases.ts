import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Mirror } from "../db.js";
import { LIST_COLUMNS, ProductRow, commonFilters, pagingSchema, productMarkdown } from "../product.js";
import { Page, guard, paginate, textResult, toolResult } from "../response.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface ReleaseRow extends ProductRow {
  launch_date: string;
  sell_start_time: string | null;
  assortment_code: string | null;
  is_web_launch: number;
}

/** Today in Stockholm, as YYYY-MM-DD. Release dates are local Swedish dates. */
function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function registerReleaseTools(server: McpServer, db: Mirror): void {
  server.registerTool(
    "systembolaget_upcoming_releases",
    {
      title: "Upcoming and recent Systembolaget releases",
      description: `List products by their release date -- what is about to be listed, or what was listed recently.

Systembolaget lists limited products on a weekly cadence, almost always Thursday or Friday, and pre-announces them: the mirror carries hundreds of products whose launch date is still in the future. That is what makes this answerable ahead of time, and it matters because limited releases sell out -- they are 'while stocks last', not restocked.

Args:
  - from_date / to_date (YYYY-MM-DD): the window. Defaults to today through 14 days ahead.
  - limited_only (boolean): only the temporary assortment, i.e. the drops that disappear (default: true)
  - web_launches ('include' | 'exclude' | 'only'): web launches are allocation drops applied for online rather than bought over the counter, and are where the rarest bottles appear (Latour, Romanee Saint Vivant). They read as 'order_only' because their assortment text is not a shelf tier -- that is correct but misleading, so they are labelled explicitly in the output.
  - category, country, min_price, max_price, store_id: the usual filters
  - limit, offset, response_format

Returns products ordered by launch date, then price descending, each with its launch date, sell start time and assortment code (TSE and TSV are both 'Tillfälligt sortiment'; TSS is 'Säsong'; TSLS is 'Lokalt & Småskaligt').

Examples:
  - "What drops this Friday?" -> from_date and to_date both set to that Friday
  - "Anything interesting coming up?" -> defaults, then filter by price
  - "What did I miss last week?" -> from_date=-7 days, to_date=today
  - "Any rare allocations coming?" -> web_launches='only'
  - "What can I actually walk in and buy?" -> web_launches='exclude'

Error Handling:
  - Returns "No releases in that window" with the nearest dates that do have releases, so you can retry.
  - Release dates are Swedish local dates; sell_start_time is when sales open, typically 10:00.`,
      inputSchema: z
        .object({
          from_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
            .optional()
            .describe("Start of the window, inclusive (default: today)"),
          to_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
            .optional()
            .describe("End of the window, inclusive (default: 14 days after from_date)"),
          limited_only: z
            .boolean()
            .default(true)
            .describe(
              "Only the temporary assortment -- the releases that actually disappear (default: true)",
            ),
          web_launches: z
            .enum(["include", "exclude", "only"])
            .default("include")
            .describe(
              "Web launches are allocation drops applied for online, not bottles to queue for in " +
                "a shop -- they are where the rarest wines appear. 'only' to see just those, " +
                "'exclude' for what can actually be bought in store (default: include).",
            ),
          category: z.string().optional().describe("Category, e.g. 'Vin' or 'Rött vin'"),
          country: z.string().optional().describe("Country, e.g. 'Frankrike'"),
          min_price: z.number().min(0).optional(),
          max_price: z.number().min(0).optional(),
          store_id: z.string().optional().describe("Only products a mirrored store carries"),
          ...pagingSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (params) =>
      guard(() => {
        const from = params.from_date ?? today();
        const to = params.to_date ?? addDays(from, 14);
        if (to < from) {
          throw new Error(`to_date (${to}) is before from_date (${from}).`);
        }

        // Availability is not a useful filter here: a product launching next
        // week is not on any shelf yet, so rank 3 must stay in scope.
        const { sql, params: binds } = commonFilters({ ...params, max_availability_rank: 3 });
        // launch_date is a full timestamp, so compare on the date prefix.
        sql.push("substr(p.launch_date,1,10) >= ?", "substr(p.launch_date,1,10) <= ?");
        binds.push(from, to);
        if (params.limited_only) sql.push("p.assortment_code LIKE 'TS%'");
        if (params.web_launches === "only") sql.push("p.is_web_launch = 1");
        if (params.web_launches === "exclude") sql.push("p.is_web_launch = 0");

        const where = sql.join(" AND ");
        const { total } = db.get<{ total: number }>(
          `SELECT count(*) AS total FROM product p WHERE ${where}`,
          ...binds,
        )!;

        if (!total) {
          const near = db.all<{ launch: string; n: number }>(
            `SELECT substr(launch_date,1,10) AS launch, count(*) AS n FROM product
             WHERE launch_date >= ? ${params.limited_only ? "AND assortment_code LIKE 'TS%'" : ""}
             GROUP BY launch ORDER BY launch LIMIT 5`,
            from,
          );
          const hint = near.length
            ? ` Next dates with releases: ${near.map((r) => `${r.launch} (${r.n})`).join(", ")}.`
            : " No future releases are announced in the mirror; it may need a resync.";
          return textResult(`No releases between ${from} and ${to}.${hint}`);
        }

        const rows = db.all<ReleaseRow>(
          `SELECT ${LIST_COLUMNS}, p.launch_date, p.sell_start_time, p.assortment_code,
                  p.is_web_launch
           FROM product p WHERE ${where}
           ORDER BY p.launch_date ASC, p.price DESC
           LIMIT ? OFFSET ?`,
          ...binds,
          params.limit,
          params.offset,
        );

        return toolResult(
          paginate(rows, total, params.offset),
          (page: Page<ReleaseRow>) => {
            const head = [
              `# Releases ${from} to ${to}`,
              `${page.total} products (showing ${page.count})`,
            ];
            let day = "";
            const body: string[] = [];
            for (const r of page.items) {
              const d = r.launch_date.slice(0, 10);
              if (d !== day) {
                day = d;
                const weekday = new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
                  weekday: "long",
                  timeZone: "UTC",
                });
                body.push(`### ${weekday} ${d}${r.sell_start_time ? `, from ${r.sell_start_time}` : ""}`);
              }
              const kind = r.is_web_launch
                ? "**web launch** — applied for online, not sold over the counter"
                : (r.assortment_code ?? "?");
              body.push(`${productMarkdown(r)}\n- *${kind}*`);
            }
            return head.concat(body).join("\n\n");
          },
          params.response_format,
        );
      }),
  );
}
