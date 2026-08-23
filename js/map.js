// Dibs — the map. Leaflet (vendored) + CARTO Positron tiles + one canvas polygon
// per hex. Tiles are never cached by the service worker (policy). Everything here
// is presentation: the rules live in core.js, the truth lives on the server.
/* global L */
import { parseId, corners, centerLatLng } from './hex.js';
import { CREW, RULES } from './core.js';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const BOARD_BOUNDS = L.latLngBounds([44.40, -73.33], [44.57, -73.12]);
const INK = '#13243B';

export function createMap(el, hexes, { dark = false } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 12, maxZoom: 18, maxBounds: BOARD_BOUNDS.pad(0.3), maxBoundsViscosity: 0.8, tap: false });
  L.tileLayer(dark ? TILES.dark : TILES.light, { attribution: ATTR, maxZoom: 18, subdomains: 'abcd', crossOrigin: true }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomright' });
  map.setView([44.4787, -73.2140], 14);

  const renderer = L.canvas({ padding: 0.6 });
  const byId = new Map(); const layers = new Map();
  let holds = new Map(); let myName = null; let bountyId = null; let hereId = null; let tapCb = null; let moveCb = null;
  const now = () => Date.now();

  function style(id) {
    const h = holds.get(id);
    if (!h) return { stroke: true, color: dark ? '#cbd5e1' : INK, weight: 0.6, opacity: dark ? 0.18 : 0.12, fill: true, fillColor: dark ? '#ffffff' : INK, fillOpacity: dark ? 0.03 : 0.025 };
    const crew = CREW[h.c] || CREW.flat; const mine = myName && h.n === myName;
    const locked = now() - h.t < RULES.lockMin * 60e3;
    return { stroke: true, color: mine ? (dark ? '#fff' : INK) : crew.color, weight: mine ? 2.5 : 1, opacity: mine ? 1 : 0.8,
      fill: true, fillColor: crew.color, fillOpacity: mine ? 0.6 : 0.42, dashArray: locked && !mine ? '5 4' : null, lineCap: 'round' };
  }

  const hexLayer = L.layerGroup().addTo(map);
  for (const h of hexes) {
    byId.set(h.id, h);
    const poly = L.polygon(corners(parseId(h.id)), { ...style(h.id), renderer, interactive: true, bubblingMouseEvents: false });
    poly.on('click', (e) => { L.DomEvent.stop(e); if (moveCb) moveCb(e.latlng); else if (tapCb) tapCb(h.id, e.latlng); });
    poly.addTo(hexLayer); layers.set(h.id, poly);
  }
  map.on('click', (e) => { if (moveCb) moveCb(e.latlng); });

  // landmarks: stars that appear when zoomed in
  const lmGroup = L.layerGroup();
  for (const h of hexes) if (h.lm) {
    const c = centerLatLng(parseId(h.id));
    L.marker([c.lat, c.lng], { icon: L.divIcon({ className: 'lm-icon', html: '★', iconSize: [14, 14] }), interactive: false, keyboard: false }).addTo(lmGroup);
  }
  const syncLm = () => { if (map.getZoom() >= 14) { if (!map.hasLayer(lmGroup)) lmGroup.addTo(map); } else if (map.hasLayer(lmGroup)) map.removeLayer(lmGroup); };
  map.on('zoomend', syncLm); syncLm();

  let bountyMarker = null;
  const hereOutline = L.polygon([], { color: dark ? '#fff' : INK, weight: 3, opacity: 0.95, fill: false, renderer, interactive: false }).addTo(map);
  const hereGlow = L.polygon([], { color: '#fff', weight: 7, opacity: dark ? 0.25 : 0.9, fill: false, renderer, interactive: false }).addTo(map);
  let meMarker = null, meCircle = null;

  return {
    map,
    setBoard(board) {
      holds = new Map((board?.hexes || []).map((h) => [h.id, h]));
      for (const [id, poly] of layers) poly.setStyle(style(id));
    },
    setMyName(n) { myName = n; for (const [id, poly] of layers) if (holds.has(id)) poly.setStyle(style(id)); },
    restyle(id) { const p = layers.get(id); if (p) p.setStyle(style(id)); },
    hold(id) { return holds.get(id) || null; },
    hex(id) { return byId.get(id) || null; },
    setHere(id) {
      hereId = id;
      const pts = id && byId.has(id) ? corners(parseId(id)) : [];
      hereOutline.setLatLngs(pts); hereGlow.setLatLngs(pts);
      if (pts.length) { hereGlow.bringToFront(); hereOutline.bringToFront(); }
    },
    setBounty(id) {
      bountyId = id;
      if (bountyMarker) { map.removeLayer(bountyMarker); bountyMarker = null; }
      if (id && byId.has(id)) {
        const c = centerLatLng(parseId(id));
        bountyMarker = L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: '<div class="bounty-icon"></div>', iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(map);
      }
    },
    setMe(pos, stale = false) {
      if (!pos) { if (meMarker) { map.removeLayer(meMarker); map.removeLayer(meCircle); meMarker = meCircle = null; } return; }
      const ll = [pos.lat, pos.lng];
      if (!meMarker) {
        meCircle = L.circle(ll, { radius: pos.accuracy || 0, color: '#2563EB', weight: 1, opacity: 0.5, fillColor: '#2563EB', fillOpacity: 0.08, interactive: false }).addTo(map);
        meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="me-icon${stale ? ' stale' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      } else {
        meMarker.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(pos.accuracy || 0);
        meMarker.getElement()?.firstElementChild?.classList.toggle('stale', stale);
      }
    },
    flyTo(id, zoom = 16) { const h = byId.get(id); if (!h) return; const c = centerLatLng(parseId(id)); map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), zoom), { duration: 0.8 }); },
    panTo(lat, lng, zoom) { map.flyTo([lat, lng], zoom ?? Math.max(map.getZoom(), 16), { duration: 0.8 }); },
    flash(id, color) {
      const h = byId.get(id); if (!h) return;
      const fx = L.polygon(corners(parseId(id)), { color: '#fff', weight: 3, fillColor: color || '#fff', fillOpacity: 0.95, renderer, interactive: false }).addTo(map);
      const t0 = performance.now();
      const tick = (t) => { const k = Math.min(1, (t - t0) / 800); fx.setStyle({ fillOpacity: 0.95 * (1 - k), opacity: 1 - k, weight: 3 + 6 * k }); if (k < 1) requestAnimationFrame(tick); else map.removeLayer(fx); };
      requestAnimationFrame(tick);
    },
    onHexTap(cb) { tapCb = cb; },
    setTapToMove(cb) { moveCb = cb; },
    fitBoard() { map.fitBounds(BOARD_BOUNDS.pad(-0.15)); },
    get hereId() { return hereId; }, get bountyId() { return bountyId; },
  };
}
