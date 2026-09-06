# Dibs — agent notes

Read `README.md` first. Stephen is non-technical — explain consequential changes
in plain language. Plain static site, no build step, ES modules.

## Rules that will trip you up

- **`js/hex.js` is the board.** Hex ids are pure geometry (origin 44.48,-73.21,
  R=115 m, flat-top axial). Change R or the origin and every hold in the database
  points at a different patch of ground. Don't. `scripts/build-hexes.mjs` imports
  the same module so the generated board can't drift from the client.
- **`js/core.js` is pure and that purity is the contract.** No DOM, no fetch, no
  `Date.now()` — time is an argument. `RULES` is mirrored in
  `supabase/dibs-SETUP.sql` (literals inside `dibs_claim`) and enforced by
  `js/fake-backend.js` via `decideClaim`. **Change all three together** and add a
  case to `scripts/test-core.mjs` + `scripts/test-sql.sh`.
- **Bounty must agree everywhere.** `bountyId()` sorts landmark ids with JS
  default sort; the SQL uses `order by id collate "C"`. Keep byte order on both
  sides. `test-sql.sh` asserts they match for today.
- **Privacy shape is load-bearing.** The claim RPC takes a hex id and an accuracy
  number — never add lat/lng parameters or columns. Public payloads carry holder
  *names*, never token hashes. `dibs_me` is the only token-gated projection.
- **The device token is the only identity.** Names are unique (case-insensitive)
  so the board is legible; a lost device = a lost name unless the back room
  renames. Don't add accounts.
- **Fail soft, never error-state.** No SQL yet → `not_ready` → "isn't switched on
  yet"; the map still draws from `data/hexes.json`. `?demo=1` runs everything
  against `FakeBackend` (seeded, saves nothing, tap the map to move).
- **Map tiles are never cached** (OSM tile policy) — `sw.js` lets cross-origin
  requests straight through. Keep the OpenStreetMap attribution. CARTO's free
  basemaps now watermark "API KEY REQUIRED"; do not switch back without a key.
- **Canvas polygons can't be unit-tested for taps.** The playtest drives the
  hex sheet through the standings feed; tapping a hex on the real map is a
  field-test item. `?at=church|battery|leddy|uvm|…` or `?at=lat,lng` fakes a
  position for desk testing (with `?test=1` or `?demo=1`).
- **Honest threat model.** The anon key is public; GPS can be spoofed from
  devtools. Cooldown, teleport guard, daily cap, unique names, a public feed and
  `mod.html` make mischief socially expensive, not impossible. No prizes you'd
  regret.
- **Design doctrine: one thing on screen.** The dock is the game. New facets go
  on the hex sheet or in standings, not as new controls on the map.

## Before you finish

```
node --test scripts/test-core.mjs
node scripts/check-board.mjs
for f in js/*.js sw.js; do node --check "$f"; done
scripts/test-sql.sh                                   # local Postgres
NODE_PATH=<playwright dir> node scripts/playtest.mjs
```
