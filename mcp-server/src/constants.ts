/** Maximum characters in a single tool response, before truncation kicks in. */
export const CHARACTER_LIMIT = 25000;

/** Default and maximum page sizes for listing tools. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Live shelf stock. Product facts are mirrored; stock is not -- it changes
 * hourly and is read at the moment of recommending. See CLAUDE.md.
 */
export const STOCK_API =
  "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/stockbalance/store";

/** Never check stock for more than a shortlist; this is an undocumented API. */
export const MAX_STOCK_CHECKS = 10;

/** How long a stock request may take before we give up on it. */
export const STOCK_TIMEOUT_MS = 8000;

/**
 * Ceiling on rows a raw SQL query may return. The escape-hatch tool appends
 * this when the query has no LIMIT of its own, so a stray `SELECT * FROM
 * product` cannot return 27k rows.
 */
export const SQL_ROW_CAP = 500;

/** Wall-clock ceiling for any single SQL statement. */
export const SQL_TIMEOUT_MS = 5000;
