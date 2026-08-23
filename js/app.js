// Dibs — the app. Glue between the map (map.js), the rules (core.js) and the
// back end (net.js). Location never leaves this file: the phone turns a fix into
// a hex id with hex.js and only the id is sent.
import { APP, RULES, CREWS, CREW, HOOD_NAME, validName, accuracyGrade, betterFix, localDate, bountyId, sinceText, fmtPts, lockedUntil } from './core.js';
import { idAt, parseId, centerLatLng } from './hex.js';
import { createMap } from './map.js';
import { backend, token, remembered, remember, store, explain, DEMO, TEST } from './net.js';

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const api = backend();
const TOKEN = token();

// ---------------------------------------------------------------- state
const S = {
  hexes: [], byId: new Map(), map: null,
  board: null, boardAt: 0, bounty: null,
  name: '', crew: '', me: null,            // me = last dibs_me payload
  pos: null, fix: null, watchId: null, locating: false, fixAt: 0, best: null, bestTimer: null,
  hereId: null, busy: false, lastClaimAt: 0, wantWatch: false, backendDown: null,
};

// ---------------------------------------------------------------- boot
async function boot() {
  const data = await (await fetch('data/hexes.json')).json();
  S.hexes = data.hexes; S.byId = new Map(S.hexes.map((h) => [h.id, h]));
  S.map = createMap($('#map'), S.hexes, { dark });
  S.map.onHexTap(openHexSheet);
  const r = remembered(); S.name = r.name; S.crew = r.crew;
  applyCrewTheme();
  S.map.setMyName(S.name || null);

  $('#claim').addEventListener('click', onClaimButton);
  $('#relocate').addEventListener('click', () => startLocating(true));
  $('#btn-standings').addEventListener('click', openStandings);
  $('#btn-me').addEventListener('click', openMe);
  $('#bounty').addEventListener('click', () => { if (S.bounty) { S.map.flyTo(S.bounty, 15); openHexSheet(S.bounty); } });
  for (const d of document.querySelectorAll('dialog.sheet')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

  await refreshBoard();
  if (S.name) api.rpc('dibs_me', { p_token: TOKEN }).then((me) => { if (me?.name && me.name !== S.name) { S.name = me.name; remember(S.name, S.crew); S.map.setMyName(S.name); renderHere(); } S.me = me; if (me?.bounty_done) $('#bounty').classList.add('done'); }).catch(() => {});
  setInterval(() => { if (document.visibilityState === 'visible') refreshBoard(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshBoard(); if (S.wantWatch) startLocating(true); } else stopLocating(); });

  // local bounty fallback so the pill works even before the board answers
  if (!S.bounty) setBounty(bountyId(localDate(Date.now()), S.hexes.filter((h) => h.lm).map((h) => h.id)));

  if (DEMO) {
    S.map.setTapToMove((ll) => { onPosition({ lat: ll.lat, lng: ll.lng, accuracy: 14, ts: Date.now() }, true); });
    showHint('Demo: tap the map to stand somewhere. Nothing is saved.');
  }
  const at = qs.get('at');
  if (at) { const p = parseAt(at); if (p) onPosition({ ...p, accuracy: 12, ts: Date.now() }, true); }

  if (!store.get('dibs-welcomed') && !at) openWelcome(); else if (!at && !DEMO && !TEST) startLocating(false);
  if (!TEST && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', $('.dock').offsetHeight + 'px')).observe($('.dock'));
  window.__dibs = S; // for the playtest
}

function parseAt(at) {
  const named = { church: [44.47875, -73.21268], battery: [44.4812, -73.2209], leddy: [44.5042, -73.25], oakledge: [44.4544, -73.2271], uvm: [44.47824, -73.19994], winooski: [44.49077, -73.18594], northbeach: [44.4917, -73.2395], pine: [44.4682, -73.2148], lake: [44.46, -73.30] };
  if (named[at]) return { lat: named[at][0], lng: named[at][1] };
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(at); return m ? { lat: +m[1], lng: +m[2] } : null;
}

// ---------------------------------------------------------------- crew theme
function applyCrewTheme() {
  const c = CREW[S.crew]; const root = document.documentElement;
  root.style.setProperty('--crew', c ? c.color : 'var(--accent)');
  root.style.setProperty('--crew-ink', '#fff');
}

// ---------------------------------------------------------------- board
async function refreshBoard() {
  try {
    const b = await api.rpc('dibs_board');
    S.board = b; S.boardAt = Date.now(); S.backendDown = null; S.map.setBoard(b);
    if (b.bounty) setBounty(b.bounty);
    renderHere();
  } catch (e) {
    S.backendDown = e.code === 'not_ready' ? 'not_ready' : (S.board ? null : 'offline');
    if (S.backendDown) { $('#here-status').textContent = explain(S.backendDown); renderClaimButton(); }
  }
}
function setBounty(id) {
  S.bounty = id; S.map.setBounty(id);
  const h = S.byId.get(id); const pill = $('#bounty');
  if (h) { $('#bounty-name').textContent = h.name; pill.hidden = false; pill.classList.toggle('done', Boolean(S.me?.bounty_done)); }
}
function holdOf(id) { return S.map?.hold(id) || null; }
function isMine(h) { return Boolean(h && S.name && h.n === S.name); }

// ---------------------------------------------------------------- location
function startLocating(force) {
  if (!('geolocation' in navigator)) { setGps('none', 'No GPS in this browser'); return; }
  if (S.watchId != null && !force) return;
  stopLocating(); S.wantWatch = true;
  S.locating = true; S.best = null; setGps('none', 'Finding you…'); renderClaimButton();
  // a short "best of" window first (iOS hands over a coarse fix, then converges), then continuous
  S.bestTimer = setTimeout(() => { S.locating = false; if (S.best) adopt(S.best); renderClaimButton(); }, 7000);
  S.watchId = navigator.geolocation.watchPosition((p) => {
    const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() };
    if (S.locating) { S.best = betterFix(S.best, fix); if (fix.accuracy <= 25) { clearTimeout(S.bestTimer); S.locating = false; adopt(fix); } else setGps(accuracyGrade(fix.accuracy), `Finding you… ±${Math.round(fix.accuracy)} m`); }
    else adopt(fix);
  }, (err) => {
    // code 1 = denied: the watch is dead, clear it. Codes 2/3 are transient (tunnel, cold start):
    // per spec the watch keeps running, so leave it alone and just say so.
    if (err.code === 1) { clearTimeout(S.bestTimer); S.locating = false; stopLocating(); S.wantWatch = false; setGps('bad', 'Location is off for this site — allow it in Settings › Safari › Location.'); renderClaimButton(); return; }
    if (!S.pos) setGps('bad', err.code === 3 ? 'Still looking for a GPS fix — step outside and try again.' : 'Could not get a location yet — hang on.');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 });
}
function stopLocating() { if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } clearTimeout(S.bestTimer); }
function adopt(fix) { onPosition(fix, false); }
function onPosition(fix, synthetic) {
  S.pos = fix; S.fixAt = Date.now();
  S.map.setMe(fix);
  const id = idAt(fix.lat, fix.lng);
  const onBoard = S.byId.has(id);
  const changed = id !== S.hereId;
  S.hereId = onBoard ? id : null;
  S.map.setHere(S.hereId);
  if (changed && onBoard && !synthetic) S.map.panTo(fix.lat, fix.lng, Math.max(S.map.map.getZoom(), 16));
  else if (synthetic) S.map.panTo(fix.lat, fix.lng, Math.max(S.map.map.getZoom(), 15));
  const g = accuracyGrade(fix.accuracy);
  setGps(g, g === 'good' ? `GPS ±${Math.round(fix.accuracy)} m` : g === 'fuzzy' ? `GPS ±${Math.round(fix.accuracy)} m · a bit fuzzy` : `GPS ±${Math.round(fix.accuracy)} m · too fuzzy to call it`);
  $('#relocate').hidden = false;
  renderHere(); renderClaimButton();
}
function setGps(grade, text) { const el = $('#gps'); el.className = 'g ' + grade; el.textContent = text; }

// ---------------------------------------------------------------- dock
const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
function renderHere() {
  const eyebrow = $('#here-eyebrow'), name = $('#here-name'), status = $('#here-status');
  if (S.backendDown && !S.board && !S.pos) { setHtml(eyebrow, 'Your block'); setHtml(name, 'Where are you?'); setHtml(status, esc(explain(S.backendDown))); return; }
  if (!S.pos) { eyebrow.textContent = 'Your block'; name.textContent = 'Where are you?'; status.innerHTML = 'Tap <b>Find me</b> and we’ll work out which block you’re standing in.'; return; }
  if (!S.hereId) { eyebrow.textContent = 'Off the board'; name.textContent = 'Not a block'; status.textContent = 'Dibs covers Burlington, Winooski and the edges. Head back toward town.'; return; }
  const h = S.byId.get(S.hereId); const hold = holdOf(S.hereId); const now = Date.now();
  if (S.backendDown && !S.board) { setHtml(eyebrow, `You’re in <span class="tag">${HOOD_NAME[h.hood] || h.hood}</span>`); setHtml(name, `${esc(h.name)}${h.lm ? '<span class="lm">★</span>' : ''}`); setHtml(status, esc(explain(S.backendDown))); return; }
  setHtml(eyebrow, `You’re in <span class="tag">${HOOD_NAME[h.hood] || h.hood}</span>${h.lm ? '<span class="tag">Landmark · 3 pts/hr</span>' : ''}${S.bounty === h.id ? '<span class="tag">★ Today’s bounty</span>' : ''}`);
  setHtml(name, `${esc(h.name)}${h.lm ? '<span class="lm">★</span>' : ''}`);
  if (!hold) setHtml(status, `<span class="dot"></span>Nobody’s called it. <b>First tracks +${RULES.freshPts}.</b>`);
  else if (isMine(hold)) setHtml(status, `<span class="dot" style="--dotc:${CREW[hold.c]?.color}"></span>Yours since ${sinceText(hold.s, now)}. Warm for ${daysLeft(hold.t, now)}.`);
  else {
    const lockLeft = lockedUntil({ touched_at: hold.t }) - now;
    setHtml(status, `<span class="dot" style="--dotc:${CREW[hold.c]?.color}"></span>Held by <b>${esc(hold.n)}</b> · ${CREW[hold.c]?.short || ''} · since ${sinceText(hold.s, now)}${lockLeft > 0 ? ` · 🔒 ${Math.ceil(lockLeft / 60e3)} min` : ` · <b>take it +${RULES.takePts}</b>`}`);
  }
}
function daysLeft(touched, now) { const left = touched + RULES.coldDays * 86400e3 - now; const d = Math.round(left / 86400e3); return d >= 1 ? `${d} more day${d === 1 ? '' : 's'}` : `${Math.max(1, Math.round(left / 3600e3))} more hours`; }
function isStale() { return Boolean(S.pos) && Date.now() - S.fixAt > 120e3 && !DEMO && !qs.get('at'); }
function renderClaimButton() {
  const b = $('#claim'); b.classList.remove('quiet', 'busy'); b.disabled = false;
  if (S.busy) { b.textContent = 'Calling…'; b.classList.add('busy'); b.disabled = true; return; }
  if (!S.pos) { b.textContent = S.locating ? 'Finding you…' : 'Find me'; b.disabled = S.locating; return; }
  if (!S.hereId) { b.textContent = 'Off the board'; b.disabled = true; return; }
  const g = accuracyGrade(S.pos.accuracy);
  if (g === 'bad') { b.textContent = 'Step outside for GPS'; b.disabled = true; return; }
  if (isStale()) { b.textContent = 'Re-find me'; b.classList.add('quiet'); return; }
  const hold = holdOf(S.hereId);
  if (isMine(hold)) { b.textContent = Date.now() - hold.t < RULES.refreshHours * 3600e3 ? 'Still yours ✓' : 'Warm it up'; b.classList.add('quiet'); return; }
  if (hold && lockedUntil({ touched_at: hold.t }) > Date.now()) { b.textContent = `Locked · ${Math.ceil((lockedUntil({ touched_at: hold.t }) - Date.now()) / 60e3)} min`; b.disabled = true; return; }
  b.textContent = hold ? 'Take it' : 'Call dibs';
}
setInterval(() => {
  if (!S.pos) return;
  const age = Date.now() - S.fixAt; const stale = isStale();
  S.map.setMe(S.pos, stale);
  if (stale) setGps('fuzzy', `GPS ±${Math.round(S.pos.accuracy)} m · ${Math.round(age / 60e3)} min old — tap Re-find me`);
  renderHere(); renderClaimButton();
}, 15e3);

// ---------------------------------------------------------------- claim
async function onClaimButton() {
  if (!S.pos || isStale()) { startLocating(true); return; }
  if (!S.hereId || S.busy) return;
  if (!S.name || !S.crew) { openWelcome(true); return; }
  await claim(S.hereId);
}
async function claim(id) {
  S.busy = true; renderClaimButton();
  try {
    const r = await api.rpc('dibs_claim', { p_token: TOKEN, p_hex: id, p_name: S.name, p_crew: S.crew, p_acc: Math.round(S.pos?.accuracy || 0) });
    S.lastClaimAt = Date.now();
    if (r.name && r.name !== S.name) { S.name = r.name; remember(S.name, S.crew); S.map.setMyName(S.name); } // the server's name is the name
    // update the local board immediately
    const now = Date.now(); const prev = holdOf(id);
    S.board ||= { hexes: [] };
    if (r.result === 'fresh' || r.result === 'took') S.board.hexes = (S.board.hexes || []).filter((h) => h.id !== id).concat([{ id, n: S.name, c: S.crew, s: now, t: now }]);
    else if (r.result === 'refreshed' && prev) prev.t = now;
    S.map.setBoard(S.board);
    if (r.bounty) { S.me = { ...(S.me || {}), bounty_done: true }; $('#bounty').classList.add('done'); }
    celebrate(r, prev);
    renderHere();
    if (navigator.vibrate) navigator.vibrate(r.result === 'took' ? [30, 40, 60] : 40);
  } catch (e) {
    toast(explain(e), 'bad');
    if (e.code === 'locked' || e.code === 'not_ready') refreshBoard();
  } finally { S.busy = false; renderClaimButton(); }
}
function celebrate(r, prev) {
  const h = r.hex; const crew = CREW[S.crew];
  let head = '', sub = '';
  if (r.result === 'fresh') { head = `+${r.pts} · ${h.name} is yours`; sub = prev ? 'It had gone cold. First tracks.' : 'First tracks. Nobody had called it.'; }
  else if (r.result === 'took') { head = `+${r.pts} · You took ${h.name}`; sub = r.from ? `from ${r.from}${r.from_crew ? ` (${CREW[r.from_crew]?.short})` : ''}. They’re locked out for 15 min.` : ''; }
  else if (r.result === 'refreshed') { head = `${h.name} stays yours`; sub = 'Warmed up for another week.'; }
  else { head = 'Still yours'; sub = 'Come back in an hour to warm it up.'; }
  if (r.bounty) sub = `★ Bounty +${RULES.bountyPts}! ` + sub;
  if (h.weight > 1 && (r.result === 'fresh' || r.result === 'took')) sub += ` Landmark: pays ${h.weight} pts an hour.`;
  toast(`${head}<small>${esc(sub)} · ${fmtPts(r.pts_month)} pts this month · ${r.held} held</small>`, 'big', 3600);
  if (r.result === 'fresh' || r.result === 'took') { S.map.flash(h.id, crew?.color); confetti(crew?.color); }
}

// ---------------------------------------------------------------- sheets
function sheet(id, html) { const d = $(id); d.querySelector('.panel').innerHTML = `<div class="grab"></div><button class="close" aria-label="Close">✕</button>${html}`; d.querySelector('.close').onclick = () => d.close(); if (!d.open) d.showModal(); return d; }

function openWelcome(forClaim = false) {
  const crewsHtml = CREWS.map((c) => `<button type="button" class="crew-btn${S.crew === c.code ? ' on' : ''}" data-crew="${c.code}" style="--c:${c.color}"><span class="sw"></span><span><b>${c.name}</b><small>${c.blurb}</small></span></button>`).join('');
  const d = sheet('#sheet-welcome', `
    <div class="welcome">
      <div class="hero">Burlington is <em>${S.hexes.length} blocks.</em><br>Stand in one. Tap. It’s yours.</div>
      <div class="steps">
        <div class="step"><span class="n">1</span><span><b>Go somewhere</b>Walk, run, bike. Open Dibs when you’re standing in a block.</span></div>
        <div class="step"><span class="n">2</span><span><b>Call dibs</b>Fresh block +${RULES.freshPts}. Someone else’s +${RULES.takePts}. Landmarks pay triple while you hold them.</span></div>
        <div class="step"><span class="n">3</span><span><b>Hold it</b>Every block pays you a point an hour until someone takes it back — or it goes cold after ${RULES.coldDays} days.</span></div>
      </div>
      <form id="onboard">
        <div class="field"><label for="nm">Your name on the map</label><input id="nm" name="nm" maxlength="${RULES.nameMax}" autocomplete="nickname" placeholder="Maya, Sam K, BikePathPete…" value="${esc(S.name)}" required></div>
        <div class="field"><label>Your crew — where’s home?</label><div class="crews">${crewsHtml}</div></div>
        <div class="err" id="onboard-err"></div>
        <button class="btn crew" type="submit">${forClaim ? 'Save and call dibs' : 'Find my block'}</button>
        <p class="meta">Your name shows on the blocks you hold and in the takes feed — that’s the game. Your coordinates never leave your phone; only the block does. No account, no email.</p>
      </form>
    </div>`);
  let crew = S.crew;
  d.querySelectorAll('.crew-btn').forEach((b) => b.addEventListener('click', () => { crew = b.dataset.crew; d.querySelectorAll('.crew-btn').forEach((x) => x.classList.toggle('on', x === b)); }));
  d.querySelector('#onboard').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = d.querySelector('#onboard-err');
    const v = validName(d.querySelector('#nm').value);
    if (!v.ok) { err.textContent = explain(v.error); return; }
    if (!crew) { err.textContent = 'Pick a crew — closest counts.'; return; }
    const btn = d.querySelector('.btn'); btn.disabled = true;
    try {
      await api.rpc('dibs_profile', { p_token: TOKEN, p_name: v.name, p_crew: crew });
    } catch (e2) {
      if (e2.code !== 'not_ready' && e2.code !== 'offline') { err.textContent = explain(e2); btn.disabled = false; return; }
      // back end not ready: keep going locally; claims will explain themselves
    }
    S.name = v.name; S.crew = crew; remember(S.name, S.crew); applyCrewTheme(); S.map.setMyName(S.name);
    store.set('dibs-welcomed', '1');
    d.close(); renderHere(); renderClaimButton();
    if (forClaim && S.hereId) claim(S.hereId); else if (!S.pos) startLocating(true);
  });
}

async function openStandings() {
  const d = sheet('#sheet-standings', `<h2>Standings</h2><p class="meta">This month · points reset on the 1st · blocks don’t.</p><div class="tabs"><button class="on" data-t="players">Players</button><button data-t="crews">Crews</button><button data-t="recent">Recent</button></div><div id="st-body"><div class="empty">Loading…</div></div>`);
  let data = null;
  try { data = await api.rpc('dibs_standings'); } catch (e) { d.querySelector('#st-body').innerHTML = `<div class="empty">${esc(explain(e))}</div>`; return; }
  const body = d.querySelector('#st-body'); const now = Date.now();
  const render = (t) => {
    if (t === 'players') {
      body.innerHTML = data.players.length ? `<ul class="list">${data.players.map((p, i) => `<li class="${p.name === S.name ? 'me' : ''}"><span class="rank">${i + 1}</span><span class="sw" style="--c:${CREW[p.crew]?.color}"></span><span class="name">${esc(p.name)}<small>${CREW[p.crew]?.short || ''}</small></span><span class="sub">${p.held} held</span><span class="num">${fmtPts(p.pts)}</span></li>`).join('')}</ul>` : '<div class="empty">Nobody has called dibs this month. Be first.</div>';
    } else if (t === 'crews') {
      const max = Math.max(1, ...data.crews.map((c) => c.held));
      body.innerHTML = `<ul class="list">${[...data.crews].sort((a, b) => b.held - a.held).map((c) => `<li><span class="sw" style="--c:${CREW[c.crew]?.color}"></span><span class="name">${CREW[c.crew]?.name}<small>${c.players} playing</small></span><span class="bar" style="--c:${CREW[c.crew]?.color}"><i style="width:${(100 * c.held) / max}%"></i></span><span class="num">${c.held}</span></li>`).join('')}</ul><h3>Home turf held</h3><ul class="list">${data.crews.map((c) => `<li><span class="sw" style="--c:${CREW[c.crew]?.color}"></span><span class="name">${CREW[c.crew]?.name}</span><span class="sub">${c.home_held} of ${c.home_total} home blocks</span><span class="num">${c.home_total ? Math.round((100 * c.home_held) / c.home_total) : 0}%</span></li>`).join('')}</ul>`;
    } else {
      body.innerHTML = data.recent.length ? `<ul class="list feed">${data.recent.map((r) => `<li class="tap" data-hex="${r.hex}">${r.kind === 'took' ? `<b>${esc(r.name)}</b> took <b>${esc(r.hex_name)}</b>${r.from ? ` from ${esc(r.from)}` : ''}` : `<b>${esc(r.name)}</b> called dibs on <b>${esc(r.hex_name)}</b>`} <span class="when">· ${sinceText(r.at, now)}</span></li>`).join('')}</ul>` : '<div class="empty">Quiet out there.</div>';
      body.querySelectorAll('[data-hex]').forEach((li) => li.addEventListener('click', () => { d.close(); S.map.flyTo(li.dataset.hex, 16); openHexSheet(li.dataset.hex); }));
    }
  };
  render('players');
  d.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { d.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); render(b.dataset.t); }));
}

async function openMe() {
  if (!S.name) { openWelcome(false); return; }
  const d = sheet('#sheet-me', `<h2>${esc(S.name)} <small class="meta">· ${CREW[S.crew]?.name || ''}</small></h2><div id="me-body"><div class="empty">Loading…</div></div>`);
  let me = null;
  try { me = await api.rpc('dibs_me', { p_token: TOKEN }); S.me = me; if (me.name && me.name !== S.name) { S.name = me.name; remember(S.name, S.crew); S.map.setMyName(S.name); d.querySelector('h2').firstChild.textContent = S.name + ' '; } } catch (e) { d.querySelector('#me-body').innerHTML = `<div class="empty">${esc(explain(e))}</div>${settingsHtml()}`; wireSettings(d); return; }
  const now = Date.now();
  const held = me.held || [];
  d.querySelector('#me-body').innerHTML = `
    <div class="stats"><div class="stat"><b>${fmtPts(me.pts || 0)}</b><span>pts this month</span></div><div class="stat"><b>${me.rank ? '#' + me.rank : '—'}</b><span>rank</span></div><div class="stat"><b>${held.length}</b><span>blocks held</span></div></div>
    <p class="meta">${me.takes_month || 0} take${me.takes_month === 1 ? '' : 's'} · ${me.lost_month || 0} lost · ${me.claims_today || 0} claims today · bounty ${me.bounty_done ? 'collected ★' : 'not yet'}</p>
    <h3>Your blocks</h3>
    ${held.length ? `<ul class="list">${held.map((h) => `<li class="tap" data-hex="${h.id}"><span class="sw" style="--c:${CREW[S.crew]?.color}"></span><span class="name">${esc(h.name)}${h.weight > 1 ? ' <span style="color:#E0A800">★</span>' : ''}<small>${HOOD_NAME[h.hood] || ''}</small></span><span class="sub">since ${sinceText(h.s, now)}</span></li>`).join('')}</ul>` : '<div class="empty">None yet. Go stand somewhere.</div>'}
    <button class="btn ghost" id="share">Share your turf</button>
    ${settingsHtml()}
    <h3>How it works</h3>
    <ul class="rules">
      <li><b>Call dibs</b> on the block you’re standing in. Fresh block +${RULES.freshPts}, someone else’s +${RULES.takePts}.</li>
      <li><b>Holding pays.</b> 1 pt an hour per block, landmarks (★) pay ${RULES.landmarkWeight} — up to ${RULES.maxHoldRate} an hour total, so nobody wins by hoarding.</li>
      <li><b>Today’s bounty</b> (★ pulsing on the map) pays +${RULES.bountyPts} to everyone who taps it today.</li>
      <li><b>Locks:</b> a fresh take can’t be stolen for ${RULES.lockMin} minutes. No ping-pong.</li>
      <li><b>Cold:</b> a block you haven’t touched in ${RULES.coldDays} days goes back to neutral. Re-tap to warm it.</li>
      <li><b>Monthly:</b> points reset on the 1st; the newsletter crowns the month. Blocks carry over.</li>
      <li><b>On foot or bike.</b> Claims that move faster than 12 m/s get bounced. Max 200 a day.</li>
    </ul>
    <p class="meta">Privacy: your phone works out the block; only the block’s id is sent, never your coordinates. Your name and crew show on the blocks you hold and in the recent-takes feed (rounded to 15 minutes) — that’s the game, so play under a name you’re happy to see on a map. No account; this browser is your identity (clear site data = new player). A Btown Brief game · <a href="https://www.btownbrief.com">btownbrief.com</a> · <a href="https://play.btownbrief.com/">more games</a></p>`;
  d.querySelectorAll('[data-hex]').forEach((li) => li.addEventListener('click', () => { d.close(); S.map.flyTo(li.dataset.hex, 16); openHexSheet(li.dataset.hex); }));
  d.querySelector('#share').addEventListener('click', () => share(me));
  wireSettings(d);
}
function settingsHtml() {
  return `<h3>Name & crew</h3><form id="settings"><div class="field"><input id="set-name" maxlength="${RULES.nameMax}" value="${esc(S.name)}" aria-label="Name"></div><div class="crews">${CREWS.map((c) => `<button type="button" class="crew-btn${S.crew === c.code ? ' on' : ''}" data-crew="${c.code}" style="--c:${c.color}"><span class="sw"></span><span><b>${c.name}</b></span></button>`).join('')}</div><div class="err" id="set-err"></div><button class="btn ghost" type="submit">Save</button></form>`;
}
function wireSettings(d) {
  let crew = S.crew;
  d.querySelectorAll('#settings .crew-btn').forEach((b) => b.addEventListener('click', () => { crew = b.dataset.crew; d.querySelectorAll('#settings .crew-btn').forEach((x) => x.classList.toggle('on', x === b)); }));
  d.querySelector('#settings').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = d.querySelector('#set-err');
    const v = validName(d.querySelector('#set-name').value); if (!v.ok) { err.textContent = explain(v.error); return; }
    try { await api.rpc('dibs_profile', { p_token: TOKEN, p_name: v.name, p_crew: crew }); }
    catch (e2) { if (e2.code !== 'not_ready' && e2.code !== 'offline') { err.textContent = explain(e2); return; } }
    S.name = v.name; S.crew = crew; remember(S.name, S.crew); applyCrewTheme(); S.map.setMyName(S.name);
    d.close(); toast('Saved.'); refreshBoard();
  });
}
function share(me) {
  const held = me?.held?.length || 0; const crew = CREW[S.crew]?.name || '';
  const text = held ? `I’m holding ${held} block${held === 1 ? '' : 's'} of Burlington for the ${crew} crew on Dibs. Come take them.` : `I’m playing Dibs — calling dibs on Burlington one block at a time. Come take mine.`;
  const url = 'https://play.btownbrief.com/dibs/';
  if (navigator.share) navigator.share({ title: 'Dibs', text, url }).catch(() => {});
  else { navigator.clipboard?.writeText(`${text} ${url}`); toast('Copied to clipboard.'); }
}

function openHexSheet(id) {
  const h = S.byId.get(id); if (!h) return;
  const hold = holdOf(id); const now = Date.now(); const here = S.hereId === id;
  const lockLeft = hold ? lockedUntil({ touched_at: hold.t }) - now : 0;
  const holderLine = !hold ? `Nobody’s called it. First tracks are worth +${RULES.freshPts}.`
    : isMine(hold) ? `Yours since ${sinceText(hold.s, now)} · warm for ${daysLeft(hold.t, now)}.`
    : `Held by <b>${esc(hold.n)}</b> (${CREW[hold.c]?.name || ''}) since ${sinceText(hold.s, now)}${lockLeft > 0 ? ` · 🔒 locked ${Math.ceil(lockLeft / 60e3)} min` : ''}.`;
  const d = sheet('#sheet-hex', `
    <h2>${esc(h.name)}${h.lm ? ' <span style="color:#E0A800">★</span>' : ''}</h2>
    <p class="meta">${HOOD_NAME[h.hood] || ''}${h.lm ? ` · Landmark · ${RULES.landmarkWeight} pts/hr` : ' · 1 pt/hr'}${S.bounty === id ? ` · ★ Today’s bounty +${RULES.bountyPts}` : ''}</p>
    <p>${holderLine}</p>
    ${here ? `<button class="btn crew" id="hex-claim">${!hold ? 'Call dibs' : isMine(hold) ? 'Warm it up' : lockLeft > 0 ? 'Locked' : 'Take it'}</button>` : `<p class="meta">${S.pos ? `You’re ${distanceText(id)} away. Go stand in it.` : 'Find yourself on the map to claim blocks.'}</p>`}`);
  const b = d.querySelector('#hex-claim'); if (b) b.addEventListener('click', () => { d.close(); onClaimButton(); });
}
function distanceText(id) { const c = centerLatLng(parseId(id)); const m = Math.round(haversine(S.pos.lat, S.pos.lng, c.lat, c.lng)); return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }
function haversine(lat1, lon1, lat2, lon2) { const toR = (d) => (d * Math.PI) / 180, R = 6371000; const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }

// ---------------------------------------------------------------- bits
let toastTimer = null;
function toast(html, kind = '', ms = 2600) { const t = $('#toast'); t.className = 'toast ' + kind; t.innerHTML = html; requestAnimationFrame(() => t.classList.add('show')); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function showHint(text) { const h = $('#hint'); h.textContent = text; h.hidden = false; setTimeout(() => { h.hidden = true; }, 6000); }
function confetti(color) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti'); const colors = [color || '#2E7D8A', '#FBF8F2', '#13243B', '#FFD166'];
  for (let i = 0; i < 36; i++) { const el = document.createElement('i'); el.style.left = `${Math.random() * 100}vw`; el.style.background = colors[i % colors.length]; el.style.animationDuration = `${1.2 + Math.random() * 1.2}s`; el.style.animationDelay = `${Math.random() * 0.3}s`; el.style.transform = `rotate(${Math.random() * 360}deg)`; box.appendChild(el); setTimeout(() => el.remove(), 2800); }
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

boot().catch((e) => { console.error(e); $('#here-status').textContent = 'Dibs could not start. Reload?'; });
