import { z } from "zod";
import { kr } from "./response.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./constants.js";

/**
 * Columns returned by listing tools. Deliberately narrower than the table: a
 * recommendation needs identity, price, availability and enough taste to judge
 * fit. Everything else is one systembolaget_get_product call away.
 */
export const LIST_COLUMNS = `
  p.product_id, p.full_name, p.producer, p.country, p.cat1, p.cat2, p.cat3,
  p.vintage, p.price, p.volume_ml, p.abv, p.availability, p.availability_rank,
  p.clock_body, p.clock_tannin, p.clock_sweetness, p.clock_fruitacid, p.taste`;

export interface ProductRow {
  product_id: string;
  full_name: string;
  producer: string | null;
  country: string | null;
  cat1: string | null;
  cat2: string | null;
  cat3: string | null;
  vintage: number | null;
  price: number | null;
  volume_ml: number | null;
  abv: number | null;
  availability: string | null;
  availability_rank: number | null;
  clock_body: number | null;
  clock_tannin: number | null;
  clock_sweetness: number | null;
  clock_fruitacid: number | null;
  taste: string | null;
  [k: string]: unknown;
}

/** One product as a markdown block. */
export function productMarkdown(p: ProductRow): string {
  const lines: string[] = [];
  const vintage = p.vintage ? ` ${p.vintage}` : "";
  lines.push(`## ${p.full_name}${vintage}`);
  const bits: string[] = [];
  if (p.producer) bits.push(p.producer);
  if (p.country) bits.push(p.country);
  if (bits.length) lines.push(`*${bits.join(" · ")}*`);
  const size = p.volume_ml ? `, ${p.volume_ml} ml` : "";
  const abv = p.abv ? `, ${p.abv}%` : "";
  lines.push(`- **${kr(p.price)}**${size}${abv}`);
  // Availability is never omitted: "in the catalogue" is not "on a shelf", and
  // a recommendation that ignores that is worse than none.
  lines.push(`- **Availability**: ${p.availability ?? "unknown"}`);
  if (p.cat2) lines.push(`- ${[p.cat1, p.cat2, p.cat3].filter(Boolean).join(" / ")}`);
  if (p.taste) lines.push(`- ${p.taste}`);
  lines.push(`- \`${p.product_id}\``);
  return lines.join("\n");
}

/** Shared paging and formatting parameters. */
export const pagingSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum results to return, 1-${MAX_LIMIT} (default: ${DEFAULT_LIMIT})`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip, for pagination (default: 0)"),
  response_format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("Output format: 'markdown' for reading, 'json' for processing (default: markdown)"),
};

/**
 * Availability filter shared by every listing tool.
 *
 * Defaults to rank 1 -- products actually on a shelf. ~72% of wine is
 * order-only, so an unfiltered search mostly returns things the customer cannot
 * walk in and buy.
 */
export const availabilitySchema = {
  max_availability_rank: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(1)
    .describe(
      "How buyable the results must be: 1 = on shelves now, 2 = also 'while stocks last', " +
        "3 = also order-only (days of waiting). Default 1. Raise it only when the user wants " +
        "something rare -- ~72% of wine is order-only.",
    ),
};

/** WHERE fragments and bindings shared by the search-style tools. */
export function commonFilters(f: {
  category?: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  max_availability_rank: number;
  store_id?: string;
}): { sql: string[]; params: unknown[] } {
  const sql: string[] = ["p.availability_rank <= ?", "p.is_discontinued = 0"];
  const params: unknown[] = [f.max_availability_rank];

  if (f.category) {
    // cat3 is NULL for ~62% of wine, so it is matched only as a bonus, never
    // as a requirement -- filtering on it drops most of a category silently.
    sql.push("(p.cat1 = ? OR p.cat2 = ?)");
    params.push(f.category, f.category);
  }
  if (f.country) {
    sql.push("p.country = ?");
    params.push(f.country);
  }
  if (f.min_price !== undefined) {
    sql.push("p.price >= ?");
    params.push(f.min_price);
  }
  if (f.max_price !== undefined) {
    sql.push("p.price <= ?");
    params.push(f.max_price);
  }
  if (f.store_id) {
    sql.push(
      "EXISTS (SELECT 1 FROM store_product sp WHERE sp.product_id = p.product_id AND sp.site_id = ?)",
    );
    params.push(f.store_id);
  }
  return { sql, params };
}
