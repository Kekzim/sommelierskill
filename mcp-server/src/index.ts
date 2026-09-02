import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Mirror } from "./db.js";
import { registerSearchTools } from "./tools/search.js";
import { registerProductTools } from "./tools/product.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerStoreTools } from "./tools/stores.js";
import { registerMetaTools } from "./tools/meta.js";

/**
 * Resolution mirrors the Go CLI's dbPath: an explicit path wins, otherwise the
 * user data dir. Never hardcode a path -- the mirror is not in the repo.
 */
const dbPath = process.env.BOLAGETDB_PATH ?? join(homedir(), ".local/share/bolagetdb/bolaget.db");
const port = Number(process.env.PORT ?? 8848);
const host = process.env.HOST ?? "127.0.0.1";
const authToken = process.env.MCP_AUTH_TOKEN;
const apiKey = process.env.SYSTEMBOLAGET_API_KEY;

const mirror = new Mirror(dbPath);

function buildServer(): McpServer {
  const server = new McpServer({ name: "systembolaget-mcp-server", version: "1.0.0" });
  registerSearchTools(server, mirror);
  registerProductTools(server, mirror);
  registerReleaseTools(server, mirror);
  registerStoreTools(server, mirror, apiKey);
  registerMetaTools(server, mirror);
  return server;
}

/**
 * Constant-time bearer check. The server is only reachable over the VPN, but a
 * private network is not an authorisation boundary -- any device on it would
 * otherwise get unrestricted query access.
 */
function authorise(req: Request, res: Response, next: NextFunction): void {
  if (!authToken) return next();
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(authToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <token>" },
      id: null,
    });
    return;
  }
  next();
}

/**
 * DNS rebinding protection: a browser on the same network could otherwise be
 * made to POST here from a hostile page. Only same-origin or explicitly allowed
 * origins are accepted; requests with no Origin (ordinary MCP clients) pass.
 */
function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (!origin) return next();
  const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
  if (allowed.includes(origin)) return next();
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Forbidden origin" },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  try {
    const row = mirror.get<{ n: number }>("SELECT count(*) AS n FROM product");
    res.json({ ok: true, products: row?.n ?? 0, db: dbPath });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message, db: dbPath });
  }
});

app.post("/mcp", checkOrigin, authorise, async (req, res) => {
  // A fresh transport and server per request: stateless JSON, so concurrent
  // requests cannot collide on request ids.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => void transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, host, () => {
  // stdout is free here (this is HTTP, not stdio), but stderr keeps the habit.
  console.error(`systembolaget-mcp-server on http://${host}:${port}/mcp`);
  console.error(`  database:   ${dbPath}`);
  console.error(`  auth:       ${authToken ? "bearer token required" : "DISABLED (set MCP_AUTH_TOKEN)"}`);
  console.error(`  live stock: ${apiKey ? "enabled" : "disabled (set SYSTEMBOLAGET_API_KEY)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    mirror.close();
    process.exit(0);
  });
}
