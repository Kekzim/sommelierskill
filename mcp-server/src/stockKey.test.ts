import { test } from "node:test";
import assert from "node:assert/strict";
import { StockKey } from "./stockKey.js";
import { STOCK_KEY_RETRY_MS } from "./constants.js";

/**
 * A stand-in for systembolaget.se: a homepage listing script chunks, with the
 * key in one of them. `key` can be changed between calls to simulate rotation.
 */
function fakeSite(opts: { key?: string; homeStatus?: number } = {}) {
  const site = { key: opts.key ?? "k-1", homeStatus: opts.homeStatus ?? 200, requests: [] as string[] };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    site.requests.push(url);
    if (url === "https://www.systembolaget.se") {
      return new Response(
        '<script src="/_next/static/chunks/a.js" defer=""></script>' +
          '<script src="/_next/static/chunks/b.js" defer=""></script>',
        { status: site.homeStatus },
      );
    }
    if (url.endsWith("/a.js")) return new Response('var x={NEXT_PUBLIC_OTHER:"nope"};');
    if (url.endsWith("/b.js")) return new Response(`var e={NEXT_PUBLIC_API_KEY_APIM:"${site.key}",z:1};`);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { site, fetchFn };
}

test("the key is found in whichever script chunk carries it, then cached", async () => {
  const { site, fetchFn } = fakeSite();
  const key = new StockKey(undefined, fetchFn);

  assert.equal(await key.get(), "k-1");
  assert.equal(site.requests.length, 3, "homepage plus both chunks");

  assert.equal(await key.get(), "k-1");
  assert.equal(site.requests.length, 3, "a cached key costs no requests");
});

test("concurrent callers share one discovery", async () => {
  const { site, fetchFn } = fakeSite();
  const key = new StockKey(undefined, fetchFn);

  const keys = await Promise.all([key.get(), key.get(), key.get()]);
  assert.deepEqual(keys, ["k-1", "k-1", "k-1"]);
  assert.equal(site.requests.length, 3);
});

test("invalidate finds the new key after Systembolaget rotates it", async () => {
  const { site, fetchFn } = fakeSite();
  const key = new StockKey(undefined, fetchFn);

  assert.equal(await key.get(), "k-1");
  site.key = "k-2";
  key.invalidate();
  assert.equal(await key.get(), "k-2");
});

test("an explicit key is used as given and never re-discovered", async () => {
  const { site, fetchFn } = fakeSite();
  const key = new StockKey("from-env", fetchFn);

  assert.equal(await key.get(), "from-env");
  key.invalidate();
  assert.equal(await key.get(), "from-env");
  assert.equal(key.canRefresh, false);
  assert.equal(site.requests.length, 0);
});

test("a failed discovery is not retried on every call", async () => {
  const { site, fetchFn } = fakeSite({ homeStatus: 503 });
  let now = 1_000_000;
  const key = new StockKey(undefined, fetchFn, () => now);

  await assert.rejects(key.get(), /returned 503/);
  await assert.rejects(key.get(), /failed recently/);
  assert.equal(site.requests.length, 1, "the second call must not touch the site");

  site.homeStatus = 200;
  now += STOCK_KEY_RETRY_MS;
  assert.equal(await key.get(), "k-1");
});

test("a page with no key says so", async () => {
  const fetchFn = (async () => new Response("<html>no scripts here</html>")) as typeof fetch;
  await assert.rejects(new StockKey(undefined, fetchFn).get(), /no script chunks/);
});
