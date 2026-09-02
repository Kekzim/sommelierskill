# Which tool, and when

The `systembolaget_*` MCP tools document their own parameters. This file does
not repeat them — restating a tool's arguments is how documentation drifts out
of step with the thing it describes. What follows is the judgement the tool
descriptions cannot carry: which tool a request maps to, and what to do with
what comes back.

## Routing

| They say | Reach for |
|---|---|
| "a nice red for dinner", "something under 200" | `search_products` |
| "smoky but not oaky", "tastes of cherry and leather" | `search_tasting_notes` |
| "something like the X I had", "cheaper version of X" | `find_similar` — find X first, confirm it is the right X |
| "what's new", "anything coming up", "what drops Friday" | `upcoming_releases` |
| "does my shop have it", "is it in stock" | `list_stores` for the id, then `check_stock` |
| "tell me about this bottle" | `get_product` |
| counting, grouping, "how many", "which country has most" | `query` |
| "are these prices current?" | `data_freshness` |

Two of these are easy to get wrong. When someone names a bottle they enjoyed,
the instinct is to search for similar names — use `find_similar` instead, and
confirm the reference product first, because name search is unreliable in both
directions. And when the question is really an aggregation ("which grape shows
up most in cheap Rioja"), reach for `query` rather than paging `search_products`
and counting by hand.

## What the tools will not tell you

**A search returning nothing is a failure, not an answer.** The filters are
conjunctive and taste clocks are strict. Loosen the clocks first, then price,
then `max_availability_rank`. A near miss you can explain beats "nothing
matches".

**Pairings are assigned across every category.** `pairing: "Lamm"` sorted by
body returns a barrel-aged maple stout ahead of any wine — that is real data,
not a bug. Set `category` when they asked for wine.

**Small formats win on price, not on value.** Sorting by price surfaces 250 ml
cans and 375 ml halves. Use `sort: "value"` when comparing, and say the bottle
size when it is not 750 ml.

**The same wine appears once per vintage and per bottle size.** Group by name
and producer before presenting, or you will offer someone the same wine three
times.

**`limit` defaults low on purpose.** Ask for more only when you are aggregating
by hand; a recommendation needs three to five candidates, not fifty.

## Releases

`upcoming_releases` is the one tool with no equivalent anywhere else, including
Systembolaget's own site: the mirror carries products whose launch date is still
in the future, so "what drops on Friday at 10:00" is answerable before it
happens. This matters because limited releases are sold while stocks last and
are not restocked.

**Web launches are a different thing from a shop release.** They are allocation
drops applied for online — the rarest bottles arrive this way, and they read as
`order_only` because their assortment text is not a shelf tier. Never tell
someone to go to the shop on Friday for one. Use `web_launches: "exclude"` when
they mean "what can I actually walk in and buy", and `"only"` when they are
hunting something rare.

## Stock

`check_stock` is the only tool that leaves the mirror. Use it on a shortlist
you are about to name, never to explore, and never cache the answer. It returns
the shelf position, which is worth passing on — it turns "they have it" into
"it is on shelf 42".

A store that is not mirrored has no assortment data. That is not the same as
carrying nothing, and must never be reported as "your shop does not have it".

## If the tools are not there

The MCP server may not be configured, or may be unreachable off the VPN. Fall
back to `bolagetdb query` against the local mirror — `references/schema.md` has
the schema and the tested SQL. The method does not change; only the mechanics
do. If neither is available, say so plainly rather than recommending from
memory: the entire point of this skill is naming bottles that actually exist in
Sweden.
