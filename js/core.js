// Dibs — pure rules. No DOM, no fetch, no Date.now(): time is always an argument.
// Mirrored one-for-one by supabase/dibs-SETUP.sql and js/fake-backend.js.
// Change all three together and add a case to scripts/test-core.mjs.

export const APP = { name: 'Dibs', tagline: 'Call dibs on Burlington, one block at a time.', slug: 'dibs' };

export const RULES = Object.freeze({
  takePts: 3,          // taking a block from someone
  freshPts: 6,         // taking a block nobody holds (never claimed, or gone cold)
  holdPerHour: 1,      // points per hour held, × hex weight (landmarks = 3)
  landmarkWeight: 3,
  bountyPts: 10,       // first tap of today's bounty block, once per player per day
  lockMin: 15,         // after a take, nobody else can take it for this long
  coldDays: 7,         // untouched this long → block goes cold (neutral)
  refreshHours: 1,     // re-tapping your own block counts as a touch at most hourly
  cooldownSec: 20,     // min seconds between a player's claims
  maxSpeedMps: 12,     // faster than this between consecutive claims = not on foot/bike
  dailyCap: 200,       // claims per player per local day
  goodAccuracyM: 60,   // ≤ this: claim freely
  maxAccuracyM: 150,   // > this: refuse, ask to step outside
  nameMin: 2, nameMax: 20,
});

export const CREWS = Object.freeze([
  { code: 'downtown', name: 'Downtown', short: 'DTWN', color: '#D62839', blurb: 'Church Street, the waterfront, up the hill to Pearl.' },
  { code: 'one',      name: 'Old North End', short: 'ONE',  color: '#F28C28', blurb: 'North Street, Roosevelt Park, the Intervale edge.' },
  { code: 'nne',      name: 'New North End', short: 'NNE',  color: '#5B8E3E', blurb: 'North Ave, Leddy, the Tower, Starr Farm.' },
  { code: 'southend', name: 'South End',     short: 'SE',   color: '#2E7D8A', blurb: 'Pine Street, Oakledge, Lakeside, the Five Sisters.' },
  { code: 'hill',     name: 'The Hill',      short: 'HILL', color: '#7B4BB5', blurb: 'UVM, Champlain, the Hill Section.' },
  { code: 'winooski', name: 'Winooski',      short: 'WNSK', color: '#D9A21B', blurb: 'The Onion City. The Circle. The Falls.' },
  { code: 'flat',     name: 'Flatlanders',   short: 'FLAT', color: '#7A8594', blurb: 'South Burlington, Colchester, and everyone from away.' },
]);
export const CREW = Object.fromEntries(CREWS.map((c) => [c.code, c]));
export function isCrew(code) { return Boolean(CREW[code]); }
/** a hex's hood → the crew whose home turf it is */
export function homeCrewOf(hood) { return CREW[hood] ? hood : 'flat'; }
export const HOOD_NAME = Object.freeze({ downtown: 'Downtown', one: 'Old North End', nne: 'New North End', southend: 'South End', hill: 'The Hill', winooski: 'Winooski', sburl: 'South Burlington', colchester: 'Colchester' });

// ---- text hygiene (mirrors dibs_clean in SQL) ----
export function clean(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
export function validName(name) {
  const n = clean(name, RULES.nameMax);
  if (n.length < RULES.nameMin) return { ok: false, error: 'name_short' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'\-]*$/u.test(n)) return { ok: false, error: 'name_chars' };
  return { ok: true, name: n };
}

// ---- time ----
export const TZ = 'America/New_York';
/** YYYY-MM-DD in Burlington for a ms timestamp */
export function localDate(ts) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/** ms timestamp of the start of the current month in Burlington (hour precision is plenty) */
export function monthStart(ts) {
  const ymd = localDate(ts);
  const first = `${ymd.slice(0, 7)}-01`;
  const [y, m] = ymd.split('-').map(Number);
  let t = Date.UTC(y, m - 1, 1, 12, 0, 0); // noon UTC on the 1st is the 1st in Burlington
  while (localDate(t - 3600e3) === first) t -= 3600e3;
  return t;
}
export function dayNumber(ymd) { // days since 2026-01-01, from a YYYY-MM-DD string
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2026, 0, 1)) / 86400e3);
}

// ---- bounty: one landmark block per local day, same pick on every device and in SQL ----
export function bountyId(ymd, landmarkIds) {
  const ids = [...landmarkIds].sort();
  if (!ids.length) return null;
  const n = dayNumber(ymd);
  return ids[(((n * 7 + 3) % ids.length) + ids.length) % ids.length];
}

// ---- GPS gating ----
export function accuracyGrade(acc) {
  if (acc == null || !isFinite(acc)) return 'none';
  if (acc <= RULES.goodAccuracyM) return 'good';
  if (acc <= RULES.maxAccuracyM) return 'fuzzy';
  return 'bad';
}
/** keep the best fix out of a short watch window */
export function betterFix(a, b) { if (!a) return b; if (!b) return a; return b.accuracy < a.accuracy ? b : a; }

// ---- scoring (used by the fake backend + tests; the SQL does the same math) ----
export function holdPoints(holds, now, ms = monthStart(now)) {
  let pts = 0;
  for (const h of holds) {
    const end = h.ended_at ?? now; const start = Math.max(h.started_at, ms);
    if (end > start) pts += ((end - start) / 3600e3) * RULES.holdPerHour * (h.weight || 1);
  }
  return pts;
}
export function lockedUntil(hold) { return hold ? hold.touched_at + RULES.lockMin * 60e3 : 0; }
export function isCold(hold, now) { return Boolean(hold) && now - hold.touched_at > RULES.coldDays * 86400e3; }

/** What happens if a player taps a hex now. Pure decision shared by the fake backend and tests. */
export function decideClaim({ player, hold, hexWeight, now, isBounty, bountyDoneToday }) {
  if (player?.banned) return { error: 'banned' };
  if (player?.last_claim_at && now - player.last_claim_at < RULES.cooldownSec * 1e3) return { error: 'slow_down' };
  if (player && player.claims_today >= RULES.dailyCap) return { error: 'daily_cap' };
  const cold = isCold(hold, now);
  let result, pts = 0;
  if (!hold || cold) { result = 'fresh'; pts = RULES.freshPts; }
  else if (hold.token === player?.token) {
    result = now - hold.touched_at >= RULES.refreshHours * 3600e3 ? 'refreshed' : 'yours';
  } else if (now < lockedUntil(hold)) {
    return { error: 'locked', until: lockedUntil(hold), holder: hold.name };
  } else { result = 'took'; pts = RULES.takePts; }
  let bounty = false;
  if (isBounty && !bountyDoneToday) { bounty = true; pts += RULES.bountyPts; }
  return { result, pts, bounty, weight: hexWeight };
}

// ---- copy ----
export function sinceText(ts, now) {
  const m = Math.max(0, Math.round((now - ts) / 60e3));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`;
}
export function fmtPts(p) { return p >= 100 ? String(Math.round(p)) : String(Math.round(p * 10) / 10); }
