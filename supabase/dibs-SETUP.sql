-- ============================================================================
-- Dibs — Supabase setup. Paste ONCE into the SQL editor of the shared Btown
-- project (jnouvwxomrcffqwilqkq), then paste supabase/dibs-HEXES.sql (the board).
-- Safe to re-run (idempotent). Everything here is prefixed dibs_ and touches
-- nothing else in the project (see the prefix map in the fleet notes).
--
-- Shape: the anon key is public, so NO table is readable or writable directly.
-- All access goes through security-definer RPCs that validate their own input.
-- Identity is a device token (32 hex chars) stored only as a sha256 hash.
-- The phone computes the hex id itself; the server NEVER receives lat/lng.
--
-- Rules (mirrored in js/core.js RULES and js/fake-backend.js — change all three):
--   take a held block +3 · take a fresh/cold block +6 · hold = 1 pt/hour × weight
--   (landmarks weight 3) · bounty block +10 once/player/day · 15-min lock after a
--   take · untouched 7 days = cold · 20 s cooldown · 12 m/s teleport guard ·
--   200 claims/day · hold income capped at 30 pts/hour · points are per calendar
--   month (America/New_York). Accuracy > 150 m is refused (bad_gps).
--
-- Threat model: a determined cheater can spoof GPS or script the RPC; rate
-- limits, the speed guard, the daily cap, unique names and a small public
-- community make it socially expensive, not impossible. No prizes you'd regret.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables
create table if not exists dibs_hexes (
  id      text primary key,           -- "q_r" axial hex id (js/hex.js)
  name    text not null,
  hood    text not null,              -- downtown|one|nne|southend|hill|winooski|sburl|colchester
  weight  int  not null default 1     -- 3 = landmark
);

create table if not exists dibs_players (
  token_hash    text primary key,
  name          text not null,
  crew          text not null,
  created_at    timestamptz not null default now(),
  last_claim_at timestamptz,
  last_hex      text,
  claims_day    date,
  claims_today  int not null default 0,
  banned        boolean not null default false
);
create unique index if not exists dibs_players_name_key on dibs_players (lower(name));

create table if not exists dibs_holds (
  id          bigserial primary key,
  hex_id      text not null references dibs_hexes(id),
  token_hash  text not null references dibs_players(token_hash),
  weight      int  not null default 1,
  started_at  timestamptz not null default now(),
  touched_at  timestamptz not null default now(),
  ended_at    timestamptz,
  end_reason  text                      -- taken | cold | cleared
);
create unique index if not exists dibs_holds_open_idx on dibs_holds (hex_id) where ended_at is null;
create index if not exists dibs_holds_player_idx on dibs_holds (token_hash, ended_at);
create index if not exists dibs_holds_touched_idx on dibs_holds (touched_at) where ended_at is null;
create index if not exists dibs_holds_ended_idx on dibs_holds (ended_at);

create table if not exists dibs_bonus (
  id          bigserial primary key,
  token_hash  text not null references dibs_players(token_hash),
  hex_id      text not null,
  kind        text not null,            -- took | fresh | bounty
  pts         int  not null,
  from_hash   text,                     -- previous holder on a take
  at          timestamptz not null default now(),
  day         date not null
);
create index if not exists dibs_bonus_player_idx on dibs_bonus (token_hash, at);
create index if not exists dibs_bonus_day_idx on dibs_bonus (day, kind, hex_id, token_hash);
create index if not exists dibs_bonus_at_idx on dibs_bonus (at desc);

create table if not exists dibs_mod_fails (at timestamptz not null default now());

alter table dibs_hexes     enable row level security;
alter table dibs_players   enable row level security;
alter table dibs_holds     enable row level security;
alter table dibs_bonus     enable row level security;
alter table dibs_mod_fails enable row level security;
revoke all on table dibs_hexes, dibs_players, dibs_holds, dibs_bonus, dibs_mod_fails from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function dibs_hash(p text) returns text
language sql immutable as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

create or replace function dibs_check_token(p text) returns text
language plpgsql immutable as $$
begin
  if p is null or p !~ '^[a-f0-9]{32}$' then raise exception 'bad_token'; end if;
  return dibs_hash(p);
end $$;

create or replace function dibs_clean(p text, max_len int) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
           '[[:cntrl:]]', ' ', 'g'),
           '\m(https?://|www\.)\S+', '', 'gi'),
           '\s+', ' ', 'g')), max_len)
$$;

create or replace function dibs_today() returns date
language sql stable as $$ select (now() at time zone 'America/New_York')::date $$;

create or replace function dibs_month_start() returns timestamptz
language sql stable as $$
  select date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York'
$$;

-- hex centre in local metres (same formula as js/hex.js: R=115, flat-top axial)
create or replace function dibs_hex_xy(p_id text, out x double precision, out y double precision)
language plpgsql immutable as $$
declare q int; r int;
begin
  q := split_part(p_id, '_', 1)::int; r := split_part(p_id, '_', 2)::int;
  x := 115 * 1.5 * q;
  y := 115 * (sqrt(3) / 2 * q + sqrt(3) * r);
end $$;

-- today's bounty: deterministic pick among landmark hexes (byte-order ids, like JS sort)
create or replace function dibs_bounty_today() returns text
language sql stable as $$
  select id from (
    select id, row_number() over (order by id collate "C") - 1 as i, count(*) over () as n
    from dibs_hexes where weight > 1
  ) s
  where i = ((((dibs_today() - date '2026-01-01') * 7 + 3) % n) + n) % n
$$;

create or replace function dibs_sweep() returns void
language sql as $$
  update dibs_holds set ended_at = now(), end_reason = 'cold'
  where ended_at is null and touched_at < now() - interval '7 days'
$$;

-- hold income is capped at 30 pts/hour overall (≈ your best 30 plain blocks) so one
-- hard-biking player can't run away with the month; takes/bounties are uncapped.
create or replace function dibs_points(h text) returns numeric
language sql stable as $$
  select least(coalesce((
      select sum(extract(epoch from (coalesce(ended_at, now()) - greatest(started_at, dibs_month_start()))) / 3600.0 * weight)
      from dibs_holds where token_hash = h and coalesce(ended_at, now()) > dibs_month_start()
    ), 0), 30 * extract(epoch from (now() - dibs_month_start())) / 3600.0)
    + coalesce((select sum(pts) from dibs_bonus where token_hash = h and at >= dibs_month_start()), 0)
$$;

create or replace function dibs_valid_crew(p text) returns boolean
language sql immutable as $$ select p in ('downtown','one','nne','southend','hill','winooski','flat') $$;

-- ---------------------------------------------------------------- claim
create or replace function dibs_claim(p_token text, p_hex text, p_name text, p_crew text, p_acc int default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  h text; hx dibs_hexes; pl dibs_players; hold dibs_holds; nm text; today date;
  res text; pts int := 0; bounty boolean := false; b_id text; from_name text; from_crew text;
  dist double precision; secs double precision; a record; b record; cname text;
begin
  h := dibs_check_token(p_token);
  perform pg_advisory_xact_lock(hashtext('dibs|' || h));
  perform dibs_sweep();

  select * into hx from dibs_hexes where id = p_hex;
  if not found then return json_build_object('error', 'off_board'); end if;
  if p_acc is not null and p_acc > 150 then return json_build_object('error', 'bad_gps'); end if;
  if not dibs_valid_crew(p_crew) then return json_build_object('error', 'bad_crew'); end if;

  select * into pl from dibs_players where token_hash = h for update;
  if found then
    -- existing player: the server's name is the name (renames go through dibs_profile / the back room)
    if pl.banned then return json_build_object('error', 'banned'); end if;
    if pl.crew <> p_crew then update dibs_players set crew = p_crew where token_hash = h; pl.crew := p_crew; end if;
  else
    nm := dibs_clean(p_name, 20);
    if length(nm) < 2 or nm !~ '^[[:alnum:]][[:alnum:] .''\-]*$' then return json_build_object('error', 'bad_name'); end if;
    if exists (select 1 from dibs_players where lower(name) = lower(nm)) then return json_build_object('error', 'name_taken'); end if;
    insert into dibs_players (token_hash, name, crew) values (h, nm, p_crew) returning * into pl;
  end if;

  if pl.last_claim_at is not null and pl.last_claim_at > now() - interval '20 seconds' then
    return json_build_object('error', 'slow_down');
  end if;
  today := dibs_today();
  if pl.claims_day is distinct from today then pl.claims_today := 0; end if;
  if pl.claims_today >= 200 then return json_build_object('error', 'daily_cap'); end if;
  if pl.last_hex is not null and pl.last_hex <> p_hex and pl.last_claim_at is not null then
    a := dibs_hex_xy(pl.last_hex); b := dibs_hex_xy(p_hex);
    dist := sqrt((a.x - b.x)^2 + (a.y - b.y)^2);
    secs := greatest(extract(epoch from (now() - pl.last_claim_at)), 1);
    if dist / secs > 12 then return json_build_object('error', 'too_fast'); end if;
  end if;

  select * into hold from dibs_holds where hex_id = p_hex and ended_at is null for update;
  if not found then
    res := 'fresh'; pts := 6;
    insert into dibs_holds (hex_id, token_hash, weight) values (p_hex, h, hx.weight);
  elsif hold.token_hash = h then
    if hold.touched_at <= now() - interval '1 hour' then
      res := 'refreshed'; update dibs_holds set touched_at = now() where id = hold.id;
    else res := 'yours'; end if;
  elsif hold.touched_at > now() - interval '15 minutes' then
    select name, crew into from_name, from_crew from dibs_players where token_hash = hold.token_hash;
    return json_build_object('error', 'locked', 'until', extract(epoch from hold.touched_at + interval '15 minutes') * 1000,
                             'holder', from_name, 'holder_crew', from_crew);
  else
    res := 'took'; pts := 3;
    select name, crew into from_name, from_crew from dibs_players where token_hash = hold.token_hash;
    update dibs_holds set ended_at = now(), end_reason = 'taken' where id = hold.id;
    insert into dibs_holds (hex_id, token_hash, weight) values (p_hex, h, hx.weight);
  end if;
  if pts > 0 then
    insert into dibs_bonus (token_hash, hex_id, kind, pts, from_hash, day) values (h, p_hex, res, pts, hold.token_hash, today);
  end if;

  b_id := dibs_bounty_today();
  if b_id = p_hex and not exists (select 1 from dibs_bonus where token_hash = h and day = today and kind = 'bounty') then
    bounty := true; pts := pts + 10;
    insert into dibs_bonus (token_hash, hex_id, kind, pts, day) values (h, p_hex, 'bounty', 10, today);
  end if;

  update dibs_players set last_claim_at = now(), last_hex = p_hex, claims_day = today, claims_today = pl.claims_today + 1
  where token_hash = h;

  return json_build_object('ok', true, 'result', res, 'pts', pts, 'bounty', bounty,
    'name', pl.name, 'crew', pl.crew,
    'hex', json_build_object('id', hx.id, 'name', hx.name, 'weight', hx.weight, 'hood', hx.hood),
    'from', from_name, 'from_crew', from_crew,
    'held', (select count(*) from dibs_holds where token_hash = h and ended_at is null),
    'pts_month', round(dibs_points(h), 1));
exception when unique_violation then
  get stacked diagnostics cname = constraint_name;
  -- two phones, same instant: same fresh block → the other one won; same new name → name_taken
  if cname = 'dibs_players_name_key' then return json_build_object('error', 'name_taken'); end if;
  return json_build_object('error', 'locked');
end $$;

-- set / change name + crew without claiming (same validation as dibs_claim)
create or replace function dibs_profile(p_token text, p_name text, p_crew text)
returns json language plpgsql security definer set search_path = public as $$
declare h text; nm text; pl dibs_players;
begin
  h := dibs_check_token(p_token);
  perform pg_advisory_xact_lock(hashtext('dibs|' || h));
  if exists (select 1 from dibs_players where token_hash = h and banned) then return json_build_object('error', 'banned'); end if;
  nm := dibs_clean(p_name, 20);
  if length(nm) < 2 or nm !~ '^[[:alnum:]][[:alnum:] .''\-]*$' then return json_build_object('error', 'bad_name'); end if;
  if not dibs_valid_crew(p_crew) then return json_build_object('error', 'bad_crew'); end if;
  if exists (select 1 from dibs_players where lower(name) = lower(nm) and token_hash <> h) then
    return json_build_object('error', 'name_taken');
  end if;
  insert into dibs_players (token_hash, name, crew) values (h, nm, p_crew)
  on conflict (token_hash) do update set name = excluded.name, crew = excluded.crew;
  select * into pl from dibs_players where token_hash = h;
  return json_build_object('ok', true, 'name', pl.name, 'crew', pl.crew);
exception when unique_violation then
  return json_build_object('error', 'name_taken');
end $$;

-- ---------------------------------------------------------------- reads
create or replace function dibs_board() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dibs_sweep();
  return json_build_object(
    'ts', extract(epoch from now()) * 1000,
    'bounty', dibs_bounty_today(),
    'month', to_char(now() at time zone 'America/New_York', 'YYYY-MM'),
    'hexes', coalesce((select json_agg(json_build_object(
        'id', d.hex_id, 'n', p.name, 'c', p.crew,
        's', extract(epoch from d.started_at) * 1000,
        't', extract(epoch from d.touched_at) * 1000))
      from dibs_holds d join dibs_players p on p.token_hash = d.token_hash
      where d.ended_at is null), '[]'::json));
end $$;

create or replace function dibs_standings() returns json
language plpgsql security definer set search_path = public as $$
declare ms timestamptz := dibs_month_start();
begin
  perform dibs_sweep();
  return json_build_object(
    'ts', extract(epoch from now()) * 1000,
    'month', to_char(now() at time zone 'America/New_York', 'YYYY-MM'),
    'players', coalesce((
      select json_agg(json_build_object('name', name, 'crew', crew, 'pts', pts, 'held', held) order by pts desc, held desc, name)
      from (
        select p.name, p.crew, round(dibs_points(p.token_hash), 1) as pts,
               (select count(*) from dibs_holds d where d.token_hash = p.token_hash and d.ended_at is null) as held
        from dibs_players p
        where not p.banned and (p.last_claim_at >= ms or exists (select 1 from dibs_holds d where d.token_hash = p.token_hash and d.ended_at is null))
        order by pts desc limit 100
      ) s), '[]'::json),
    'crews', coalesce((
      select json_agg(json_build_object('crew', c.crew, 'held', c.held, 'home_held', c.home_held, 'home_total', c.home_total, 'players', c.players))
      from (
        select cr.crew,
          (select count(*) from dibs_holds d join dibs_players p on p.token_hash = d.token_hash where d.ended_at is null and p.crew = cr.crew) as held,
          (select count(*) from dibs_holds d join dibs_players p on p.token_hash = d.token_hash join dibs_hexes x on x.id = d.hex_id
             where d.ended_at is null and p.crew = cr.crew and (x.hood = cr.crew or (cr.crew = 'flat' and x.hood in ('sburl','colchester')))) as home_held,
          (select count(*) from dibs_hexes x where x.hood = cr.crew or (cr.crew = 'flat' and x.hood in ('sburl','colchester'))) as home_total,
          (select count(*) from dibs_players p where p.crew = cr.crew and not p.banned and p.last_claim_at >= ms) as players
        from (values ('downtown'),('one'),('nne'),('southend'),('hill'),('winooski'),('flat')) as cr(crew)
      ) c), '[]'::json),
    'recent', coalesce((
      select json_agg(json_build_object('hex', b.hex_id, 'hex_name', x.name, 'name', p.name, 'crew', p.crew, 'kind', b.kind,
                                        'from', fp.name, 'from_crew', fp.crew, 'at', floor(extract(epoch from b.at) / 900) * 900000) order by b.at desc)
      from (select * from dibs_bonus where kind in ('took','fresh') order by at desc limit 40) b
      join dibs_players p on p.token_hash = b.token_hash
      join dibs_hexes x on x.id = b.hex_id
      left join dibs_players fp on fp.token_hash = b.from_hash), '[]'::json));
end $$;

create or replace function dibs_me(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare h text; pl dibs_players; my_pts numeric; rnk int; today date := dibs_today();
begin
  h := dibs_check_token(p_token);
  select * into pl from dibs_players where token_hash = h;
  if not found then return json_build_object('ok', true, 'new', true); end if;
  my_pts := round(dibs_points(h), 1);
  select count(*) + 1 into rnk from dibs_players p where not p.banned and p.token_hash <> h and dibs_points(p.token_hash) > my_pts;
  return json_build_object('ok', true, 'name', pl.name, 'crew', pl.crew, 'pts', my_pts, 'rank', rnk, 'banned', pl.banned,
    'claims_today', case when pl.claims_day = today then pl.claims_today else 0 end,
    'bounty_done', exists (select 1 from dibs_bonus where token_hash = h and day = today and kind = 'bounty'),
    'held', coalesce((select json_agg(json_build_object('id', d.hex_id, 'name', x.name, 'weight', x.weight, 'hood', x.hood,
                 's', extract(epoch from d.started_at) * 1000, 't', extract(epoch from d.touched_at) * 1000) order by d.started_at desc)
               from dibs_holds d join dibs_hexes x on x.id = d.hex_id where d.token_hash = h and d.ended_at is null), '[]'::json),
    'takes_month', (select count(*) from dibs_bonus where token_hash = h and at >= dibs_month_start() and kind in ('took','fresh')),
    'lost_month', (select count(*) from dibs_bonus where from_hash = h and at >= dibs_month_start() and kind = 'took'));
end $$;

-- ---------------------------------------------------------------- moderation
create or replace function dibs_mod_hash() returns text
language sql immutable as $$ select '$2a$12$ufeNv4razokSj6AGAR7Kh.tL9StRR90Q/uVR.d7.RzRFptoE9YM3q'::text $$;

create or replace function dibs_mod_ok(p_secret text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from dibs_mod_fails where at < now() - interval '15 minutes';
  if p_secret is null or length(p_secret) < 8 then return false; end if;
  -- throttle guessing (the anon key is public) without letting guessers lock the real moderator out
  if (select count(*) from dibs_mod_fails) >= 50 then return false; end if;
  if extensions.crypt(p_secret, dibs_mod_hash()) = dibs_mod_hash() then return true; end if;
  insert into dibs_mod_fails default values;
  return false;
end $$;

create or replace function dibs_mod(p_secret text, p_action text, p_a text default null, p_b text default null)
returns json language plpgsql security definer set search_path = public as $$
declare n int; nm text;
begin
  if not dibs_mod_ok(p_secret) then return json_build_object('error', 'nope'); end if;
  if p_action = 'players' then
    return coalesce((select json_agg(json_build_object('name', name, 'crew', crew, 'banned', banned, 'pts', round(dibs_points(token_hash), 1),
      'held', (select count(*) from dibs_holds d where d.token_hash = p.token_hash and d.ended_at is null),
      'last', last_claim_at, 'created', created_at) order by last_claim_at desc nulls last) from (select * from dibs_players limit 500) p), '[]'::json);
  elsif p_action in ('ban', 'unban') then
    update dibs_players set banned = (p_action = 'ban') where lower(name) = lower(p_a); get diagnostics n = row_count;
    if p_action = 'ban' then
      update dibs_holds set ended_at = now(), end_reason = 'cleared' where ended_at is null and token_hash in (select token_hash from dibs_players where lower(name) = lower(p_a));
    end if;
    return json_build_object('ok', true, 'changed', n);
  elsif p_action = 'rename' then
    nm := dibs_clean(p_b, 20);
    if length(nm) < 2 or nm !~ '^[[:alnum:]][[:alnum:] .''\-]*$' then return json_build_object('error', 'bad_name'); end if;
    if exists (select 1 from dibs_players where lower(name) = lower(nm)) then return json_build_object('error', 'name_taken'); end if;
    update dibs_players set name = nm where lower(name) = lower(p_a); get diagnostics n = row_count;
    return json_build_object('ok', true, 'changed', n);
  elsif p_action = 'clear' then
    update dibs_holds set ended_at = now(), end_reason = 'cleared' where ended_at is null and hex_id = p_a; get diagnostics n = row_count;
    return json_build_object('ok', true, 'changed', n);
  end if;
  return json_build_object('error', 'bad_action');
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function dibs_hash(text), dibs_check_token(text), dibs_clean(text, int), dibs_today(), dibs_month_start(),
  dibs_hex_xy(text), dibs_bounty_today(), dibs_sweep(), dibs_points(text), dibs_valid_crew(text), dibs_mod_hash(), dibs_mod_ok(text),
  dibs_claim(text, text, text, text, int), dibs_profile(text, text, text), dibs_board(), dibs_standings(), dibs_me(text), dibs_mod(text, text, text, text)
  from public, anon, authenticated;
grant execute on function dibs_claim(text, text, text, text, int), dibs_profile(text, text, text), dibs_board(), dibs_standings(), dibs_me(text), dibs_mod(text, text, text, text) to anon;
