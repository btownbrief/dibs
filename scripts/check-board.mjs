// Shape check for data/hexes.json + that supabase/dibs-HEXES.sql matches it.
import { readFileSync } from 'node:fs';
import { isHexId } from '../js/hex.js';
const d = JSON.parse(readFileSync(new URL('../data/hexes.json', import.meta.url), 'utf8'));
const sql = readFileSync(new URL('../supabase/dibs-HEXES.sql', import.meta.url), 'utf8');
let bad = 0;
const seen = new Set();
for (const h of d.hexes) {
  if (!isHexId(h.id) || seen.has(h.id)) { console.error('bad/dup id', h.id); bad++; }
  seen.add(h.id);
  if (!h.name || h.name.length < 3 || h.name.length > 60) { console.error('bad name', h); bad++; }
  if (!['downtown', 'one', 'nne', 'southend', 'hill', 'winooski', 'sburl', 'colchester'].includes(h.hood)) { console.error('bad hood', h); bad++; }
  if (!sql.includes(`('${h.id}','${h.name.replace(/'/g, "''")}','${h.hood}',${h.lm ? 3 : 1})`)) { console.error('SQL seed out of sync for', h.id); bad++; }
}
if (d.count !== d.hexes.length) { console.error('count mismatch'); bad++; }
console.log(`${d.hexes.length} hexes, ${d.hexes.filter((h) => h.lm).length} landmarks, ${bad} problems`);
process.exit(bad ? 1 : 0);
