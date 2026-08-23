// node --test scripts/test-core.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as H from '../js/hex.js';
import * as C from '../js/core.js';
import { FakeBackend } from '../js/fake-backend.js';

const HEXES = JSON.parse(readFileSync(new URL('../data/hexes.json', import.meta.url), 'utf8')).hexes;
const byId = new Map(HEXES.map((h) => [h.id, h]));
const T0 = Date.UTC(2026, 7, 23, 18, 0, 0); // Sun Aug 23 2026, 2pm Burlington

test('hex math round-trips and is stable', () => {
  const church = H.hexAt(44.47875, -73.21268);
  assert.equal(H.hexId(church), '-1_0');
  const c = H.centerLatLng(church);
  assert.deepEqual(H.hexAt(c.lat, c.lng), church);
  assert.equal(H.corners(church).length, 6);
  // every corner of a hex is closer to its own centre than to any neighbour's
  for (const p of H.corners(church)) {
    const d0 = H.haversineM(p[0], p[1], c.lat, c.lng);
    assert.ok(d0 <= H.R + 1);
  }
  assert.equal(H.isHexId('-12_7'), true);
  assert.equal(H.isHexId('12.7'), false);
  assert.equal(H.isHexId('1234_1'), false);
  assert.equal(H.hexId(H.hexAt(44.4812, -73.2209)), '-5_3'); // Battery Park
  assert.ok(Math.abs(H.centerDistance({ q: 0, r: 0 }, { q: 1, r: 0 }) - Math.sqrt(3) * H.R) < 0.01);
});

test('the board is named and in play where it should be', () => {
  assert.ok(HEXES.length > 800 && HEXES.length < 1100, `board size ${HEXES.length}`);
  for (const h of HEXES) { assert.ok(H.isHexId(h.id)); assert.ok(h.name && h.name.length >= 3, h.id); assert.ok(C.HOOD_NAME[h.hood], h.hood); }
  assert.equal(byId.get(H.idAt(44.47875, -73.21268)).name, 'Church Street');
  assert.equal(byId.get(H.idAt(44.4812, -73.2209)).name, 'Battery Park');
  assert.equal(byId.get(H.idAt(44.4917, -73.2395)).lm, 1); // North Beach is a landmark
  assert.equal(byId.has(H.idAt(44.46, -73.30)), false); // the middle of the lake is not a block
  const lms = HEXES.filter((h) => h.lm).length; assert.ok(lms >= 30, `landmarks ${lms}`);
});

test('names, dates, bounty', () => {
  assert.deepEqual(C.validName('  Maya  '), { ok: true, name: 'Maya' });
  assert.equal(C.validName('M').ok, false);
  assert.equal(C.validName('<script>').ok, false);
  assert.equal(C.validName('see www.spam.com now').name, 'see now');
  assert.equal(C.localDate(T0), '2026-08-23');
  assert.equal(new Date(C.monthStart(T0)).toISOString(), '2026-08-01T04:00:00.000Z'); // EDT midnight
  assert.equal(C.dayNumber('2026-01-01'), 0);
  const ids = HEXES.filter((h) => h.lm).map((h) => h.id);
  const b = C.bountyId('2026-08-23', ids);
  assert.ok(ids.includes(b));
  assert.equal(C.bountyId('2026-08-23', ids), b, 'deterministic');
  assert.notEqual(C.bountyId('2026-08-24', ids), b, 'changes daily (7 and n coprime enough)');
  assert.equal(C.accuracyGrade(12), 'good'); assert.equal(C.accuracyGrade(90), 'fuzzy'); assert.equal(C.accuracyGrade(400), 'bad');
});

test('decideClaim: fresh, yours, locked, took, cold, bounty, cooldown', () => {
  const me = { token: 'me', last_claim_at: null, claims_today: 0 };
  assert.deepEqual(C.decideClaim({ player: me, hold: null, hexWeight: 1, now: T0 }), { result: 'fresh', pts: 6, bounty: false, weight: 1 });
  const mine = { token: 'me', touched_at: T0 - 10 * 60e3, name: 'me' };
  assert.equal(C.decideClaim({ player: me, hold: mine, hexWeight: 1, now: T0 }).result, 'yours');
  assert.equal(C.decideClaim({ player: me, hold: { ...mine, touched_at: T0 - 2 * 3600e3 }, hexWeight: 1, now: T0 }).result, 'refreshed');
  const theirs = { token: 'you', touched_at: T0 - 5 * 60e3, name: 'Bea' };
  assert.equal(C.decideClaim({ player: me, hold: theirs, hexWeight: 1, now: T0 }).error, 'locked');
  assert.deepEqual(C.decideClaim({ player: me, hold: { ...theirs, touched_at: T0 - 16 * 60e3 }, hexWeight: 1, now: T0 }), { result: 'took', pts: 3, bounty: false, weight: 1 });
  assert.equal(C.decideClaim({ player: me, hold: { ...theirs, touched_at: T0 - 8 * 86400e3 }, hexWeight: 1, now: T0 }).result, 'fresh');
  assert.equal(C.decideClaim({ player: me, hold: null, hexWeight: 3, now: T0, isBounty: true }).pts, 16);
  assert.equal(C.decideClaim({ player: me, hold: null, hexWeight: 3, now: T0, isBounty: true, bountyDoneToday: true }).pts, 6);
  assert.equal(C.decideClaim({ player: { ...me, last_claim_at: T0 - 5e3 }, hold: null, hexWeight: 1, now: T0 }).error, 'slow_down');
  assert.equal(C.decideClaim({ player: { ...me, claims_today: 200 }, hold: null, hexWeight: 1, now: T0 }).error, 'daily_cap');
  assert.equal(C.decideClaim({ player: { ...me, banned: true }, hold: null, hexWeight: 1, now: T0 }).error, 'banned');
});

test('holdPoints clips to the month and weights landmarks', () => {
  const ms = C.monthStart(T0);
  assert.equal(C.holdPoints([{ started_at: T0 - 2 * 3600e3, ended_at: null, weight: 3 }], T0, ms), 6);
  assert.equal(C.holdPoints([{ started_at: ms - 86400e3, ended_at: ms + 3600e3, weight: 1 }], T0, ms), 1); // only the in-month hour counts
  assert.equal(C.holdPoints([{ started_at: ms - 86400e3, ended_at: ms - 3600e3, weight: 1 }], T0, ms), 0);
});

test('fake backend walks the same path as the SQL suite', async () => {
  let now = T0; const fb = new FakeBackend({ hexes: HEXES, now: () => now, seed: false });
  const A = 'a'.repeat(32), B = 'b'.repeat(32);
  const bounty = fb.bounty();
  const plain = HEXES.find((h) => !h.lm && h.hood === 'downtown' && h.id !== bounty).id;
  const far = [...HEXES].reverse().find((h) => h.hood === 'nne' && h.id !== bounty).id;
  const lm = HEXES.find((h) => h.lm && h.id !== bounty).id;
  const call = (t, hx, n, c) => fb.rpc('dibs_claim', { p_token: t, p_hex: hx, p_name: n, p_crew: c }).catch((e) => ({ error: e.code, ...e }));

  assert.equal((await call(A, '999_999', 'Amy', 'one')).error, 'off_board');
  assert.equal((await call(A, plain, 'Amy', 'mars')).error, 'bad_crew');
  let r = await call(A, plain, 'Amy', 'one'); assert.equal(r.result, 'fresh'); assert.equal(r.pts, 6);
  assert.equal((await call(A, plain, 'Amy', 'one')).error, 'slow_down');
  now += 30e3; r = await call(A, plain, 'Amy', 'one'); assert.equal(r.result, 'yours');
  assert.equal((await call(B, plain, 'amy', 'nne')).error, 'name_taken');
  r = await call(B, plain, 'Ben', 'nne'); assert.equal(r.error, 'locked'); assert.equal(r.holder, 'Amy');
  now += 16 * 60e3; r = await call(B, plain, 'Ben', 'nne'); assert.equal(r.result, 'took'); assert.equal(r.pts, 3); assert.equal(r.from, 'Amy');
  let board = await fb.rpc('dibs_board'); assert.ok(board.hexes.some((h) => h.id === plain && h.n === 'Ben' && h.c === 'nne'));
  let st = await fb.rpc('dibs_standings'); assert.equal(st.recent[0].from, 'Amy'); assert.equal(st.recent[0].name, 'Ben');
  now += 30e3; assert.equal((await call(B, far, 'Ben', 'nne')).error, 'too_fast');
  now += 2 * 3600e3; r = await call(B, far, 'Ben', 'nne'); assert.equal(r.result, 'fresh');
  now += 2 * 3600e3; r = await call(B, far, 'Ben', 'nne'); assert.equal(r.result, 'refreshed');
  r = await call(A, lm, 'Amy', 'one'); assert.equal(r.result, 'fresh');
  now += 2 * 3600e3;
  let me = await fb.rpc('dibs_me', { p_token: A });
  // Amy: 6 (plain fresh) + ~0.27 (16 min hold) + 6 (landmark fresh) + 6 (2h × 3) ≈ 18.3
  assert.ok(Math.abs(me.pts - 18.3) < 0.2, `pts ${me.pts}`);
  assert.ok(me.held.some((h) => h.id === lm));
  r = await call(A, bounty, 'Amy', 'one'); assert.equal(r.bounty, true); assert.equal(r.pts, 16);
  now += 2 * 3600e3; r = await call(A, bounty, 'Amy', 'one'); assert.equal(r.result, 'refreshed'); assert.equal(r.bounty, false);
  // cold sweep
  now += 8 * 86400e3; board = await fb.rpc('dibs_board'); assert.equal(board.hexes.length, 0, 'everything went cold');
  r = await call(B, plain, 'Ben', 'nne'); assert.equal(r.result, 'fresh');
  // mod
  assert.equal((await fb.rpc('dibs_mod', { p_secret: 'x', p_action: 'players' }).catch((e) => e.code)), 'nope');
  r = await fb.rpc('dibs_mod', { p_secret: 'demo', p_action: 'ban', p_a: 'ben' }); assert.equal(r.changed, 1);
  now += 60e3; assert.equal((await call(B, plain, 'Ben', 'nne')).error, 'banned');
});

test('demo seed produces a lively but sane board', async () => {
  const fb = new FakeBackend({ hexes: HEXES, now: () => T0 });
  const board = await fb.rpc('dibs_board');
  assert.ok(board.hexes.length > 40 && board.hexes.length < 300, `seeded ${board.hexes.length}`);
  const ids = new Set(board.hexes.map((h) => h.id)); assert.equal(ids.size, board.hexes.length, 'one open hold per hex');
  const st = await fb.rpc('dibs_standings');
  assert.ok(st.players.length >= 10); assert.equal(st.crews.length, 7); assert.ok(st.recent.length > 0);
});
