# Phase 02 — exposing the server to Anthropic, and nobody else

The MCP server is running on the LAN. This phase makes it reachable from
claude.ai, your phone and Claude Desktop — without opening a port on your router
and without it being reachable by anyone but Anthropic.

**Do not start this until Phase 01's gate holds**: `/health` answering from
another machine on the LAN, from a mirror a full sync actually published.

## The shape of it

A `cloudflared` container on Unraid dials *out* to Cloudflare and holds the
connection open. Cloudflare terminates TLS at its edge and forwards requests
down that tunnel to the MCP container. Nothing listens on your WAN, there is no
port forward, and a changing home IP does not matter.

Then a firewall rule at Cloudflare restricts the hostname to Anthropic's
published egress range, so the endpoint exists in DNS but only Anthropic can
open a connection to it. The bearer token stays on as a second layer.

You need a domain on Cloudflare. A subdomain of something you already own is
fine.

## 1. Create the tunnel

In the Cloudflare **Zero Trust** dashboard: **Networks → Tunnels → Create a
tunnel**, choose **Cloudflared**, and name it something like `sommelier`.

Cloudflare shows you an install command containing a long token. You only need
the token itself.

## 2. Run it on Unraid

Put the connector on the same Docker network as the MCP container so it can
reach it by name — no host IP, no hairpinning:

```bash
docker run -d --name sommelier-tunnel --restart unless-stopped \
  --network sommelier_egress \
  -e TUNNEL_TOKEN='PASTE_TOKEN_HERE' \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run
```

The token goes in an environment variable rather than on the command line, so it
does not sit in `ps` output for every process on the box to read.

Within a few seconds the tunnel should show **Healthy** in the dashboard.

## 3. Route a hostname to the server

Still in the tunnel's configuration: **Public Hostnames → Add a public
hostname**.

| Field | Value |
|---|---|
| Subdomain | `sommelier` (or whatever you like) |
| Domain | your domain |
| Type | `HTTP` |
| URL | `sommelier-mcp:8848` |

`HTTP` rather than `HTTPS` is correct — the hop from `cloudflared` to the
container is inside Docker on your own machine. TLS is terminated at
Cloudflare's edge, which is what Anthropic connects to.

## 4. Verify it works *before* locking it down

Order matters here. Once the firewall rule is in place you cannot test it
yourself, so prove the path works first:

```bash
curl -s -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -H 'Authorization: Bearer YOUR_TOKEN' \
     -X POST https://sommelier.yourdomain.com/mcp \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Nine tools should come back. A `502` usually means `cloudflared` cannot reach
`sommelier-mcp:8848` — check both containers are on `sommelier_egress`. A `401`
means the token does not match the one in `.env`.

## 5. Restrict it to Anthropic

Anthropic's outbound requests come from **`160.79.104.0/21`**, and that is the
only published outbound range — there is no published outbound IPv6. In the
Cloudflare dashboard for your domain: **Security → Security Rules → Custom
rules → Create rule**. (Older documentation, including Cloudflare's own, calls
this section **WAF**; it was renamed.)

| Field | Value |
|---|---|
| Name | `sommelier: Anthropic only` |
| Expression | `(http.host eq "sommelier.yourdomain.com" and not ip.src in {160.79.104.0/21})` |
| Action | `Block` |

Scope it to the hostname, as above. A zone-wide IP rule would lock every other
service on that domain out too.

Now re-run the `curl` from step 4. You should get a Cloudflare **403** — that is
the rule working, and it is the only confirmation you can get without being
Anthropic.

## 6. What not to do

**Do not put Cloudflare Access in front of this hostname.** It is the obvious
"secure it" button in Zero Trust, and it will break the connector: Access
answers unauthenticated requests with an interactive login page, and Claude has
no way to complete one. The WAF rule plus the bearer token is the right
combination here.

**Do not remove the LAN port binding.** Claude Code on your workstation talks to
`<unraid-lan-ip>:8848` directly and never touches the public path. Two routes to
one server, each restricted to whoever needs it.

## If the DNS record refuses to publish

This happened on the first deployment and cost an hour, so it is worth knowing.
The tunnel's public hostname was configured correctly, the CNAME to
`<tunnel-id>.cfargotunnel.com` existed and was proxied, and Cloudflare's own API
returned it — yet both of the zone's nameservers answered `NXDOMAIN` for the
hostname, for over an hour.

The record was in Cloudflare's control plane but was never pushed to the
nameservers that serve the zone. Nothing about the configuration was wrong.

**What unstuck it:** adding an unrelated throwaway record (an `A` record for
`test` pointing at `192.0.2.1`, DNS-only) forced a zone republish, and both the
new record and the stuck tunnel CNAME appeared within seconds. Delete the
throwaway afterwards.

Before reaching for that, confirm the record really is absent rather than
cached, by asking the zone's own nameservers:

```bash
dig sommelier.example.com @<your-zone-nameserver> +tries=1
```

An authoritative `NXDOMAIN` (the `aa` flag is set) means the zone genuinely is
not serving it. A proxied tunnel record, once published, resolves to Cloudflare
anycast addresses — `104.x` or `172.67.x` — never to your origin.

## "Couldn't reach the MCP server"

Claude reports **every** failure with this one message, whatever the actual
cause — a 401, a 404, a 502, a blocked request. It reads like a network problem
and usually is not. The first deployment lost two evenings to it.

**Get the evidence before theorising.** Run the connector with tunnel debug
logging on and read what actually arrived:

```bash
docker run -d --name sommelier-tunnel ... -e TUNNEL_LOGLEVEL=debug ...
docker logs --since 2m sommelier-tunnel | grep -E 'Cf-Connecting-Ip|200 OK|401|404|502'
```

Each proxied request is logged with its full headers and the status returned.
Anthropic's requests arrive from `160.79.x`, with `User-Agent: python-httpx` and
an `Mcp-Protocol-Version` header. Yours arrive from your own address. Comparing
the two lines is what finally solved it, and would have solved it on the first
evening.

Note that debug logging writes the `Authorization` header in plaintext. Turn it
off afterwards, and rotate the token if the logs have been shared.

The causes actually hit, in the order they bit:

1. **The bearer token sent without its `Bearer ` prefix.** Claude sends the
   header value exactly as typed and adds no scheme, so a value entered as the
   bare token arrives as `Authorization: <token>` and gets a 401. This was the
   real cause. The server now accepts both forms.
2. **QUIC blocked on the local network.** `cloudflared` defaults to UDP 7844 and
   fails with `control stream encountered a failure while serving`. It is
   supposed to fall back to HTTP/2 and did not. Set
   `TUNNEL_TRANSPORT_PROTOCOL=http2`.
3. **The hostname route silently not saved.** Creating it fails if a DNS record
   of that name already exists, and the tunnel is then left with no ingress —
   `No ingress rules were defined ... will return 503`. Delete the DNS record
   first and let the route create it.
4. **The tunnel ID used as the tunnel token.** The ID is a UUID and belongs in
   the CNAME target; the token is a long `eyJ...` string from the connector
   install screen. Wrong one gives `Provided Tunnel token is not valid`; a stale
   one gives `Unauthorized: Invalid tunnel secret`.
5. **The origin check rejecting any `Origin` header** and **`GET /mcp`
   answering 404 instead of 405** — both real server bugs, both fixed, neither
   the actual cause. `curl` sends no `Origin` and only POSTs, which is why they
   stayed invisible until a real client tried.

Cloudflare's **Security Events** shows whether a request was blocked
(`Mitigation: Not mitigated` means it passed). If Anthropic's requests appear
there as passed but never reach the tunnel logs, the problem is between
Cloudflare and the tunnel; if they reach the tunnel, the status in the log tells
you the rest.

## Gate for Phase 03

The public hostname returns nine tools when called with the bearer token, and
returns 403 to your own connection once the WAF rule is active.
