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
only published outbound range. In the Cloudflare dashboard for your domain:
**Security → WAF → Custom rules → Create rule**.

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
`192.168.10.109:8848` directly and never touches the public path. Two routes to
one server, each restricted to whoever needs it.

## If the connector cannot reach the server

Phase 03 registers the connector; if it fails with "couldn't reach the MCP
server", work backwards:

1. Disable the WAF rule and try the connector again. If it now works, the rule
   is the problem — check the hostname in the expression matches exactly.
2. The published range is IPv4 only. If your hostname also answers on IPv6 and
   a request arrives over it, `ip.src` will not be in the `/21` and the rule
   will block it. The symptom is intermittent or total failure with the rule on
   and success with it off.
3. Check the tunnel is still **Healthy** and `docker logs sommelier-tunnel` for
   connection errors.

## Gate for Phase 03

The public hostname returns nine tools when called with the bearer token, and
returns 403 to your own connection once the WAF rule is active.
