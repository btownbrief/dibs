#!/usr/bin/env node
// Print a newsletter-ready standings block from the live board.
//   node scripts/newsletter-block.mjs            (this month, live Supabase)
import { CREW } from '../js/core.js';
const URL = 'https://jnouvwxomrcffqwilqkq.supabase.co/rest/v1/rpc/dibs_standings';
const KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';
const res = await fetch(URL, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}' });
if (!res.ok) { console.error('standings not available:', res.status); process.exit(1); }
const s = await res.json();
const top = s.players.slice(0, 5);
const crews = [...s.crews].sort((a, b) => b.held - a.held);
const lead = crews[0];
console.log(`**Dibs — ${s.month}**`);
console.log(top.length ? top.map((p, i) => `${i + 1}. ${p.name} (${CREW[p.crew]?.short}) — ${Math.round(p.pts)} pts, ${p.held} blocks`).join('\n') : 'Nobody has called dibs yet this month.');
if (lead && lead.held) console.log(`\nCrew board: ${crews.filter((c) => c.held).map((c) => `${CREW[c.crew]?.name} ${c.held}`).join(' · ')}. ${CREW[lead.crew]?.name} holds ${Math.round((100 * lead.home_held) / Math.max(1, lead.home_total))}% of its own turf.`);
const r = s.recent[0]; if (r) console.log(`\nLatest: ${r.name} ${r.kind === 'took' ? `took ${r.hex_name} from ${r.from}` : `called dibs on ${r.hex_name}`}.`);
console.log('\nPlay: https://play.btownbrief.com/dibs/');
