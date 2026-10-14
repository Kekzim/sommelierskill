import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Mirror } from "../db.js";
import { Cellar, parseRack } from "../cellar.js";
import { registerCellarTools } from "./cellar.js";

/** Drives the tools through a real MCP client, so the schemas are exercised as a client sends them. */
test("the cellar tools round-trip through MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellar-tools-"));
  const cellar = new Cellar(join(dir, "cellar.db"), new Mirror(join(dir, "no-mirror.db")));
  const server = new McpServer({ name: "test", version: "0" });
  registerCellarTools(server, cellar);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "systembolaget_cellar_add",
      "systembolaget_cellar_list",
      "systembolaget_cellar_remove",
      "systembolaget_cellar_update",
    ]);

    const text = (r: Awaited<ReturnType<typeof client.callTool>>) =>
      (r.content as { type: string; text: string }[])[0].text;

    const empty = await client.callTool({ name: "systembolaget_cellar_list", arguments: {} });
    assert.match(text(empty), /cellar is empty/);

    const added = await client.callTool({
      name: "systembolaget_cellar_add",
      arguments: { name: "Barolo Cannubi", vintage: 2019, quantity: 2, drink_from: 2027, drink_until: 2040 },
    });
    assert.equal(added.isError, undefined);
    const id = (added.structuredContent as { wine: { id: number } }).wine.id;

    const bad = await client.callTool({
      name: "systembolaget_cellar_add",
      arguments: { name: "Backwards", drink_from: 2030, drink_until: 2020 },
    });
    assert.equal(bad.isError, true);

    const removed = await client.callTool({
      name: "systembolaget_cellar_remove",
      arguments: { wine_id: id, rating: 4, note: "too young, still lovely" },
    });
    assert.match(text(removed), /1 left/);

    const one = await client.callTool({ name: "systembolaget_cellar_list", arguments: { wine_id: id } });
    assert.match(text(one), /Your rating\*\*: 4\/5/);
    assert.match(text(one), /: 1 drunk — 4\/5, "too young, still lovely"/);

    const champagne = await client.callTool({
      name: "systembolaget_cellar_add",
      arguments: { producer: "Egly-Ouriet", name: "Brut Tradition", vintage: null, sugar_g_l: 2, disgorged_on: "2024-03", quantity: 6 },
    });
    const cid = (champagne.structuredContent as { wine: { id: number } }).wine.id;
    const queue = await client.callTool({ name: "systembolaget_cellar_list", arguments: { needs_profile: true } });
    assert.match(text(queue), /Brut Tradition/);

    const unsourced = await client.callTool({
      name: "systembolaget_cellar_update",
      arguments: { wine_id: cid, claude_profile: "Vinous." },
    });
    assert.equal(unsourced.isError, true);

    await client.callTool({
      name: "systembolaget_cellar_update",
      arguments: { wine_id: cid, claude_profile: "Vinous.", claude_sources: "general knowledge, unverified" },
    });
    const shown = text(await client.callTool({ name: "systembolaget_cellar_list", arguments: { wine_id: cid } }));
    assert.match(shown, /\*\*Label\*\*: 2 g\/L sugar · disgorged 2024-03/);
    assert.match(shown, /\*\*Claude's profile\*\* \(\d{4}-\d{2}-\d{2}\): Vinous\./);
    assert.match(shown, /Sources\*: general knowledge, unverified/);

    await client.callTool({
      name: "systembolaget_cellar_update",
      arguments: { wine_id: cid, purchase_price: 23.5, purchase_currency: "eur" },
    });
    assert.match(text(await client.callTool({ name: "systembolaget_cellar_list", arguments: { wine_id: cid } })), /\*\*Paid\*\*: €23\.50/);
    const badCurrency = await client.callTool({
      name: "systembolaget_cellar_update",
      arguments: { wine_id: cid, purchase_currency: "euros" },
    });
    assert.equal(badCurrency.isError, true);
    const all = text(await client.callTool({ name: "systembolaget_cellar_list", arguments: {} }));
    assert.match(all, /€141 paid for what is recorded/, "6 × €23.50, totalled in euros");

    for (const date of ["2026-04", "2026", "2026-04-02"]) {
      const ok = await client.callTool({ name: "systembolaget_cellar_update", arguments: { wine_id: cid, purchased_on: date } });
      assert.equal(ok.isError, undefined, `${date} should be accepted`);
    }
    for (const date of ["2026-13", "04/2026", "2026-4"]) {
      const bad = await client.callTool({ name: "systembolaget_cellar_update", arguments: { wine_id: cid, purchased_on: date } });
      assert.equal(bad.isError, true, `${date} should be refused`);
    }
    assert.match(
      text(await client.callTool({ name: "systembolaget_cellar_update", arguments: { wine_id: cid, purchased_on: "2026-04" } })),
      /\*\*Paid\*\*: €23\.50 \(2026-04\)/,
    );
  } finally {
    await client.close();
    cellar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rack view and slot-freeing work through MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellar-rack-"));
  const cellar = new Cellar(join(dir, "cellar.db"), new Mirror(join(dir, "no-mirror.db")), parseRack("A-C:1-2"));
  const server = new McpServer({ name: "test", version: "0" });
  registerCellarTools(server, cellar);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0].text;
  try {
    const added = await client.callTool({
      name: "systembolaget_cellar_add",
      arguments: { producer: "Pertois", name: "Prestige", quantity: 2, location: "A1, B1" },
    });
    const id = (added.structuredContent as { wine: { id: number } }).wine.id;
    const clash = await client.callTool({ name: "systembolaget_cellar_add", arguments: { name: "Other", location: "A1" } });
    assert.equal(clash.isError, true);
    assert.match(text(clash), /A1 holds #1 Pertois Prestige NV/);

    const map = text(await client.callTool({ name: "systembolaget_cellar_list", arguments: { rack: true } }));
    assert.match(map, /# Rack A-C:1-2/);
    assert.match(map, /Letters are columns, left to right; numbers are rows, top to bottom/);
    assert.match(map, /\| \| A \| B \| C \|/, "columns across the top");
    assert.match(map, /2 of 6 slots taken, 4 free/);
    assert.match(map, /\| \*\*1\*\* \| #1 \| #1 \| · \|/);

    const ask = await client.callTool({ name: "systembolaget_cellar_remove", arguments: { wine_id: id } });
    assert.equal(ask.isError, true);
    assert.match(text(ask), /Say which slot/);
    const done = await client.callTool({ name: "systembolaget_cellar_remove", arguments: { wine_id: id, slots: ["a1"] } });
    assert.match(text(done), /1 left\. Freed A1\./);
    assert.match(text(done), /\*\*Where\*\*: B1/);
  } finally {
    await client.close();
    cellar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
