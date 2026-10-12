import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Mirror } from "../db.js";
import { StockKey } from "../stockKey.js";
import { registerStoreTools } from "./stores.js";

/** Just enough mirror for check_stock to name the store and the products. */
function tinyMirror(): Mirror {
  const path = join(mkdtempSync(join(tmpdir(), "stock-")), "bolaget.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE store (site_id TEXT, name TEXT, city TEXT, county TEXT);
    CREATE TABLE product (product_id TEXT, full_name TEXT);
    CREATE TABLE store_product (site_id TEXT, product_id TEXT);
    INSERT INTO store VALUES ('1001', 'Testbutiken', 'Teststad', 'Testlän');
    INSERT INTO product VALUES ('7116', 'Moselland Riesling Kabinett'), ('20034', 'Beaujolais-Villages');
  `);
  db.close();
  return new Mirror(path);
}

/**
 * Systembolaget, faked: the frontend serves `site.key`, and the stock API
 * accepts only the key the frontend currently serves.
 */
function fakeSystembolaget(stock: Record<string, object>) {
  const site = { key: "k-1", stockCalls: [] as string[] };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://www.systembolaget.se") {
      return new Response('<script src="/_next/static/chunks/c.js" defer=""></script>');
    }
    if (url.endsWith("/c.js")) return new Response(`{NEXT_PUBLIC_API_KEY_APIM:"${site.key}"}`);
    const m = url.match(/stockbalance\/store\/([^/]+)\/([^/]+)\/$/);
    if (m) {
      const sent = new Headers(init?.headers).get("Ocp-Apim-Subscription-Key");
      site.stockCalls.push(`${m[2]}:${sent}`);
      if (sent !== site.key) return new Response('{"statusCode":401}', { status: 401 });
      const body = stock[m[2]];
      return body ? Response.json(body) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { site, fetchFn };
}

async function connect(key: StockKey, fetchFn: typeof fetch) {
  const server = new McpServer({ name: "test", version: "0" });
  registerStoreTools(server, tinyMirror(), key, fetchFn);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const check = async (product_ids: string[]) => {
    const r = await client.callTool({ name: "systembolaget_check_stock", arguments: { store_id: "1001", product_ids } });
    return {
      text: (r.content as { text: string }[])[0].text,
      results: (r.structuredContent as { results: Record<string, unknown>[] } | undefined)?.results,
    };
  };
  return { check, close: () => client.close() };
}

test("check_stock works with no configured key, reporting count, shelf and range", async () => {
  const { fetchFn } = fakeSystembolaget({
    "7116": { productId: "7116", storeId: "1001", shelf: "03-03-03", stock: 8, isInStoreAssortment: true },
    "20034": { productId: "20034", storeId: "1001", shelf: "07-07-03", stock: 10, isInStoreAssortment: false },
  });
  const { check, close } = await connect(new StockKey(undefined, fetchFn), fetchFn);
  try {
    const { text, results } = await check(["7116", "20034"]);
    assert.match(text, /# Stock at Testbutiken/);
    assert.match(text, /\*\*Moselland Riesling Kabinett\*\*: 8 in stock, shelf 03-03-03\n/);
    assert.match(text, /\*\*Beaujolais-Villages\*\*: 10 in stock, shelf 07-07-03 \(outside this shop's regular range\)/);
    assert.deepEqual(
      results?.map((r) => [r.product_id, r.stock, r.in_store_assortment]),
      [
        ["7116", 8, true],
        ["20034", 10, false],
      ],
    );
  } finally {
    await close();
  }
});

test("a refused key is rediscovered and the check retried once", async () => {
  const { site, fetchFn } = fakeSystembolaget({ "7116": { stock: 3, shelf: "01" } });
  const key = new StockKey(undefined, fetchFn);
  const { check, close } = await connect(key, fetchFn);
  try {
    assert.match((await check(["7116"])).text, /3 in stock/);

    site.key = "k-2"; // Systembolaget rotates the key between two questions
    const { text } = await check(["7116"]);
    assert.match(text, /3 in stock/);
    assert.deepEqual(site.stockCalls, ["7116:k-1", "7116:k-1", "7116:k-2"]);
  } finally {
    await close();
  }
});

test("a product the store has no entry for is none on the shelf, not an error", async () => {
  const { fetchFn } = fakeSystembolaget({});
  const { check, close } = await connect(new StockKey(undefined, fetchFn), fetchFn);
  try {
    assert.match((await check(["7116"])).text, /Moselland Riesling Kabinett\*\*: none on the shelf/);
  } finally {
    await close();
  }
});

test("when no key can be found, the tool says so instead of failing", async () => {
  const fetchFn = (async () => new Response("", { status: 503 })) as typeof fetch;
  const { check, close } = await connect(new StockKey(undefined, fetchFn), fetchFn);
  try {
    const { text } = await check(["7116"]);
    assert.match(text, /Live stock is unavailable right now: could not obtain Systembolaget's API key/);
    assert.match(text, /returned 503/);
  } finally {
    await close();
  }
});
