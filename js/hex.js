// Dibs — hex grid math. Pure: no DOM, no fetch, no Date.
// A flat-top hex grid laid over Burlington, VT in local metres.
// The phone turns lat/lng into a hex id HERE; only the id leaves the device.
// Mirrored by scripts/build-hexes.mjs (same module) — never fork this math.

export const ORIGIN = { lat: 44.48, lng: -73.21 };   // downtown Burlington
export const R = 115;                                 // circumradius in metres (~200 m across)
const M_PER_LAT = 110574;
const M_PER_LNG = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const SQ3 = Math.sqrt(3);

export function toXY(lat, lng) {
  return { x: (lng - ORIGIN.lng) * M_PER_LNG, y: (lat - ORIGIN.lat) * M_PER_LAT };
}
export function toLatLng(x, y) {
  return { lat: ORIGIN.lat + y / M_PER_LAT, lng: ORIGIN.lng + x / M_PER_LNG };
}

function cubeRound(q, r) {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq || 0, r: rr || 0 }; // "|| 0" turns -0 into 0 so ids are stable
}

/** lat/lng → axial hex {q,r} */
export function hexAt(lat, lng) {
  const { x, y } = toXY(lat, lng);
  const q = ((2 / 3) * x) / R;
  const r = ((-1 / 3) * x + (SQ3 / 3) * y) / R;
  return cubeRound(q, r);
}
export function hexId(h) { return `${h.q}_${h.r}`; }
export function parseId(id) {
  const m = /^(-?\d{1,3})_(-?\d{1,3})$/.exec(String(id || ''));
  return m ? { q: +m[1], r: +m[2] } : null;
}
export function isHexId(id) { return parseId(id) !== null; }
export function idAt(lat, lng) { return hexId(hexAt(lat, lng)); }

/** hex centre in metres */
export function centerXY(h) {
  return { x: R * 1.5 * h.q, y: R * ((SQ3 / 2) * h.q + SQ3 * h.r) };
}
export function centerLatLng(h) { const c = centerXY(h); return toLatLng(c.x, c.y); }

/** six corners as [lat,lng] pairs (Leaflet order) */
export function corners(h) {
  const c = centerXY(h);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const p = toLatLng(c.x + R * Math.cos(a), c.y + R * Math.sin(a));
    out.push([p.lat, p.lng]);
  }
  return out;
}
export function neighbors(h) {
  const d = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  return d.map(([dq, dr]) => ({ q: h.q + dq, r: h.r + dr }));
}
/** great-circle-ish distance between two hex centres, metres */
export function centerDistance(a, b) {
  const A = centerXY(a), B = centerXY(b);
  return Math.hypot(A.x - B.x, A.y - B.y);
}
export function haversineM(lat1, lon1, lat2, lon2) {
  const toR = (d) => (d * Math.PI) / 180, Rm = 6371000;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * Rm * Math.asin(Math.sqrt(a));
}
