// Dibs — network layer. Raw fetch to Supabase RPCs (no client lib), device-token
// identity, and the `?demo=1` switch to the in-memory FakeBackend.
// The only identity is a 32-hex device token minted once into localStorage and
// stored server-side as a sha256 hash. New browser = new player. No accounts.
import { FakeBackend } from './fake-backend.js';

export const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';

const qs = new URLSearchParams(location.search);
export const DEMO = qs.get('demo') === '1';
export const TEST = qs.get('test') === '1' || DEMO;

export class NetError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}

const KEY = { token: 'dibs-token', name: 'dibs-name', crew: 'dibs-crew' };
export function token() {
  try {
    let t = localStorage.getItem(KEY.token);
    if (!t || !/^[a-f0-9]{32}$/.test(t)) {
      const b = new Uint8Array(16); crypto.getRandomValues(b);
      t = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY.token, t);
    }
    return t;
  } catch { return 'cafebabecafebabecafebabecafebabe'; }
}
export function remembered() {
  try { return { name: localStorage.getItem(KEY.name) || '', crew: localStorage.getItem(KEY.crew) || '' }; } catch { return { name: '', crew: '' }; }
}
export function remember(name, crew) {
  try { localStorage.setItem(KEY.name, name); localStorage.setItem(KEY.crew, crew); } catch { /* private mode */ }
}
/** localStorage that never throws (iOS "Block All Cookies", some webviews) */
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch { throw new NetError('offline'); }
  if (res.status === 404) throw new NetError('not_ready');
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    throw new NetError(/bad_token/.test(msg) ? 'bad_token' : 'server', { status: res.status, msg });
  }
  const body = await res.json();
  if (body && typeof body === 'object' && body.error) throw new NetError(body.error, body);
  return body;
}

let fake = null;
export function backend() {
  if (DEMO) { fake ||= new FakeBackend(); return fake; }
  return { rpc };
}

/** plain-language copy for every code the server or the browser can hand back */
export function explain(err) {
  const c = err?.code || err;
  switch (c) {
    case 'not_ready': return "Dibs isn't switched on yet — the board can't save claims until the back end is set up.";
    case 'offline': return "You're offline. Claims need a signal — try again when you've got bars.";
    case 'slow_down': return 'Easy — one claim every 20 seconds.';
    case 'too_fast': return "That's a long way from your last block in a short time. Dibs is a walking and biking game — no claiming from the car.";
    case 'daily_cap': return "That's 200 claims today. Go home, you've earned it.";
    case 'locked': return err?.holder ? `${err.holder} just took this one — it's locked for a few minutes.` : 'Someone just took this — locked for a few minutes.';
    case 'name_taken': return 'Someone already plays as that name. Pick another.';
    case 'bad_name': case 'name_short': case 'name_chars': return 'Names are 2–20 letters and numbers.';
    case 'bad_crew': return 'Pick a crew first.';
    case 'banned': return "This device has been benched. Email hello@btownbrief.com if that's a mistake.";
    case 'off_board': return "You're off the board — Dibs covers Burlington, Winooski, and the edges.";
    case 'bad_gps': return 'Your GPS fix is too fuzzy to tell which block you’re in. Step outside and re-find yourself.';
    case 'stale': return 'That location is a few minutes old — tap Re-find me first.';
    case 'bad_token': return 'Something is off with this browser. Clearing site data will give you a fresh start.';
    default: return "Something didn't save. Try again in a moment.";
  }
}
