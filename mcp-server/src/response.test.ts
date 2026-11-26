import { test } from "node:test";
import assert from "node:assert/strict";
import { CHARACTER_LIMIT } from "./constants.js";
import { Page, ResponseFormat, paginate, toolResult } from "./response.js";

/** Records big enough that a page of five is over the limit. */
const ALL = Array.from({ length: 23 }, (_, id) => ({ id, text: "x".repeat(CHARACTER_LIMIT / 4) }));

function page(offset: number, limit: number): Page<(typeof ALL)[number]> {
  const items = ALL.slice(offset, offset + limit);
  const r = toolResult(paginate(items, ALL.length, offset), (p) => JSON.stringify(p.items), ResponseFormat.JSON);
  return r.structuredContent as unknown as Page<(typeof ALL)[number]>;
}

test("following next_offset through truncated pages returns every record once", () => {
  for (const limit of [5, 10, 100]) {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const p: Page<(typeof ALL)[number]> = page(offset, limit);
      seen.push(...p.items.map((i) => i.id));
      assert.equal(p.has_more, p.next_offset !== undefined);
      offset = p.next_offset;
    }
    assert.deepEqual(seen, ALL.map((i) => i.id), `limit ${limit}`);
  }
});

test("a truncated last page says there is more, and where it starts", () => {
  const p = page(18, 5); // the last five records, too big to send together
  assert.equal(p.truncated, true);
  assert.equal(p.count, p.items.length);
  assert.equal(p.has_more, true);
  assert.equal(p.next_offset, 18 + p.count);
  assert.match(p.truncation_message ?? "", new RegExp(`offset=${p.next_offset}`));
});

test("a long page is halved until it fits, not only once", () => {
  const r = toolResult(paginate(ALL, ALL.length, 0), (p) => JSON.stringify(p.items), ResponseFormat.JSON);
  const p = r.structuredContent as unknown as Page<(typeof ALL)[number]>;
  assert.ok(r.content[0].text.length <= CHARACTER_LIMIT, `${r.content[0].text.length} characters`);
  assert.equal(p.next_offset, p.count);
  assert.match(p.truncation_message ?? "", new RegExp(`from ${ALL.length} to ${p.count} items`));
});

test("a single record over the limit is still sent whole", () => {
  const huge = [{ id: 1, text: "x".repeat(CHARACTER_LIMIT * 2) }, { id: 2, text: "short" }];
  const r = toolResult(paginate(huge, 2, 0), (p) => JSON.stringify(p.items), ResponseFormat.JSON);
  const p = r.structuredContent as unknown as Page<(typeof huge)[number]>;
  assert.deepEqual(p.items, [huge[0]]);
  assert.equal(p.next_offset, 1);
});
