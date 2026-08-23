// Dibs — in-memory twin of supabase/dibs-SETUP.sql. Used by `?demo=1` (seeded
// board, nothing saved) and by scripts/test-core.mjs. Same RPC names, same error
// codes, same rules (via js/core.js). Change the SQL → change this → add a test.
import { RULES, CREWS, decideClaim, holdPoints, localDate, monthStart, bountyId, isCold, validName, isCrew } from './core.js';
import { parseId, centerDistance } from './hex.js';

const DEMO_PLAYERS = [
  ['Bike Path Pete', 'nne'], ['Onion City Otis', 'winooski'], ['Pine St Pablo', 'southend'],
  ['Battery Park Bea', 'downtown'], ['North St Nora', 'one'], ['Catamount Cal', 'hill'],
  ['Creemee Queen', 'southend'], ['Shore Rd Shay', 'nne'], ['Dorset St Dee', 'flat'],
  ['Lakeside Lou', 'southend'], ['Intervale Ivy', 'one'], ['Church St Chuck', 'downtown'],
];

export class FakeBackend {
  constructor({ hexes = null, now = () => Date.now(), seed = true } = {}) {
    this.nowFn = now; this.hexes = null; this.byId = new Map();
    this.players = new Map(); // token → {token,name,crew,last_claim_at,last_hex,claims_day,claims_today,banned,created_at}
    this.holds = [];          // {id,hex,token,name,crew,weight,started_at,touched_at,ended_at,end_reason}
    this.bonus = [];          // {token,hex,kind,pts,from,at,day}
    this.seedWanted = seed;
    if (hexes) this.load(hexes);
  }
  load(hexes) {
    this.hexes = hexes; this.byId = new Map(hexes.map((h) => [h.id, h]));
    if (this.seedWanted) this.seed();
  }
  async ready() {
    if (this.hexes) return;
    const d = await (await fetch(new URL('../data/hexes.json', import.meta.url))).json();
    this.load(d.hexes);
  }
  now() { return this.nowFn(); }
  bounty() { return bountyId(localDate(this.now()), this.hexes.filter((h) => h.lm).map((h) => h.id)); }

  seed() {
    const now = this.now();
    // deterministic pseudo-random so the demo looks the same every load
    let s = 7; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const byHood = {}; for (const h of this.hexes) (byHood[h.hood] ||= []).push(h);
    const homeOf = (crew) => crew === 'flat' ? [...(byHood.sburl || []), ...(byHood.colchester || [])] : (byHood[crew] || []);
    DEMO_PLAYERS.forEach(([name, crew], i) => {
      const token = `demo${String(i).padStart(28, '0')}`;
      this.players.set(token, { token, name, crew, last_claim_at: now - 3600e3 * (1 + rnd() * 30), last_hex: null, claims_day: null, claims_today: 0, banned: false, created_at: now - 86400e3 * 20 });
      const home = homeOf(crew); if (!home.length) return;
      const start = home[Math.floor(rnd() * home.length)]; const sq = parseId(start.id);
      // claim a cluster around a random home hex
      const cluster = home.filter((h) => centerDistance(sq, parseId(h.id)) < 700 + rnd() * 600).slice(0, 6 + Math.floor(rnd() * 10));
      for (const h of cluster) {
        if (this.openHold(h.id)) continue;
        const age = 3600e3 * (0.5 + rnd() * 120);
        this.holds.push({ id: this.holds.length + 1, hex: h.id, token, name, crew, weight: h.lm ? RULES.landmarkWeight : 1, started_at: now - age, touched_at: now - Math.min(age, 3600e3 * rnd() * 100), ended_at: null, end_reason: null });
        this.bonus.push({ token, hex: h.id, kind: 'fresh', pts: RULES.freshPts, from: null, at: now - age, day: localDate(now - age) });
      }
    });
    // a few recent takes for the feed
    const open = this.holds.filter((h) => !h.ended_at);
    for (let i = 0; i < 6 && open.length > 12; i++) {
      const victim = open[Math.floor(rnd() * open.length)];
      const thief = [...this.players.values()][Math.floor(rnd() * DEMO_PLAYERS.length)];
      if (thief.token === victim.token) continue;
      const at = now - 60e3 * (5 + rnd() * 600);
      victim.ended_at = at; victim.end_reason = 'taken';
      const hx = this.byId.get(victim.hex);
      this.holds.push({ id: this.holds.length + 1, hex: victim.hex, token: thief.token, name: thief.name, crew: thief.crew, weight: hx.lm ? 3 : 1, started_at: at, touched_at: at, ended_at: null, end_reason: null });
      this.bonus.push({ token: thief.token, hex: victim.hex, kind: 'took', pts: RULES.takePts, from: victim.token, at, day: localDate(at) });
      open.splice(open.indexOf(victim), 1);
    }
  }

  sweep() { const now = this.now(); for (const h of this.holds) if (!h.ended_at && isCold(h, now)) { h.ended_at = now; h.end_reason = 'cold'; } }
  openHold(hex) { return this.holds.find((h) => h.hex === hex && !h.ended_at) || null; }
  points(token) {
    const now = this.now(), ms = monthStart(now);
    return holdPoints(this.holds.filter((h) => h.token === token), now, ms) + this.bonus.filter((b) => b.token === token && b.at >= ms).reduce((a, b) => a + b.pts, 0);
  }
  playerByName(name) { const n = String(name).toLowerCase(); return [...this.players.values()].find((p) => p.name.toLowerCase() === n) || null; }

  async rpc(fn, args = {}) {
    await this.ready();
    const f = this['rpc_' + fn]; if (!f) throw new Error(`no fake rpc ${fn}`);
    const out = f.call(this, args);
    if (out && out.error) { const e = new Error(out.error); e.code = out.error; Object.assign(e, out); throw e; }
    return out;
  }

  rpc_dibs_claim({ p_token, p_hex, p_name, p_crew, p_acc }) {
    if (!/^[a-f0-9]{32}$|^demo\d{28}$/.test(p_token || '')) return { error: 'bad_token' };
    this.sweep();
    const now = this.now();
    const hx = this.byId.get(p_hex); if (!hx) return { error: 'off_board' };
    if (p_acc != null && p_acc > RULES.maxAccuracyM) return { error: 'bad_gps' };
    if (!isCrew(p_crew)) return { error: 'bad_crew' };
    let pl = this.players.get(p_token);
    if (pl) {
      if (pl.banned) return { error: 'banned' };
      pl.crew = p_crew; // the server's name is the name; renames go through dibs_profile
    } else {
      const v = validName(p_name); if (!v.ok) return { error: 'bad_name' };
      if (this.playerByName(v.name)) return { error: 'name_taken' };
      pl = { token: p_token, name: v.name, crew: p_crew, last_claim_at: null, last_hex: null, claims_day: null, claims_today: 0, banned: false, created_at: now }; this.players.set(p_token, pl);
    }
    const today = localDate(now);
    if (pl.claims_day !== today) { pl.claims_day = today; pl.claims_today = 0; }
    if (pl.last_claim_at && now - pl.last_claim_at < RULES.cooldownSec * 1e3) return { error: 'slow_down' };
    if (pl.claims_today >= RULES.dailyCap) return { error: 'daily_cap' };
    if (pl.last_hex && pl.last_hex !== p_hex && pl.last_claim_at) {
      const dist = centerDistance(parseId(pl.last_hex), parseId(p_hex));
      const secs = Math.max((now - pl.last_claim_at) / 1000, 1);
      if (dist / secs > RULES.maxSpeedMps) return { error: 'too_fast' };
    }
    const hold = this.openHold(p_hex);
    const bountyDone = this.bonus.some((b) => b.token === p_token && b.day === today && b.kind === 'bounty');
    const d = decideClaim({ player: pl, hold, hexWeight: hx.lm ? 3 : 1, now, isBounty: this.bounty() === p_hex, bountyDoneToday: bountyDone });
    if (d.error) return d.error === 'locked' ? { error: 'locked', until: d.until, holder: hold.name, holder_crew: hold.crew } : { error: d.error };
    let from = null, from_crew = null;
    if (d.result === 'fresh' || d.result === 'took') {
      if (hold) { hold.ended_at = now; hold.end_reason = d.result === 'took' ? 'taken' : 'cold'; if (d.result === 'took') { from = hold.name; from_crew = hold.crew; } }
      this.holds.push({ id: this.holds.length + 1, hex: p_hex, token: p_token, name: pl.name, crew: pl.crew, weight: hx.lm ? 3 : 1, started_at: now, touched_at: now, ended_at: null, end_reason: null });
      this.bonus.push({ token: p_token, hex: p_hex, kind: d.result, pts: d.result === 'fresh' ? RULES.freshPts : RULES.takePts, from: hold?.token || null, at: now, day: today });
    } else if (d.result === 'refreshed') hold.touched_at = now;
    if (d.bounty) this.bonus.push({ token: p_token, hex: p_hex, kind: 'bounty', pts: RULES.bountyPts, from: null, at: now, day: today });
    // keep holder name/crew current on open holds
    for (const h of this.holds) if (h.token === p_token && !h.ended_at) { h.name = pl.name; h.crew = pl.crew; }
    pl.last_claim_at = now; pl.last_hex = p_hex; pl.claims_today += 1;
    return { ok: true, result: d.result, pts: d.pts, bounty: d.bounty, name: pl.name, crew: pl.crew, hex: { id: hx.id, name: hx.name, weight: hx.lm ? 3 : 1, hood: hx.hood },
      from, from_crew, held: this.holds.filter((h) => h.token === p_token && !h.ended_at).length, pts_month: Math.round(this.points(p_token) * 10) / 10 };
  }

  rpc_dibs_profile({ p_token, p_name, p_crew }) {
    if (!/^[a-f0-9]{32}$|^demo\d{28}$/.test(p_token || '')) return { error: 'bad_token' };
    if (this.players.get(p_token)?.banned) return { error: 'banned' };
    const v = validName(p_name); if (!v.ok) return { error: 'bad_name' };
    if (!isCrew(p_crew)) return { error: 'bad_crew' };
    const other = this.playerByName(v.name); if (other && other.token !== p_token) return { error: 'name_taken' };
    let pl = this.players.get(p_token);
    if (!pl) { pl = { token: p_token, name: v.name, crew: p_crew, last_claim_at: null, last_hex: null, claims_day: null, claims_today: 0, banned: false, created_at: this.now() }; this.players.set(p_token, pl); }
    else { pl.name = v.name; pl.crew = p_crew; for (const h of this.holds) if (h.token === p_token && !h.ended_at) { h.name = pl.name; h.crew = pl.crew; } }
    return { ok: true, name: pl.name, crew: pl.crew };
  }

  rpc_dibs_board() {
    this.sweep();
    return { ts: this.now(), bounty: this.bounty(), month: localDate(this.now()).slice(0, 7),
      hexes: this.holds.filter((h) => !h.ended_at).map((h) => ({ id: h.hex, n: h.name, c: h.crew, s: h.started_at, t: h.touched_at })) };
  }

  rpc_dibs_standings() {
    this.sweep();
    const now = this.now(), ms = monthStart(now);
    const open = this.holds.filter((h) => !h.ended_at);
    const players = [...this.players.values()].filter((p) => !p.banned && ((p.last_claim_at || 0) >= ms || open.some((h) => h.token === p.token)))
      .map((p) => ({ name: p.name, crew: p.crew, pts: Math.round(this.points(p.token) * 10) / 10, held: open.filter((h) => h.token === p.token).length }))
      .sort((a, b) => b.pts - a.pts || b.held - a.held || a.name.localeCompare(b.name)).slice(0, 100);
    const homeHoods = (c) => c === 'flat' ? ['sburl', 'colchester'] : [c];
    const crews = CREWS.map((c) => ({ crew: c.code,
      held: open.filter((h) => h.crew === c.code).length,
      home_held: open.filter((h) => h.crew === c.code && homeHoods(c.code).includes(this.byId.get(h.hex)?.hood)).length,
      home_total: this.hexes.filter((h) => homeHoods(c.code).includes(h.hood)).length,
      players: [...this.players.values()].filter((p) => p.crew === c.code && !p.banned && (p.last_claim_at || 0) >= ms).length }));
    const recent = this.bonus.filter((b) => b.kind === 'took' || b.kind === 'fresh').sort((a, b) => b.at - a.at).slice(0, 40).map((b) => {
      const p = this.players.get(b.token), fp = b.from ? this.players.get(b.from) : null;
      return { hex: b.hex, hex_name: this.byId.get(b.hex)?.name, name: p?.name, crew: p?.crew, kind: b.kind, from: fp?.name || null, from_crew: fp?.crew || null, at: Math.floor(b.at / 900e3) * 900e3 };
    });
    return { ts: now, month: localDate(now).slice(0, 7), players, crews, recent };
  }

  rpc_dibs_me({ p_token }) {
    const pl = this.players.get(p_token); if (!pl) return { ok: true, new: true };
    const now = this.now(), ms = monthStart(now), today = localDate(now);
    const pts = Math.round(this.points(p_token) * 10) / 10;
    const rank = [...this.players.values()].filter((p) => !p.banned && p.token !== p_token && this.points(p.token) > pts).length + 1;
    return { ok: true, name: pl.name, crew: pl.crew, pts, rank, banned: pl.banned,
      claims_today: pl.claims_day === today ? pl.claims_today : 0,
      bounty_done: this.bonus.some((b) => b.token === p_token && b.day === today && b.kind === 'bounty'),
      held: this.holds.filter((h) => h.token === p_token && !h.ended_at).sort((a, b) => b.started_at - a.started_at).map((h) => { const x = this.byId.get(h.hex); return { id: h.hex, name: x.name, weight: h.weight, hood: x.hood, s: h.started_at, t: h.touched_at }; }),
      takes_month: this.bonus.filter((b) => b.token === p_token && b.at >= ms && (b.kind === 'took' || b.kind === 'fresh')).length,
      lost_month: this.bonus.filter((b) => b.from === p_token && b.at >= ms && b.kind === 'took').length };
  }

  rpc_dibs_mod({ p_secret, p_action, p_a, p_b }) {
    if (p_secret !== 'demo') return { error: 'nope' };
    if (p_action === 'players') return [...this.players.values()].map((p) => ({ name: p.name, crew: p.crew, banned: p.banned, pts: Math.round(this.points(p.token) * 10) / 10, held: this.holds.filter((h) => h.token === p.token && !h.ended_at).length, last: p.last_claim_at ? new Date(p.last_claim_at).toISOString() : null, created: new Date(p.created_at).toISOString() }));
    if (p_action === 'ban' || p_action === 'unban') { const p = this.playerByName(p_a); if (!p) return { ok: true, changed: 0 }; p.banned = p_action === 'ban'; if (p.banned) for (const h of this.holds) if (h.token === p.token && !h.ended_at) { h.ended_at = this.now(); h.end_reason = 'cleared'; } return { ok: true, changed: 1 }; }
    if (p_action === 'rename') { const v = validName(p_b); if (!v.ok) return { error: 'bad_name' }; if (this.playerByName(v.name)) return { error: 'name_taken' }; const p = this.playerByName(p_a); if (!p) return { ok: true, changed: 0 }; p.name = v.name; for (const h of this.holds) if (h.token === p.token && !h.ended_at) h.name = v.name; return { ok: true, changed: 1 }; }
    if (p_action === 'clear') { let n = 0; for (const h of this.holds) if (h.hex === p_a && !h.ended_at) { h.ended_at = this.now(); h.end_reason = 'cleared'; n++; } return { ok: true, changed: n }; }
    return { error: 'bad_action' };
  }
}
