# Translating what people say into filters

Nobody describes wine in taste-clock integers. This maps ordinary language onto
the columns. Treat these as starting points to be loosened if a query returns
too little — an empty result is a worse answer than an approximate one.

## Body and weight

| They say | Filter |
|---|---|
| light, easy-drinking, everyday | `clock_body <= 6` |
| medium, versatile, goes with anything | `clock_body BETWEEN 6 AND 8` |
| full-bodied, big, powerful, rich | `clock_body >= 9` |

## Tannin — red wine grip (Systembolaget's *strävhet*)

| They say | Filter |
|---|---|
| smooth, soft, easy, "not too harsh" | `clock_tannin <= 4` |
| some structure | `clock_tannin BETWEEN 5 AND 7` |
| structured, grippy, firm, ageworthy | `clock_tannin >= 8` |

"Dry" almost always means *not sweet*, not *tannic* — but people sometimes use
it for grip. If the request is about red wine and ambiguous, ask.

## Sweetness

| They say | Filter |
|---|---|
| dry | `clock_sweetness <= 2` |
| off-dry, "a touch of sweetness" | `clock_sweetness BETWEEN 3 AND 6` |
| sweet, dessert wine | `clock_sweetness >= 7` |

## Acidity and freshness

| They say | Filter |
|---|---|
| fresh, crisp, zippy, mineral | `clock_fruitacid >= 8` |
| soft, round, low acid | `clock_fruitacid <= 5` |

## Other scales

| They say | Filter |
|---|---|
| smoky, peaty (whisky) | `clock_smokiness >= 7` |
| bitter, hoppy (beer) | `clock_bitter >= 8` |
| oaky, vanilla, toasty | FTS `taste:(ek OR vanilj OR rostad)` |
| unoaked, clean, pure | FTS `NOT taste:ek` |

## Flavour words → Swedish

The `taste` text is Swedish. Search it with FTS (diacritics are folded, so
ASCII works).

berry `bär` · cherry `körsbär` · raspberry `hallon` · blackcurrant `svarta vinbär` ·
plum `plommon` · dried fruit `torkad frukt` · citrus `citrus` · apple `äpple` ·
peach `persika` · tropical `tropisk` · leather `läder` · tobacco `tobak` ·
chocolate `choklad` · coffee `kaffe` · vanilla `vanilj` · oak `ek` ·
spice `kryddig` · pepper `peppar` · liquorice `lakrits` · mineral `mineralisk` ·
buttery `smörig` · toasted `rostad` · herbal `örter` · earthy `jordig`

## "Something like X"

The strongest signal a user can give. Two cases:

**A style or region** — translate to grape and origin:

| They say | Approach |
|---|---|
| Burgundy / Bourgogne | grape `Pinot noir`, `country='Frankrike'` |
| Bordeaux-ish | grapes `Cabernet sauvignon` + `Merlot` |
| Rioja | grape `Tempranillo`, `country='Spanien'` |
| Barolo on a budget | grape `Nebbiolo`, `country='Italien'`, lower price |
| Chablis-ish | grape `Chardonnay`, unoaked (`NOT taste:ek`) |
| New World Shiraz | grape `Syrah`, Australia/South Africa |

Grapes are canonical, so `Syrah` also finds `Shiraz`, and `Grenache` also finds
`Garnacha` and `Cannonau`.

**A specific bottle** — find it, then match its taste profile. This works well
and is worth reaching for. See the "find something similar" recipe in
`schema.md`; given a Barolo it returns Langhe Nebbiolo and Barbaresco, which is
what a sommelier would say.

## Food

Use `product_pairing` rather than guessing. Available pairings:

`Nöt` beef · `Lamm` lamb · `Fläsk` pork · `Fågel` poultry · `Vilt` game ·
`Fisk` fish · `Skaldjur` shellfish · `Ost` cheese · `Grönsaker` vegetables ·
`Buffémat` buffet · `Kryddstarkt` spicy · `Asiatiskt` asian · `Grillat` grilled ·
`Pizza` · `Pasta` · `Hamburgare` · `Snacks` · `Dessert` · `Aperitif` ·
`Avec/digestif` · `Sällskapsdryck` drinking on its own · `Drinkingrediens`

Note `Grillat`, `Pizza`, `Pasta` and `Hamburgare` are tagged on very few
products — prefer the broader categories and use the taste clocks to refine.

## Budget bands (SEK, 750 ml)

| Band | Reads as |
|---|---|
| under 100 | everyday drinking |
| 100–200 | the sweet spot; most good value lives here |
| 200–400 | something for a occasion |
| 400+ | a splurge |

Compare value with `sek_per_litre`, since volumes run from 60 ml to 30 litres.
A 3-litre box at 199 kr is not more expensive than a 750 ml bottle at 129 kr.

## Dietary and ethical

`is_vegan`, `is_natural`, `is_organic`, `is_gluten_free`, `is_kosher` are all
0/1 columns. Vegan matters more than people expect — many wines are fined with
egg or isinglass — so honour it when asked rather than treating it as a
preference.
