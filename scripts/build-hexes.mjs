#!/usr/bin/env node
// Dibs — generate data/hexes.json + supabase/dibs-HEXES.sql from OpenStreetMap.
//
//   node scripts/build-hexes.mjs            # fetches from Overpass (cached in .cache/)
//   node scripts/build-hexes.mjs --offline  # cache only
//
// A hex is "in play" when it contains at least one road/path node AND its centre is
// inside Burlington, inside Winooski, or within BUFFER_M of Burlington's boundary.
// Names: curated landmark → OSM named place → the two busiest named streets.
// Re-running is safe: hex ids are pure geometry (js/hex.js); only names/hoods change.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { hexAt, hexId, centerLatLng, corners, parseId, R, ORIGIN, haversineM } from '../js/hex.js';

const BBOX = '44.43,-73.29,44.545,-73.15';
const BUFFER_M = 320;
const CACHE = new URL('../.cache/', import.meta.url).pathname;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OFFLINE = process.argv.includes('--offline');

const Q = {
  roads: `[out:json][timeout:100];(way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|cycleway|footway|path|service)$"](${BBOX}););out tags geom;`,
  hoods: `[out:json][timeout:100];(relation(id:16795692,16786350,16782840,16793235,16793202,17177091,1610005,199051,199071,199070);way(id:441359472,441087706,441088448););out geom;`,
  places: `[out:json][timeout:100];(way["leisure"~"^(park|nature_reserve|garden|playground|dog_park|golf_course|marina|beach_resort)$"]["name"](${BBOX});relation["leisure"~"^(park|nature_reserve)$"]["name"](${BBOX});way["natural"~"^(beach|wood)$"]["name"](${BBOX});way["amenity"~"^(university|college|school|hospital|library|townhall|marketplace|theatre|community_centre)$"]["name"](${BBOX});way["landuse"~"^(cemetery|farmland|recreation_ground)$"]["name"](${BBOX});way["tourism"~"^(museum|attraction|viewpoint|zoo|aquarium)$"]["name"](${BBOX});node["tourism"~"^(museum|attraction|viewpoint)$"]["name"](${BBOX});node["historic"~"^(monument|memorial)$"]["name"](${BBOX});way["shop"="mall"]["name"](${BBOX}););out tags center;`,
};

async function overpass(key) {
  mkdirSync(CACHE, { recursive: true });
  const file = CACHE + key + '.json';
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (OFFLINE) throw new Error(`no cache for ${key}`);
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(Q[key]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const text = await res.text();
      if (!res.ok || !text.startsWith('{')) throw new Error(`${res.status}`);
      writeFileSync(file, text);
      return JSON.parse(text);
    } catch (e) { console.error(`  ${key}: ${url} failed (${e.message}), trying next`); }
  }
  throw new Error(`all Overpass mirrors failed for ${key}`);
}

// ---- geometry helpers -------------------------------------------------------
function ringsOf(el) {
  if (el.type === 'way') return [el.geometry.map((p) => [p.lat, p.lon])];
  // relation: chain outer ways into closed rings
  const segs = (el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const rings = [];
  const key = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    while (grew && key(ring[0]) !== key(ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], tail = key(ring[ring.length - 1]);
        if (key(s[0]) === tail) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); grew = true; break; }
        if (key(s[s.length - 1]) === tail) { ring = ring.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); grew = true; break; }
      }
    }
    rings.push(ring);
  }
  return rings;
}
function inRings(lat, lng, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function distToRings(lat, lng, rings) {
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    // project in local metres
    const ax = (a[1] - lng) * 79000, ay = (a[0] - lat) * 110574, bx = (b[1] - lng) * 79000, by = (b[0] - lat) * 110574;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((-ax) * dx + (-ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ---- crews / hoods ----------------------------------------------------------
// hood codes → crew codes live in js/core.js; here we only tag hexes with a hood.
const HOOD_BY_REL = {
  16795692: 'downtown', 441359472: 'downtown',
  16786350: 'one', 441088448: 'one',
  16782840: 'nne',
  16793235: 'southend', 441087706: 'southend',
  16793202: 'hill', 17177091: 'hill', 1610005: 'hill',
  199051: 'winooski',
};
const HOOD_PRIORITY = ['441359472', '441087706', '441088448', '1610005', '16795692', '16786350', '16782840', '16793235', '16793202', '17177091', '199051'];
const HOOD_CENTROIDS = { downtown: [44.4787, -73.2140], one: [44.4855, -73.2120], nne: [44.5111, -73.2515], southend: [44.4608, -73.2119], hill: [44.4760, -73.2000], winooski: [44.4910, -73.1861] };

const STREET_WEIGHT = { primary: 6, secondary: 5, tertiary: 4, residential: 3, unclassified: 2, living_street: 2, pedestrian: 3, cycleway: 1.5, path: 0.5, footway: 0.4, service: 0.3 };
const IN_PLAY_CLASSES = new Set(Object.keys(STREET_WEIGHT));

function shortStreet(n) {
  return n.replace(/\bStreet\b/g, 'St').replace(/\bAvenue\b/g, 'Ave').replace(/\bRoad\b/g, 'Rd').replace(/\bDrive\b/g, 'Dr').replace(/\bLane\b/g, 'Ln').replace(/\bTerrace\b/g, 'Terr').replace(/\bPlace\b/g, 'Pl').replace(/\bCourt\b/g, 'Ct').replace(/\bBoulevard\b/g, 'Blvd').replace(/\bParkway\b/g, 'Pkwy').replace(/\bNorth\b/g, 'N.').replace(/\bSouth\b/g, 'S.').replace(/\bEast\b/g, 'E.').replace(/\bWest\b/g, 'W.').replace(/^N\. Avenue/, 'North Ave').replace(/^N\. Ave$/, 'North Ave').replace(/^S\. Ave$/, 'South Ave').replace(/^N\. St$/, 'North St');
}
const PLACE_PRIORITY = ['beach', 'park', 'nature_reserve', 'university', 'college', 'hospital', 'museum', 'library', 'townhall', 'theatre', 'attraction', 'viewpoint', 'monument', 'memorial', 'cemetery', 'marina', 'garden', 'playground', 'dog_park', 'golf_course', 'community_centre', 'school', 'farmland', 'recreation_ground', 'wood', 'mall', 'zoo', 'aquarium', 'beach_resort'];
function placeKind(t) { for (const k of ['leisure', 'natural', 'amenity', 'landuse', 'tourism', 'historic', 'shop']) if (t[k]) return t[k]; return 'x'; }

// ---- main -------------------------------------------------------------------
const [roads, hoods, places] = await Promise.all([overpass('roads'), overpass('hoods'), overpass('places')]);
const landmarks = JSON.parse(readFileSync(new URL('../data/landmarks.json', import.meta.url), 'utf8')).landmarks;

const polys = {};
for (const el of hoods.elements) polys[el.id] = ringsOf(el);
const burlington = polys[199071], winooski = polys[199051], sburl = polys[199070];
console.error(`Burlington rings: ${burlington.length} (${burlington.map((r) => r.length).join(',')} pts)`);

// bin road nodes
const cells = new Map(); // id → {streets: Map(name→score), any:boolean}
for (const w of roads.elements) {
  const cls = w.tags.highway; if (!IN_PLAY_CLASSES.has(cls)) continue;
  const name = w.tags.name; const wgt = STREET_WEIGHT[cls];
  for (const p of w.geometry || []) {
    const id = hexId(hexAt(p.lat, p.lon));
    let c = cells.get(id); if (!c) { c = { streets: new Map(), score: 0 }; cells.set(id, c); }
    c.score += wgt;
    if (name && name.length >= 4 && !/parking|driveway|alley|condominium|apartment|mobile home/i.test(name)) c.streets.set(name, (c.streets.get(name) || 0) + wgt);
  }
}
console.error(`${cells.size} hexes touch a road/path in the bbox`);

// place names per hex
const placeByHex = new Map();
for (const el of places.elements) {
  const t = el.tags || {}; const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon; if (lat == null) continue;
  const kind = placeKind(t); const pri = PLACE_PRIORITY.indexOf(kind); if (pri < 0) continue;
  const id = hexId(hexAt(lat, lon));
  const cur = placeByHex.get(id);
  if (!cur || pri < cur.pri) placeByHex.set(id, { name: t.name, pri });
}
const lmByHex = new Map();
for (const lm of landmarks) { const id = hexId(hexAt(lm.lat, lm.lng)); if (!lmByHex.has(id)) lmByHex.set(id, lm.name); else console.error(`  note: ${lm.name} shares a hex with ${lmByHex.get(id)}`); }

const out = [];
let inB = 0, inW = 0, buf = 0;
for (const [id, c] of cells) {
  const h = parseId(id); const ctr = centerLatLng(h);
  const insideB = inRings(ctr.lat, ctr.lng, burlington), insideW = inRings(ctr.lat, ctr.lng, winooski);
  let ok = insideB || insideW;
  if (!ok) { const d = distToRings(ctr.lat, ctr.lng, burlington); ok = d <= BUFFER_M; if (ok) buf++; }
  if (!ok) continue;
  if (insideB) inB++; else if (insideW) inW++;
  if (c.score < 1.5 && !lmByHex.has(id)) continue; // a lone driveway stub isn't a block
  // hood
  let hood = null;
  for (const rid of HOOD_PRIORITY) if (polys[rid] && inRings(ctr.lat, ctr.lng, polys[rid])) { hood = HOOD_BY_REL[rid]; break; }
  if (!hood) {
    if (insideB) { let best = Infinity; for (const [k, [la, lo]] of Object.entries(HOOD_CENTROIDS)) { if (k === 'winooski') continue; const d = haversineM(ctr.lat, ctr.lng, la, lo); if (d < best) { best = d; hood = k; } } }
    else if (insideW) hood = 'winooski';
    else hood = ctr.lat > 44.50 ? 'colchester' : 'sburl';
  }
  // name
  let name = lmByHex.get(id) || placeByHex.get(id)?.name || null;
  const streets = [...c.streets.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => shortStreet(n));
  if (!name) {
    if (streets.length >= 2) name = `${streets[0]} & ${streets[1]}`;
    else if (streets.length === 1) name = streets[0];
    else name = null;
  }
  out.push({ id, name, hood, lm: lmByHex.has(id) ? 1 : 0, streets: streets.slice(0, 3), ctr: [+ctr.lat.toFixed(5), +ctr.lng.toFixed(5)] });
}
console.error(`${out.length} hexes in play (Burlington ${inB}, Winooski ${inW}, buffer ${buf})`);

// nameless hexes: borrow the nearest named neighbour + "path"
const byId = new Map(out.map((h) => [h.id, h]));
for (const h of out) if (!h.name) {
  let best = null, bd = Infinity;
  for (const o of out) if (o.name && !/path$/.test(o.name)) { const d = haversineM(h.ctr[0], h.ctr[1], o.ctr[0], o.ctr[1]); if (d < bd) { bd = d; best = o; } }
  h.name = best ? `${best.name.replace(/ & .*/, '')} path` : 'Block ' + h.id;
}
// de-dupe identical names by appending the hood or a third street
const seen = new Map(); for (const h of out) seen.set(h.name, (seen.get(h.name) || 0) + 1);
for (const h of out) if (seen.get(h.name) > 1 && !h.lm) {
  const extra = h.streets.find((s) => !h.name.includes(s));
  if (extra) h.name = `${h.name.split(' & ')[0]} & ${extra}`;
}
// still-duplicate names (trail-only hexes mostly): suffix north→south so the feed can tell them apart
const groups = new Map(); for (const h of out) { if (h.lm) continue; (groups.get(h.name) || groups.set(h.name, []).get(h.name)).push(h); }
let suffixed = 0;
for (const [, g] of groups) if (g.length > 1) {
  g.sort((a, b) => b.ctr[0] - a.ctr[0] || a.ctr[1] - b.ctr[1]);
  if (g.length === 2) { g[0].name += ' (north)'; g[1].name += ' (south)'; }
  else g.forEach((h, i) => { h.name += ` · ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`; });
  suffixed += g.length;
}
const lmNames = new Set(out.filter((h) => h.lm).map((h) => h.name));
for (const h of out) if (!h.lm && lmNames.has(h.name)) h.name += ' (edge)';
const seen2 = new Map(); for (const h of out) seen2.set(h.name, (seen2.get(h.name) || 0) + 1);
const dupes = [...seen2.entries()].filter(([, n]) => n > 1);
console.error(`${suffixed} names suffixed; ${dupes.length} duplicate names remain: ${dupes.slice(0, 6).map(([n, k]) => `${n}×${k}`).join('; ')}`);

out.sort((a, b) => a.id.localeCompare(b.id));
const hoodsCount = {}; for (const h of out) hoodsCount[h.hood] = (hoodsCount[h.hood] || 0) + 1;
console.error('by hood:', hoodsCount, 'landmarks:', out.filter((h) => h.lm).length);

const data = { generated: new Date().toISOString().slice(0, 10), R, origin: ORIGIN, count: out.length, hexes: out.map(({ id, name, hood, lm }) => ({ id, name, hood, lm })) };
writeFileSync(new URL('../data/hexes.json', import.meta.url), JSON.stringify(data));
// debug file with centres/streets for eyeballing (not shipped)
writeFileSync(CACHE + 'hexes-debug.json', JSON.stringify(out, null, 1));

const esc = (s) => s.replace(/'/g, "''");
const sql = ['-- Generated by scripts/build-hexes.mjs — the playable board. Safe to re-run (upsert).',
  'insert into dibs_hexes (id, name, hood, weight) values',
  out.map((h) => `('${h.id}','${esc(h.name)}','${h.hood}',${h.lm ? 3 : 1})`).join(',\n'),
  'on conflict (id) do update set name = excluded.name, hood = excluded.hood, weight = excluded.weight;', ''].join('\n');
writeFileSync(new URL('../supabase/dibs-HEXES.sql', import.meta.url), sql);
console.error('wrote data/hexes.json + supabase/dibs-HEXES.sql');
