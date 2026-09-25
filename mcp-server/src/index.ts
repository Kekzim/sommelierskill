import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Mirror } from "./db.js";
import { Cellar } from "./cellar.js";
import { registerSearchTools } from "./tools/search.js";
import { registerProductTools } from "./tools/product.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerStoreTools } from "./tools/stores.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerCellarTools } from "./tools/cellar.js";

/**
 * Resolution mirrors the Go CLI's dbPath: an explicit path wins, otherwise the
 * user data dir. Never hardcode a path -- the mirror is not in the repo.
 */
const dbPath = process.env.BOLAGETDB_PATH ?? join(homedir(), ".local/share/bolagetdb/bolaget.db");
const port = Number(process.env.PORT ?? 8848);
const host = process.env.HOST ?? "127.0.0.1";
const authToken = process.env.MCP_AUTH_TOKEN;
const apiKey = process.env.SYSTEMBOLAGET_API_KEY;
// Optional. Unset means no cellar tools at all -- the server stays read-only.
const cellarPath = process.env.CELLAR_DB_PATH || undefined;

const mirror = new Mirror(dbPath);
const cellar = cellarPath ? new Cellar(cellarPath, mirror) : null;

function buildServer(): McpServer {
  const server = new McpServer({ name: "systembolaget-mcp-server", version: "1.0.0" });
  registerSearchTools(server, mirror);
  registerProductTools(server, mirror);
  registerReleaseTools(server, mirror);
  registerStoreTools(server, mirror, apiKey);
  registerMetaTools(server, mirror);
  if (cellar) registerCellarTools(server, cellar);
  return server;
}

/**
 * Constant-time bearer check. The server is only reachable over the VPN, but a
 * private network is not an authorisation boundary -- any device on it would
 * otherwise get unrestricted query access.
 */
function authorise(req: Request, res: Response, next: NextFunction): void {
  if (!authToken) return next();
  // Accept the token with or without the "Bearer " scheme. Claude's connector
  // sends the header value exactly as an administrator typed it and adds no
  // scheme, so a value entered as the bare token arrives without the prefix --
  // and the resulting 401 surfaces to the user as "couldn't reach the server",
  // which sends you hunting through DNS, firewalls and tunnels for two days.
  // Being strict here buys nothing: the token still has to match.
  const header = (req.header("authorization") ?? "").trim();
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(authToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: send the token in an Authorization header, with or without a 'Bearer ' prefix." },
      id: null,
    });
    return;
  }
  next();
}

/**
 * DNS rebinding protection, opt-in via ALLOWED_ORIGINS.
 *
 * It must be opt-in, not opt-out. Enforcing an empty allowlist rejects every
 * request that carries an Origin header at all -- which is what Claude's
 * connector sends, so the server answered 403 and the client reported it as
 * "couldn't reach the server". Ordinary curl sends no Origin, so the fault only
 * appeared against a real client.
 *
 * The threat this guards against is a browser on the same machine being made to
 * POST to a loopback-bound server from a hostile page. That is worth defending
 * when the server listens on localhost; it is not the deployment behind a
 * tunnel, an IP allowlist and a bearer token. Set ALLOWED_ORIGINS when the
 * former applies.
 */
function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
  if (!allowed.length) return next();
  const origin = req.header("origin");
  if (!origin || allowed.includes(origin)) return next();
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: `Forbidden origin: ${origin}` },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  const body: Record<string, unknown> = { ok: true, db: dbPath };
  try {
    const row = mirror.get<{ n: number }>("SELECT count(*) AS n FROM product");
    body.products = row?.n ?? 0;
  } catch (err) {
    body.ok = false;
    body.error = (err as Error).message;
  }
  // A cellar that cannot be written fails health too: unlike the mirror it
  // cannot be rebuilt, so a broken one should be loud rather than discovered
  // when a bottle fails to save.
  if (cellar) {
    try {
      body.cellar = { path: cellar.path, ...cellar.summary() };
    } catch (err) {
      body.ok = false;
      body.cellar = { path: cellar.path, error: (err as Error).message };
    }
  }
  res.status(body.ok ? 200 : 503).json(body);
});

/**
 * Streamable HTTP defines GET (open the server-initiated stream) and DELETE
 * (end a session) alongside POST. This server is stateless and offers neither,
 * and the correct answer for an unsupported verb on a real endpoint is 405 --
 * not 404, which says the endpoint does not exist at all and reads to a client
 * as "there is no server here".
 */
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This server is stateless: use POST for all MCP requests.",
    },
    id: null,
  });
}

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

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
  console.error(`  cellar:     ${cellarPath ?? "disabled (set CELLAR_DB_PATH)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cellar?.close();
    mirror.close();
    process.exit(0);
  });
}
