import { STOCK_KEY_RETRY_MS, STOCK_TIMEOUT_MS } from "./constants.js";

const SITE = "https://www.systembolaget.se";

// <script src="/_next/static/chunks/131pjojsj1pi9.js" defer=""></script>
const CHUNK_PATH = /src="(\/_next\/static\/chunks\/[^"]+\.js)"/g;
const KEY = /NEXT_PUBLIC_API_KEY_APIM:"([^"]+)"/;

type Fetch = typeof fetch;

/**
 * The key the stock API wants is the public one Systembolaget's own frontend
 * ships in its JavaScript -- the same key the Go sync scrapes at the start of
 * every run (systembolaget-api's GetAPIKey, ported here). Discovering it means
 * live stock needs no configuration, and keeps working when Systembolaget
 * changes the key.
 *
 * Requiring it as an environment variable instead left live stock silently
 * disabled on the deployment that mattered: nothing told anyone to set it, and
 * a key copied in by hand would have gone stale without a word.
 *
 * SYSTEMBOLAGET_API_KEY still wins when set, and is then never re-discovered.
 */
export class StockKey {
  private key: string | null;
  private pending: Promise<string> | null = null;
  private failedAt = 0;
  private lastError = "";

  constructor(
    private readonly override: string | undefined,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.key = override || null;
  }

  /** Where the key comes from, for the startup log. */
  get source(): string {
    return this.override ? "SYSTEMBOLAGET_API_KEY" : "discovered from systembolaget.se on first use";
  }

  get canRefresh(): boolean {
    return !this.override;
  }

  /**
   * The current key, discovering it if needed. Concurrent callers share one
   * discovery. A failure is remembered briefly so a broken frontend is not
   * re-scraped on every call -- this is an undocumented API.
   */
  async get(): Promise<string> {
    if (this.key) return this.key;
    if (this.now() - this.failedAt < STOCK_KEY_RETRY_MS) {
      throw new Error(`key discovery failed recently (${this.lastError}); retrying shortly`);
    }
    this.pending ??= this.discover()
      .then((key) => {
        this.key = key;
        return key;
      })
      .catch((err: unknown) => {
        this.failedAt = this.now();
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Forget a discovered key the API has refused, so the next get() finds the new one. */
  invalidate(): void {
    if (this.canRefresh) this.key = null;
  }

  private async discover(): Promise<string> {
    const home = await this.fetchText(SITE);
    const chunks = [...home.matchAll(CHUNK_PATH)].map((m) => SITE + m[1]);
    if (chunks.length === 0) throw new Error("no script chunks on systembolaget.se");
    // Sequential on purpose: the key sits in one chunk of ~30, and fetching
    // them all at once would look nothing like a browser.
    for (const chunk of chunks) {
      const match = (await this.fetchText(chunk).catch(() => "")).match(KEY);
      if (match) return match[1];
    }
    throw new Error(`API key not found in any of ${chunks.length} script chunks`);
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(STOCK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.text();
  }
}
