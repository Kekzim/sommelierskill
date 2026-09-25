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
| "what should I open tonight", "what goes with this from what I have" | `cellar_list` with `drink_window: "ready"` |
| "anything I should drink soon?" | `cellar_list` with `drink_window: "drink_soon"` |
| "I bought…", "put this in my cellar" | find the product, then `cellar_add` with the label's vintage |
| "we opened the…", "had the X last night" | `cellar_remove`, with their rating if they give one |
| "fill in the Champagnes", "describe what I just added" | `cellar_list` with `needs_profile: true`, then `cellar_update` each |

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

Neither is a store's assortment current. It was recorded at the last sync, so a
bottle whose `launch_date` is later than that could not have been in it — the
sync ran before the bottle reached any shop. `data_freshness` gives the sync
date; compare it before saying a shop does not carry something. This bites
precisely where it matters most: the week's limited releases, which are the
whole reason for looking. For those, `check_stock` is the only tool that knows.

## The cellar

The four `cellar_*` tools exist only where the server has a cellar configured.
Not in your tool list means there is no cellar; say nothing about one.

**Open before you buy.** When the question is what to drink rather than what to
buy, start with `cellar_list` and `drink_window: "ready"`, and judge fit on the
copied taste clocks and notes exactly as you would a search result. Only when
nothing there fits, say so and turn to the assortment. For a purchase, a glance
at the cellar still pays: "you already have two bottles that would work" beats a
shopping list, and so does not suggesting a seventh of something they own six of.

**Volunteer what is running out of time.** A bottle past its window is a dinner
that did not happen. When the occasion fits, mention anything `drink_soon`
returns, most urgent first.

**Two kinds of note, never blurred.** Systembolaget's note on a cellar wine was
recorded for that exact vintage when the bottle was added. The user's notes and
ratings are theirs: quote them as theirs — "you gave it 5/5 with lamb in March"
— rather than folding them into your own description. Where both are missing,
the never-invent rule applies unchanged.

**Adding: find the product, then ask the vintage on the label.** Systembolaget
keeps a product's id when the next vintage arrives, so the vintage it lists
today may not be the one on their shelf. A wrong vintage copies the wrong
tasting note. Bottles bought elsewhere are added by name.

**Removing: ask how it was, once.** If they have not given a verdict, ask for a
rating and a line on the food or occasion — that is what turns later
suggestions into theirs. If they would rather not, record it without. A rating
is never yours to supply.

### Filling in a wine nobody describes

Grower Champagne, a bottle from a trip, anything Systembolaget never sold: these
arrive with the label's facts and nothing else. `needs_profile: true` is the
queue. Work through it after the user has finished adding, so their facts are in
before yours.

**The label is theirs; the profile is yours.** What the user typed from the
bottle — blend percentages, dosage, NV or vintage, base year, disgorgement — is
never overwritten. Fill a missing label fact only from a source that covers this
exact bottle. A non-vintage cuvée changes blend, base year and dosage with every
release, so the house's current technical sheet may describe a wine that is not
in the cellar. Match the release by base year or disgorgement date; if nothing
matches, the profile describes the cuvée in general, and should say so.

**Research, in this order.** The house's own technical sheet for the cuvée
(*fiche technique*) — it usually gives the blend, reserve wine, vinification,
time on lees and dosage. Then reputable reviews. Then what you know. Each part of
the profile carries its source in `claude_sources`; anything from memory is
marked "general knowledge, unverified". A drinking window you estimate goes in
`drink_from`/`drink_until` and is named as an estimate in the sources. For
Champagne, time since disgorgement matters as much as the vintage.

**Write it like the Tone section, not like a back label.** Three to five
sentences: the house and how the cuvée is made, how it tastes, what to eat with
it, how it will develop. Plain words.

**Dosage words map to sugar**, which is how to fill `style` from a g/L figure or
check one against the other (EU terms, g/L):

| Brut Nature | Extra Brut | Brut | Extra Dry | Sec | Demi-Sec | Doux |
|---|---|---|---|---|---|---|
| < 3 | 0–6 | < 12 | 12–17 | 17–32 | 32–50 | > 50 |

The ranges overlap, so 2 g/L can be labelled Brut Nature, Extra Brut or Brut.
Keep the word on the label.

**The cellar cannot be rebuilt.** Recording the bottle they just told you about
needs no ceremony. Anything that rewrites several entries at once — a recount, a
reorganised rack — confirm before doing it.

## If the tools are not there

The MCP server may not be configured, or may be unreachable off the VPN. Fall
back to `bolagetdb query` against the local mirror — `references/schema.md` has
the schema and the tested SQL. The method does not change; only the mechanics
do. If neither is available, say so plainly rather than recommending from
memory: the entire point of this skill is naming bottles that actually exist in
Sweden.
