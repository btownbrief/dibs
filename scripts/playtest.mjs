// Dibs — Playwright playtest. Serves the repo on an ephemeral port, runs the demo
// backend (`?demo=1`, nothing saved), mocks geolocation, drives the whole flow and
// screenshots each step. Fails on any console error.
//   NODE_PATH=<dir containing playwright> node scripts/playtest.mjs
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.OUT || path.join(ROOT, 'playtest-out'); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(0);
const BASE = `http://localhost:${srv.address().port}`;
const fails = []; const must = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`); };

const CHURCH = { latitude: 44.47875, longitude: -73.21268, accuracy: 12 };
const BATTERY = { latitude: 44.4812, longitude: -73.2209, accuracy: 12 };

const browser = await chromium.launch();
const errors = [];
async function page(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: CHURCH, ...ctxOpts });
  const pg = await ctx.newPage();
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  pg.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, pg };
}
const shot = (pg, n) => pg.screenshot({ path: path.join(OUT, n + '.png') });

// ---- 1. first visit: welcome → onboard → locate → claim
let { ctx, pg } = await page();
await pg.goto(`${BASE}/index.html?demo=1`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.board);
await pg.waitForTimeout(1500);
must(await pg.locator('#sheet-welcome[open]').count() === 1, 'welcome sheet opens on first visit');
await shot(pg, '01-welcome');
await pg.fill('#nm', 'Test Tess');
await pg.click('.crew-btn[data-crew="one"]');
await pg.click('#onboard .btn');
await pg.waitForTimeout(1200);
must(await pg.locator('#sheet-welcome[open]').count() === 0, 'welcome closes after save');
// demo: tap-to-move — stand on Church Street
await pg.evaluate(() => { window.__dibs.map.map.setView([44.47875, -73.21268], 16); return 1; });
await pg.waitForTimeout(400);
await pg.evaluate(() => { const m = window.__dibs.map.map; m.fire('click', { latlng: L.latLng(44.47875, -73.21268) }); return 1; });
await pg.waitForTimeout(800);
const hereName = await pg.textContent('#here-name');
must(/Church Street/.test(hereName), `dock shows the block I'm in (${hereName.trim()})`);
await shot(pg, '02-standing-on-church');
const btn1 = await pg.textContent('#claim');
must(/Call dibs|Take it/i.test(btn1), `claim button is live (${btn1.trim()})`);
await pg.click('#claim');
await pg.waitForTimeout(900);
const toast = await pg.textContent('#toast');
must(/Church Street/.test(toast) && /\+\d/.test(toast), `claim celebrates (${toast.replace(/\s+/g, ' ').trim().slice(0, 80)})`);
await shot(pg, '03-claimed');
must(/Still yours|Warm it up/.test(await pg.textContent('#claim')), 'button flips to Still yours');
// move to Battery Park and take it (fresh or steal)
await pg.evaluate(() => { const m = window.__dibs.map.map; m.fire('click', { latlng: L.latLng(44.4812, -73.2209) }); return 1; });
await pg.waitForTimeout(600);
must(/Battery Park/.test(await pg.textContent('#here-name')), 'moved to Battery Park');
await pg.click('#claim'); await pg.waitForTimeout(500);
must(/Easy — one claim every 20 seconds/.test(await pg.textContent('#toast')), 'second claim within 20 s is rate-limited with plain copy');
await shot(pg, '04-cooldown');
// hex sheet via the standings feed (a real UI path; canvas hit-testing is covered by the manual field test)
await pg.click('#btn-standings'); await pg.waitForTimeout(700);
must(await pg.locator('#sheet-standings[open]').count() === 1, 'standings opens');
must((await pg.locator('#st-body .list li').count()) >= 10, 'players tab lists demo players');
await shot(pg, '05-standings-players');
await pg.click('.tabs button[data-t="crews"]'); await pg.waitForTimeout(300);
must((await pg.locator('#st-body .list li').count()) >= 7, 'crews tab renders 7 crews');
await shot(pg, '06-standings-crews');
await pg.click('.tabs button[data-t="recent"]'); await pg.waitForTimeout(300);
const feedN = await pg.locator('#st-body .feed li').count();
must(feedN >= 1, `recent feed has entries (${feedN})`);
await shot(pg, '07-standings-recent');
await pg.locator('#st-body .feed li').first().click(); await pg.waitForTimeout(1200);
must(await pg.locator('#sheet-hex[open]').count() === 1, 'tapping a feed row opens that block');
await shot(pg, '08-hex-sheet');
await pg.locator('#sheet-hex .close').click(); await pg.waitForTimeout(300);
// me sheet
await pg.click('#btn-me'); await pg.waitForTimeout(700);
must(await pg.locator('#sheet-me[open]').count() === 1, 'me sheet opens');
must(/Test Tess/.test(await pg.textContent('#sheet-me h2')), 'me sheet shows my name');
must((await pg.locator('#sheet-me .list li').count()) >= 1, 'me sheet lists my block(s)');
await shot(pg, '09-me');
// rename through settings
await pg.fill('#set-name', 'Tess Two'); await pg.click('#settings .crew-btn[data-crew="southend"]'); await pg.click('#settings .btn'); await pg.waitForTimeout(600);
must(await pg.locator('#sheet-me[open]').count() === 0, 'settings save closes the sheet');
must(await pg.evaluate(() => window.__dibs.name === 'Tess Two' && window.__dibs.crew === 'southend'), 'name + crew updated in state');
// bounty pill flies to bounty
await pg.click('#bounty'); await pg.waitForTimeout(1200);
must(await pg.locator('#sheet-hex[open]').count() === 1, 'bounty pill opens the bounty block');
must(/bounty/i.test(await pg.textContent('#sheet-hex .panel')), 'bounty sheet mentions the bounty');
await shot(pg, '10-bounty');
await pg.locator('#sheet-hex .close').click();
// off the board
await pg.evaluate(() => { const m = window.__dibs.map.map; m.fire('click', { latlng: L.latLng(44.46, -73.30) }); return 1; });
await pg.waitForTimeout(500);
must(/Off the board/i.test(await pg.textContent('#claim')), 'standing in the lake = off the board');
await shot(pg, '11-off-board');
await ctx.close();

// ---- 2. real geolocation path (mocked by Playwright), name remembered → no welcome
({ ctx, pg } = await page({ geolocation: BATTERY }));
await pg.addInitScript(() => { localStorage.setItem('dibs-welcomed', '1'); localStorage.setItem('dibs-name', 'Geo Gus'); localStorage.setItem('dibs-crew', 'downtown'); });
await pg.goto(`${BASE}/index.html?demo=1`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.board);
await pg.click('#claim'); // Find me
await pg.waitForTimeout(1500);
const gpsText = await pg.textContent('#gps');
must(/GPS ±\d+ m/.test(gpsText), `geolocation adopted (${gpsText})`);
must(/Battery Park/.test(await pg.textContent('#here-name')), 'real fix lands on Battery Park');
await shot(pg, '12-geo-battery');
await pg.click('#claim'); await pg.waitForTimeout(900);
must(/Battery Park/.test(await pg.textContent('#toast')), 'claimed via real geolocation');
// walk to Church Street: update geolocation
await ctx.setGeolocation(CHURCH); await pg.waitForTimeout(2500);
must(/Church Street/.test(await pg.textContent('#here-name')), 'watchPosition follows me to Church Street');
await shot(pg, '13-geo-walked');
await ctx.close();

// ---- 3. fuzzy + bad accuracy
({ ctx, pg } = await page({ geolocation: { ...CHURCH, accuracy: 400 } }));
await pg.addInitScript(() => { localStorage.setItem('dibs-welcomed', '1'); localStorage.setItem('dibs-name', 'Fuzzy Fred'); localStorage.setItem('dibs-crew', 'hill'); });
await pg.goto(`${BASE}/index.html?demo=1`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.board);
await pg.click('#claim'); await pg.waitForTimeout(8000); // best-of window expires, adopts the 400 m fix
must(/Step outside/.test(await pg.textContent('#claim')), `bad accuracy disables claiming (${(await pg.textContent('#claim')).trim()})`);
await shot(pg, '14-bad-gps');
await ctx.close();

// ---- 4. denied permission
({ ctx, pg } = await page({ permissions: [] }));
await pg.addInitScript(() => { localStorage.setItem('dibs-welcomed', '1'); localStorage.setItem('dibs-name', 'No Nate'); localStorage.setItem('dibs-crew', 'nne'); });
await pg.goto(`${BASE}/index.html?demo=1`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.board);
await pg.click('#claim'); await pg.waitForTimeout(1500);
must(/Location is off/.test(await pg.textContent('#gps')), 'denied permission explains itself');
await shot(pg, '15-denied');
await ctx.close();

// ---- 5. desktop + dark
({ ctx, pg } = await page({ viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false, colorScheme: 'dark' }));
await pg.goto(`${BASE}/index.html?demo=1&at=uvm`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.board);
await pg.waitForTimeout(1800);
must(/UVM Green|University/.test(await pg.textContent('#here-name')), `?at=uvm lands on the Green (${(await pg.textContent('#here-name')).trim()})`);
await shot(pg, '16-desktop-dark');
await ctx.close();

// ---- 6. no backend (not demo, Supabase unreachable) → fail soft
({ ctx, pg } = await page());
await pg.route('**/rest/v1/rpc/**', (r) => r.fulfill({ status: 404, body: '{}' }));
await pg.addInitScript(() => { localStorage.setItem('dibs-welcomed', '1'); localStorage.setItem('dibs-name', 'Off Olive'); localStorage.setItem('dibs-crew', 'flat'); });
await pg.goto(`${BASE}/index.html?test=1&at=church`);
await pg.waitForFunction(() => window.__dibs && window.__dibs.map);
await pg.waitForTimeout(1500);
must(/Church Street/.test(await pg.textContent('#here-name')), 'board renders from local data with no backend');
await pg.click('#claim'); await pg.waitForTimeout(800);
must(/isn.t switched on yet/.test(await pg.textContent('#toast')), 'claim without backend says not switched on');
await shot(pg, '17-no-backend');
await ctx.close();

await browser.close(); srv.close();
const realErrors = errors.filter((e) => !/404|Failed to load resource|net::ERR/.test(e));
must(realErrors.length === 0, `no console errors (${realErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${fails.length ? 'FAILED: ' + fails.length : 'ALL GOOD'} · screenshots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
