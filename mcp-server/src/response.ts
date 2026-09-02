import { CHARACTER_LIMIT } from "./constants.js";

export const ResponseFormat = {
  MARKDOWN: "markdown",
  JSON: "json",
} as const;
export type ResponseFormatValue = (typeof ResponseFormat)[keyof typeof ResponseFormat];

/** What every listing tool returns, per the pagination contract. */
export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
  truncated?: boolean;
  truncation_message?: string;
}

export function paginate<T>(items: T[], total: number, offset: number): Page<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
  };
}

/** An MCP tool result carrying both a text rendering and structured data. */
export interface ToolResult {
  // The SDK's result type carries an open index signature; without it these
  // results are not assignable to a registerTool handler's return type.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a result, enforcing the character limit. Oversized responses are halved
 * rather than cut mid-record, so what survives is still valid data, and the
 * caller is told how to get the rest.
 */
export function toolResult<T>(
  page: Page<T>,
  markdown: (page: Page<T>) => string,
  format: ResponseFormatValue,
): ToolResult {
  let output: Page<T> = page;
  let text = format === ResponseFormat.JSON ? JSON.stringify(output, null, 2) : markdown(output);

  if (text.length > CHARACTER_LIMIT && output.items.length > 1) {
    const keep = Math.max(1, Math.floor(output.items.length / 2));
    output = {
      ...output,
      items: output.items.slice(0, keep),
      count: keep,
      truncated: true,
      truncation_message:
        `Response truncated from ${page.items.length} to ${keep} items. ` +
        `Use 'offset' to page through the rest, or narrow the query with more filters.`,
    };
    text = format === ResponseFormat.JSON ? JSON.stringify(output, null, 2) : markdown(output);
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: output as unknown as Record<string, unknown>,
  };
}

/** A plain text result with no structured payload. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Errors are reported inside the result, not thrown as protocol errors, so the
 * model can read them and adjust. Messages say what to do next.
 */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so an unexpected throw becomes a readable tool error. */
export async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Money and volumes read better fixed; SQLite hands them back as floats. */
export function kr(v: unknown): string {
  return typeof v === "number" ? `${v.toFixed(v % 1 === 0 ? 0 : 2)} kr` : "price unknown";
}
