#!/usr/bin/env bash
# Dibs — SQL scenario suite against a throwaway local Postgres database.
#   scripts/test-sql.sh            (needs psql + a local server; uses db dibs_test)
# Exercises dibs_claim/board/standings/me/mod exactly as the anon role would.
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="psql -h localhost -d dibs_test -v ON_ERROR_STOP=1 -qtA"
SECRET="${DIBS_MOD_SECRET:-$(grep DIBS_MOD_SECRET ~/.config/btownbrief/secrets.env 2>/dev/null | cut -d= -f2 || true)}"

psql -h localhost -d postgres -qc "drop database if exists dibs_test;" >/dev/null
psql -h localhost -d postgres -qc "create database dibs_test;" >/dev/null
psql -h localhost -d dibs_test -qc "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;" >/dev/null 2>&1
psql -h localhost -d dibs_test -qc "create role anon nologin;" >/dev/null 2>&1 || true
psql -h localhost -d dibs_test -qc "create role authenticated nologin;" >/dev/null 2>&1 || true
psql -h localhost -d dibs_test -v ON_ERROR_STOP=1 -q -f supabase/dibs-SETUP.sql 2>&1 | grep -v NOTICE || true
psql -h localhost -d dibs_test -v ON_ERROR_STOP=1 -q -f supabase/dibs-HEXES.sql

pass=0; fail=0
check() { # check "label" "sql returning one value" "expected substring"
  local got; got=$($PSQL -c "$2" 2>&1 | tr -d '\n' || true)
  if [[ "$got" == *"$3"* ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1"; echo "   sql: $2"; echo "   got: $got"; echo "   want: *$3*"; fi
}

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; C=cccccccccccccccccccccccccccccccc
HA=$($PSQL -c "select dibs_hash('$A')"); HB=$($PSQL -c "select dibs_hash('$B')")
BOUNTY=$($PSQL -c "select dibs_bounty_today()")
# a plain (non-landmark, non-bounty) downtown hex and a far NNE hex
PLAIN=$($PSQL -c "select id from dibs_hexes where weight=1 and hood='downtown' and id<>'$BOUNTY' order by id collate \"C\" limit 1")
FAR=$($PSQL -c "select id from dibs_hexes where hood='nne' and id<>'$BOUNTY' order by id collate \"C\" desc limit 1")
LM=$($PSQL -c "select id from dibs_hexes where weight=3 and id<>'$BOUNTY' order by id collate \"C\" limit 1")
echo "bounty=$BOUNTY plain=$PLAIN far=$FAR landmark=$LM"

R="set role anon;"
check "anon cannot read players" "$R select count(*) from dibs_players" "permission denied"
check "anon cannot read hexes"   "$R select count(*) from dibs_hexes" "permission denied"
check "bad token"                "$R select dibs_claim('nope','$PLAIN','Amy','one')" "bad_token"
check "off board"                "$R select dibs_claim('$A','999_999','Amy','one')" "off_board"
check "bad crew"                 "$R select dibs_claim('$A','$PLAIN','Amy','mars')" "bad_crew"
check "bad name (url)"           "$R select dibs_claim('$A','$PLAIN','http://x.co','one')" "bad_name"
check "fresh take = +6"          "$R select dibs_claim('$A','$PLAIN','Amy','one')" '"result" : "fresh", "pts" : 6'
check "cooldown"                 "$R select dibs_claim('$A','$PLAIN','Amy','one')" "slow_down"
$PSQL -c "update dibs_players set last_claim_at = now() - interval '30 seconds' where token_hash='$HA'" >/dev/null
check "re-tap own = yours"       "$R select dibs_claim('$A','$PLAIN','Amy','one')" '"result" : "yours", "pts" : 0'
check "name taken by other"      "$R select dibs_claim('$B','$PLAIN','amy','nne')" "name_taken"
$PSQL -c "update dibs_players set last_claim_at = now() - interval '30 seconds' where token_hash='$HA'" >/dev/null
check "claim never renames"       "$R select dibs_claim('$A','$PLAIN','Amy Renamed','one')" '"name" : "Amy"'
check "bad gps refused"           "$R select dibs_claim('$B','$PLAIN','Ben','nne', 400)" "bad_gps"
check "locked for others"        "$R select dibs_claim('$B','$PLAIN','Ben','nne')" '"error" : "locked"'
$PSQL -c "update dibs_holds set touched_at = now() - interval '16 minutes', started_at = now() - interval '16 minutes' where hex_id='$PLAIN'" >/dev/null
check "steal after lock = +3"    "$R select dibs_claim('$B','$PLAIN','Ben','nne')" '"result" : "took", "pts" : 3'
check "steal records from"       "$R select dibs_claim('$B','$PLAIN','Ben','nne')" "slow_down"
check "board shows Ben"          "$R select dibs_board()::text" "\"n\" : \"Ben\", \"c\" : \"nne\""
check "recent shows Amy→Ben"     "$R select dibs_standings()::text" '"from" : "Amy"'
$PSQL -c "update dibs_players set last_claim_at = now() - interval '30 seconds' where token_hash='$HB'" >/dev/null
check "teleport guard"           "$R select dibs_claim('$B','$FAR','Ben','nne')" "too_fast"
$PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours' where token_hash='$HB'" >/dev/null
check "far claim after 2h ok"    "$R select dibs_claim('$B','$FAR','Ben','nne')" '"result" : "fresh"'
# refresh after 1h
$PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours' where token_hash='$HB'; update dibs_holds set touched_at = now() - interval '2 hours' where hex_id='$FAR'" >/dev/null
check "refresh own after 1h"     "$R select dibs_claim('$B','$FAR','Ben','nne')" '"result" : "refreshed"'
# landmark points: Amy holds a landmark for 2h → 6 hold pts + 6 fresh
$PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours' where token_hash='$HA'" >/dev/null
check "landmark fresh"           "$R select dibs_claim('$A','$LM','Amy','one')" '"result" : "fresh"'
$PSQL -c "update dibs_holds set started_at = now() - interval '2 hours', touched_at = now() - interval '2 hours' where hex_id='$LM'" >/dev/null
check "points = 6 fresh + 6 fresh + 2h×3 = 18"   "select round(dibs_points('$HA'))" "18"
# hold cap: 40 blocks held since before the month started → raw 40/h, capped at 30/h × hours this month
$PSQL -c "insert into dibs_players(token_hash,name,crew) values ('capper','Capper','nne'); insert into dibs_holds(hex_id,token_hash,weight,started_at,touched_at) select id,'capper',1,dibs_month_start()-interval '1 day',now() from dibs_hexes x where hood='nne' and not exists (select 1 from dibs_holds d where d.hex_id=x.id and d.ended_at is null) limit 40;" >/dev/null
check "hold income capped 30/h"   "select round(dibs_points('capper')) = round(30 * extract(epoch from (now() - dibs_month_start())) / 3600.0)" "t"
$PSQL -c "delete from dibs_holds where token_hash='capper'; delete from dibs_players where token_hash='capper';" >/dev/null
check "me shape"                 "$R select dibs_me('$A')::text" '"name" : "Amy", "crew" : "one"'
check "me held landmark"         "$R select dibs_me('$A')::text" "\"id\" : \"$LM\""
# bounty: +10 once per day
$PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours', last_hex = null where token_hash='$HA'" >/dev/null
check "bounty pays +10"          "$R select dibs_claim('$A','$BOUNTY','Amy','one')" '"pts" : 16, "bounty" : true'
$PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours' where token_hash='$HA'; update dibs_holds set touched_at = now() - interval '2 hours' where hex_id='$BOUNTY'" >/dev/null
check "bounty once per day"      "$R select dibs_claim('$A','$BOUNTY','Amy','one')" '"result" : "refreshed", "pts" : 0, "bounty" : false'
check "board carries bounty id"  "$R select dibs_board()::text" "\"bounty\" : \"$BOUNTY\""
# cold sweep
$PSQL -c "update dibs_holds set touched_at = now() - interval '8 days' where hex_id='$PLAIN'" >/dev/null
check "cold block leaves board"  "$R select (dibs_board()->'hexes')::text like '%\"$PLAIN\"%'" "f"
check "cold hold closed"         "select end_reason from dibs_holds where hex_id='$PLAIN' order by id desc limit 1" "cold"
# daily cap
$PSQL -c "update dibs_players set claims_today = 200, claims_day = dibs_today(), last_claim_at = now() - interval '2 hours' where token_hash='$HB'" >/dev/null
check "daily cap"                "$R select dibs_claim('$B','$PLAIN','Ben','nne')" "daily_cap"
$PSQL -c "update dibs_players set claims_today = 0 where token_hash='$HB'" >/dev/null
# standings shape
check "standings players"        "$R select dibs_standings()::text" '"name" : "Amy"'
check "standings crews"          "$R select dibs_standings()::text" '"crew" : "winooski"'
# moderation
check "mod wrong secret"         "$R select dibs_mod('wrong-secret-xx','players')" "nope"
if [[ -n "$SECRET" ]]; then
  check "mod players"            "$R select dibs_mod('$SECRET','players')::text" '"name" : "Ben"'
  check "mod ban"                "$R select dibs_mod('$SECRET','ban','ben')" '"changed" : 1'
  check "banned cannot claim"    "$R select dibs_claim('$B','$PLAIN','Ben','nne')" "banned"
  check "ban clears holds"       "select count(*) from dibs_holds where token_hash='$HB' and ended_at is null" "0"
  check "mod rename"             "$R select dibs_mod('$SECRET','rename','Amy','Amy B')" '"changed" : 1'
  check "mod rename validated"   "$R select dibs_mod('$SECRET','rename','Amy B','<img src=x>')" "bad_name"
  $PSQL -c "update dibs_players set last_claim_at = now() - interval '2 hours' where token_hash='$HA'" >/dev/null
  check "renamed sticks on claim" "$R select dibs_claim('$A','$PLAIN','Amy','one')" '"name" : "Amy B"'
  check "banned cannot rename"    "$R select dibs_profile('$B','Benny','nne')" "banned"
  check "mod clear hex"          "$R select dibs_mod('$SECRET','clear','$LM')" '"changed" : 1'
else
  echo "  (no DIBS_MOD_SECRET in env — mod tests skipped)"
fi
check "profile sets name"         "$R select dibs_profile('$C','Cal','hill')" '"ok" : true, "name" : "Cal"'
check "profile name taken"        "$R select dibs_profile('$C','Ben','hill')" "name_taken"
check "profile bad crew"          "$R select dibs_profile('$C','Cal','mars')" "bad_crew"
# bounty pick matches JS
JSB=$(node -e "import('./js/core.js').then(async c=>{const d=JSON.parse(require('fs').readFileSync('data/hexes.json','utf8'));console.log(c.bountyId(c.localDate(Date.now()), d.hexes.filter(h=>h.lm).map(h=>h.id)))})")
check "bounty matches JS"        "select dibs_bounty_today()" "$JSB"

echo "SQL suite: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
