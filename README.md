# Dibs 🔷

**Call dibs on Burlington, one block at a time.** Burlington (+ Winooski and the
edges) is cut into 920 hexagonal blocks, each about 200 m across and named after
what's there — *Church Street*, *North & N. Winooski*, *Leddy Park*, *Pine St &
Howard St*. Stand in one, open Dibs, tap. It's yours until someone takes it back.

**Play:** https://play.btownbrief.com/dibs/ · **Try it at your desk:** add `?demo=1`
(seeded board, tap the map to "stand" somewhere, nothing saved).

A [Btown Brief](https://www.btownbrief.com) game.

## The game

| | |
|---|---|
| Take a fresh/cold block | **+6** ("first tracks") |
| Take someone's block | **+3** |
| Hold a block | **1 pt/hour** (landmarks ★ pay **3**), capped at **30 pts/hour** total so nobody wins by hoarding |
| Today's bounty block (★ pulsing) | **+10** once per player per day |
| Lock after a take | **15 min** — no ping-pong |
| Untouched for 7 days | block goes **cold** (neutral); re-tap to warm |
| Points | reset monthly (America/New_York); blocks carry over |
| Guard rails | 20 s between claims · 12 m/s teleport guard · 200/day · fixes worse than 150 m refused |

**Crews** are neighbourhoods: Downtown, Old North End, New North End, South End,
The Hill, Winooski, Flatlanders. The map colours by the holder's crew, so the
board reads as territory even with a dozen players. Standings show players
(points), crews (blocks held + % of home turf), and a recent-takes feed.

## Privacy shape (load-bearing)

- The phone turns the GPS fix into a hex id with `js/hex.js`. **Only the id is
  sent.** The server never receives lat/lng and has no column for it.
- Identity is a 32-hex device token in localStorage, stored server-side as a
  sha256 hash. No accounts, no email. New browser = new player.
- Your name + crew show on the blocks you hold and in the public recent-takes
  feed (timestamps rounded to 15 min). That's the game, and the welcome screen
  says so — so it is, honestly, a public record of *which blocks a named player
  tapped and roughly when*, at 200 m resolution. The server keeps a hold/bonus
  ledger per (hashed) player for scoring; nothing finer than a block, nothing
  tied to an email or phone. Play under a name you're happy to see on a map.
- Names are unique and can only be changed via the Me sheet (`dibs_profile`) or
  the back room — a claim never renames, so a moderator rename sticks.

## Repo

```
index.html  mod.html  css/style.css  manifest.webmanifest  sw.js  icon.svg
js/hex.js           pure hex grid math (flat-top axial, R=115 m, origin downtown)
js/core.js          pure rules: RULES, CREWS, decideClaim, scoring, bounty, names
js/fake-backend.js  in-memory twin of the SQL (demo + tests)
js/net.js           fetch → Supabase RPC, device token, plain-language errors
js/map.js           Leaflet + OpenStreetMap tiles (dark = CSS filter) + canvas hex polygons
js/app.js           the app
data/hexes.json     the board (generated)   data/landmarks.json  curated ★ points
supabase/dibs-SETUP.sql   paste once: tables (RLS-locked) + RPCs
supabase/dibs-HEXES.sql   paste after: seeds the board (generated)
scripts/build-hexes.mjs   OpenStreetMap → hexes.json + HEXES.sql
scripts/test-core.mjs     node --test    scripts/test-sql.sh  local-Postgres suite
scripts/playtest.mjs      Playwright flow + screenshots    scripts/newsletter-block.mjs
```

No build step. Leaflet 1.9.4 vendored (BSD-2). Tiles from OpenStreetMap
(attribution required, never cached by the SW; CARTO's free basemaps started
stamping "API KEY REQUIRED" in 2026, so they are out).

## Ship checklist

1. Supabase SQL editor (shared Btown project): paste `supabase/dibs-SETUP.sql`,
   then `supabase/dibs-HEXES.sql`. (Or `supabase db query --linked -f …`.)
2. GitHub Pages from `main` / root → `play.btownbrief.com/dibs/`.
3. List it: `btownbrief.github.io/games.json` + a hub card.
4. Moderator secret lives in `~/.config/btownbrief/secrets.env` as
   `DIBS_MOD_SECRET`; the bcrypt hash is baked into `dibs_mod_hash()`.
   `mod.html` (unlinked) benches/renames players and clears blocks.

## Verify

```
node --test scripts/test-core.mjs
node scripts/check-board.mjs
scripts/test-sql.sh                                   # needs local Postgres 17
NODE_PATH=<playwright dir> node scripts/playtest.mjs  # 31 checks + screenshots
```

## Regenerating the board

`node scripts/build-hexes.mjs` re-fetches roads/parks/boundaries from Overpass
(cached in `.cache/`). Hex ids are pure geometry so existing holds survive a
rebuild; only names/hoods/landmark flags change. Re-paste `dibs-HEXES.sql` after.
