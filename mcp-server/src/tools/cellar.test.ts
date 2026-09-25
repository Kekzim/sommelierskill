import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Mirror } from "../db.js";
import { Cellar } from "../cellar.js";
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
  } finally {
    await client.close();
    cellar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
