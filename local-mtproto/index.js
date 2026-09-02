'use strict';

// DealVerse local MTProto listener.
//
// Runs on your laptop and stays connected to Telegram via your USER account
// (MTProto / GramJS). For every NEW message in your configured source channels
// it pushes {source, msgId, text, links} to the DealVerse Lambda ingest endpoint,
// which converts the Amazon/Flipkart links and posts them to your channel in real
// time. Keep this window open — it works as long as the process runs.
//
// Secrets: your api_hash, phone, password and the Telegram session live only in
// your local .env / .session file. Nothing sensitive is printed to the console.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');

const SESSION_FILE = process.env.SESSION_PATH || path.join(__dirname, '.session');

const cfg = {
  apiId: parseInt(process.env.TG_API_ID, 10),
  apiHash: (process.env.TG_API_HASH || '').trim(),
  phone: (process.env.TG_PHONE || '').trim(),
  base: (process.env.DEALVERSE_BASE_URL || '').replace(/\/+$/, ''),
  name: process.env.DEALVERSE_NAME || '',
  password: process.env.DEALVERSE_PASSWORD || '',
  sources: (process.env.SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean),
  extraSources: (process.env.EXTRA_SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean),
};

function ts() { return new Date().toLocaleTimeString(); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function maskPhone(p) {
  const s = String(p).replace(/[^\d+]/g, '');
  return s.length > 4 ? `${s.slice(0, 3)}••••${s.slice(-2)}` : '••';
}

// ── Live dashboard (self-contained: Node http + Server-Sent Events) ──────────
const UI_PORT = parseInt(process.env.LOCAL_UI_PORT || '4600', 10);
const feed = [];              // recent feed events (capped)
const sseClients = new Set(); // connected browser streams
const status = { connected: false, account: null, sources: [], startedAt: null };

function sse(res, obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } }
function pushEvent(ev) {
  const e = { t: Date.now(), ...ev };
  feed.push(e); if (feed.length > 300) feed.shift();
  for (const res of sseClients) sse(res, e);
}
function broadcastStatus() { for (const res of sseClients) sse(res, { type: 'status', status }); }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>DealVerse Local Listener</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#070a12;--card:#0e1424;--card2:#121a2e;--ink:#eaf1fb;--muted:#7e8ba3;--cyan:#22d3ee;--good:#34d399;--red:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,Segoe UI,Roboto,sans-serif}
header{padding:14px 20px;border-bottom:1px solid #1c2740;display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--card)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--red)}.dot.on{background:var(--good);box-shadow:0 0 8px var(--good)}
h1{font-size:1rem;margin:0}.badge{font-size:.72rem;padding:3px 10px;border-radius:999px;background:var(--card2);border:1px solid #1c2740;color:var(--muted)}
.sub{color:var(--muted);font-size:.82rem;width:100%}
main{padding:16px 20px;max-width:920px;margin:0 auto}
.row{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border:1px solid #1c2740;border-radius:10px;margin-bottom:8px;background:var(--card)}
.time{color:var(--muted);font-size:.74rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.chan{color:var(--cyan);font-weight:600}.sent{color:var(--good)}.err{color:var(--red)}.small{font-size:.8rem;color:var(--muted)}
.txt{font-size:.9rem;word-break:break-word;margin-top:2px}.empty{color:var(--muted);text-align:center;padding:44px}
</style></head><body>
<header><span class="dot" id="dot"></span><h1>DealVerse — Local Listener</h1>
<span class="badge" id="acct">connecting…</span><span class="badge" id="watch">watching 0</span>
<div class="sub" id="sub"></div></header>
<main><div id="feed"><div class="empty">Waiting for messages… post a deal in a watched channel and it appears here.</div></div></main>
<script>
const feed=document.getElementById('feed'),dot=document.getElementById('dot'),acct=document.getElementById('acct'),watch=document.getElementById('watch'),sub=document.getElementById('sub');
const fmt=t=>new Date(t).toLocaleTimeString(),esc=s=>(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));let first=true;
function render(e){if(first){feed.innerHTML='';first=false}const d=document.createElement('div');d.className='row';
 if(e.type==='message')d.innerHTML='<span class="time">'+fmt(e.t)+'</span><div><div><span class="chan">@'+esc(e.channel)+'</span> <span class="small">msg '+e.msgId+' · '+e.links+' link(s)</span></div><div class="txt">'+(esc((e.text||'').slice(0,240))||'<span class=small>(no text)</span>')+'</div></div>';
 else if(e.type==='sent'){const ok=e.ok&&!e.error;d.innerHTML='<span class="time">'+fmt(e.t)+'</span><div class="'+(ok?'sent':'err')+'">➡ @'+esc(e.channel)+' msg '+e.msgId+' → '+(ok?'sent to Lambda ✓ (posted '+(e.posted||0)+', converted '+(e.converted||0)+(e.skipped?', '+e.skipped:'')+')':'error: '+esc(e.error||'unknown'))+'</div>'}
 else if(e.type==='error')d.innerHTML='<span class="time">'+fmt(e.t)+'</span><div class="err">⚠ '+esc(e.text)+'</div>';
 else d.innerHTML='<span class="time">'+fmt(e.t)+'</span><div class="small">'+esc(e.text||'')+'</div>';
 feed.prepend(d);while(feed.children.length>300)feed.removeChild(feed.lastChild)}
function applyStatus(s){dot.className='dot'+(s.connected?' on':'');acct.textContent=s.account||'…';watch.textContent='watching '+((s.sources||[]).length);sub.textContent=(s.sources||[]).length?('@'+s.sources.join(', @')):''}
const ev=new EventSource('/events');
ev.onmessage=m=>{const d=JSON.parse(m.data);if(d.type==='snapshot'){applyStatus(d.status);(d.feed||[]).forEach(render);return}if(d.type==='status'){applyStatus(d.status);return}render(d)};
</script></body></html>`;

function startUiServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' ) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      sse(res, { type: 'snapshot', status, feed });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(UI_PORT, '127.0.0.1', () => log(`Dashboard: http://localhost:${UI_PORT}  (open it in a browser)`));
}

// ── DealVerse admin API (token auth; auto-relogin on expiry) ─────────────────
let token = null;
async function adminLogin() {
  const res = await fetch(`${cfg.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: cfg.name, password: cfg.password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(`DealVerse login failed: ${data.error || res.status}`);
  token = data.token;
  log('DealVerse admin: logged in ✓');
}
async function adminGet(pathname) {
  let res = await fetch(`${cfg.base}/${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { await adminLogin(); res = await fetch(`${cfg.base}/${pathname}`, { headers: { Authorization: `Bearer ${token}` } }); }
  return res.json();
}
async function pushIngest(payload) {
  const doPost = () => fetch(`${cfg.base}/api/admin/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  let res = await doPost();
  if (res.status === 401) { await adminLogin(); res = await doPost(); }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Pull every URL out of a GramJS message: plain text, hidden text_url entities,
// and inline-button URLs.
function extractLinks(msg) {
  const out = [];
  const text = (msg && msg.message) || '';
  for (const m of text.matchAll(/https?:\/\/[^\s]+/gi)) out.push(m[0]);
  for (const e of (msg && msg.entities) || []) if (e && e.url) out.push(e.url);
  const rows = (msg && msg.replyMarkup && msg.replyMarkup.rows) || [];
  for (const row of rows) for (const b of (row && row.buttons) || []) if (b && b.url) out.push(b.url);
  return out;
}

const seen = new Set(); // local de-dup: "chatId:msgId"

// Telegram marks channel ids as -100<id> and basic-group ids as -<id> in message
// peers, but getEntity(...).id is the bare positive id. Normalize both sides so
// incoming messages match our resolved sources regardless of format.
function bareId(id) {
  return String(id == null ? '' : id).replace(/^-100/, '').replace(/^-/, '');
}

async function main() {
  if (!cfg.base || !cfg.name || !cfg.password) {
    console.error('Missing DEALVERSE_BASE_URL / DEALVERSE_NAME / DEALVERSE_PASSWORD in .env'); process.exit(1);
  }
  // TG_API_ID/HASH/PHONE are OPTIONAL: if omitted, we reuse the account already
  // logged in via the DealVerse "Telegram login" tab (fetched securely below).

  startUiServer();
  await adminLogin();
  pushEvent({ type: 'log', text: 'DealVerse admin: logged in ✓' });

  // Which channels to watch: explicit SOURCES (override), else the admin panel's
  // listeners — PLUS any EXTRA_SOURCES that are local-listener-only (not in the panel).
  let sourceUsernames = cfg.sources;
  if (!sourceUsernames.length) {
    const data = await adminGet('api/admin/listener');
    sourceUsernames = (data.listeners || []).map((l) => l.username).filter(Boolean);
  }
  const norm = (u) => String(u).replace(/^@/, '').replace(/^https?:\/\/t\.me\/(?:s\/)?/i, '').toLowerCase();
  const dedup = new Set();
  sourceUsernames = [...sourceUsernames, ...cfg.extraSources].filter((u) => {
    const n = norm(u);
    if (!n || dedup.has(n)) return false;
    dedup.add(n);
    return true;
  });
  if (!sourceUsernames.length) {
    console.error('No sources found. Add listener channels in the admin panel, or set SOURCES / EXTRA_SOURCES in .env.'); process.exit(1);
  }

  // Resolve api creds + session. Priority: .env (TG_SESSION / TG_API_*), then a
  // locally cached session, then REUSE the account logged in via the admin panel.
  let apiId = cfg.apiId;
  let apiHash = cfg.apiHash;
  let session = (process.env.TG_SESSION || '').trim() || (fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '');
  let reused = false;
  if (!apiId || !apiHash || !session) {
    try {
      const s = await adminGet('api/admin/mtproto/session');
      if (s && s.session) {
        apiId = apiId || parseInt(s.apiId, 10);
        apiHash = apiHash || s.apiHash;
        if (!session) { session = s.session; reused = true; }
        log('Reusing the Telegram account from the DealVerse "Telegram login" tab ✓');
      }
    } catch { /* not logged in there — fall through to a phone login */ }
  }
  if (!apiId || !apiHash) {
    console.error('No Telegram api_id/api_hash. Either log in via the admin "Telegram login" tab, or set TG_API_ID/TG_API_HASH (+TG_PHONE) in .env.');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(session || ''), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  try { client.setLogLevel('none'); } catch { /* ignore */ }

  if (session) {
    await client.connect();
    try { await client.getMe(); } catch { log('Stored session is not valid — doing a phone login.'); session = ''; }
  }
  if (!session) {
    if (!cfg.phone) { console.error('Need a phone login: set TG_PHONE (+TG_API_ID/HASH) in .env, or log in via the admin panel.'); process.exit(1); }
    await client.start({
      phoneNumber: async () => cfg.phone,
      phoneCode: async () => await input.text('Enter the Telegram login code: '),
      password: async () => await input.text('Enter your 2FA password (leave blank if none): '),
      onError: (e) => console.error('Login error:', (e && e.message) || e),
    });
    fs.writeFileSync(SESSION_FILE, client.session.save()); // cache our own session
  }

  const me = await client.getMe();
  const account = me.username ? '@' + me.username : (me.firstName || 'user');
  status.account = account;
  status.connected = true;
  broadcastStatus();
  log(`Connected to Telegram ✓  Logged in as: ${account}${reused ? ' (reused from admin login)' : (cfg.phone ? ` (${maskPhone(cfg.phone)})` : '')}`);
  pushEvent({ type: 'log', text: `Connected to Telegram ✓ as ${account}${reused ? ' (reused from admin login)' : ''}` });

  // Resolve each source to its chat id so we can match incoming messages.
  const chatMap = new Map(); // chatId -> { username, title }
  for (const u of sourceUsernames) {
    const uname = String(u).replace(/^@/, '').replace(/^https?:\/\/t\.me\/(?:s\/)?/i, '');
    try {
      const ent = await client.getEntity(uname);
      // Subscribe so Telegram actually pushes this channel's new posts to us.
      // (Real-time updates only arrive for channels the account has JOINED.)
      let joined = 'already a member';
      try {
        await client.invoke(new Api.channels.JoinChannel({ channel: ent }));
        joined = 'joined';
      } catch (je) {
        const m = String((je && (je.errorMessage || je.message)) || '').toUpperCase();
        if (m.includes('ALREADY') || m.includes('USER_ALREADY_PARTICIPANT')) joined = 'already a member';
        else if (m.includes('INVITE') || m.includes('PRIVATE') || m.includes('ADMIN')) joined = 'private — must already be a member';
        else joined = `join skipped (${(je && je.errorMessage) || 'ok'})`;
      }
      chatMap.set(bareId(ent.id), { username: uname, title: ent.title || uname });
      status.sources.push(uname);
      broadcastStatus();
      log(`  monitoring @${uname} ✓ (${joined})`);
    } catch (e) {
      log(`  ⚠ could not resolve @${uname}: ${(e && e.message) || e} (is this account a member?)`);
    }
  }
  if (!chatMap.size) { console.error('No sources resolved. Exiting.'); process.exit(1); }

  const handler = async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const rawId = event.chatId != null ? event.chatId : (msg.chatId != null ? msg.chatId : '');
      const chatId = bareId(rawId);
      const meta = chatMap.get(chatId);
      if (process.env.DEBUG) log(`[debug] update from chat raw=${rawId} bare=${chatId} → ${meta ? 'MATCH @' + meta.username : 'ignore'} (msg ${msg.id})`);
      if (!meta) return; // message from a chat we're not watching
      const key = `${chatId}:${msg.id}`;
      if (seen.has(key)) return;
      seen.add(key);

      const text = msg.message || '';
      const links = extractLinks(msg);
      log(`New message in @${meta.username} (msg ${msg.id})${links.length ? ` · ${links.length} link(s)` : ''}`);
      pushEvent({ type: 'message', channel: meta.username, msgId: msg.id, links: links.length, text });

      // DRY_RUN=1 verifies listening without pushing to the Lambda (nothing posts).
      if (process.env.DRY_RUN) {
        log('  (dry-run) received OK — not sending to Lambda');
        pushEvent({ type: 'sent', channel: meta.username, msgId: msg.id, ok: true, posted: 0, converted: 0, skipped: 'dry-run' });
        return;
      }

      const { ok, data } = await pushIngest({
        sourceChatId: chatId,
        sourceUsername: meta.username,
        sourceTitle: meta.title,
        msgId: msg.id,
        text,
        links,
      });
      if (ok) {
        log(`  → sent to DealVerse ✓ (posted ${data.posted ?? 0}, converted ${data.converted ?? 0}${data.skipped ? `, ${data.skipped}` : ''})`);
      } else {
        log('  → ingest error:', (data && data.error) || 'unknown');
      }
      pushEvent({
        type: 'sent', channel: meta.username, msgId: msg.id, ok,
        posted: data && data.posted, converted: data && data.converted, skipped: data && data.skipped,
        error: ok ? null : ((data && data.error) || 'unknown'),
      });
    } catch (e) {
      log('handler error:', (e && e.message) || e);
    }
  };
  // Prime the update state so Telegram starts streaming channel updates to us.
  try { await client.getDialogs({ limit: 10 }); } catch { /* best-effort */ }
  client.addEventHandler(handler, new NewMessage({}));

  status.startedAt = Date.now();
  broadcastStatus();
  log(`Listener started ✓  Watching ${chatMap.size} source(s). Keep this window open. Ctrl+C to stop.`);
  pushEvent({ type: 'log', text: `Listener started ✓ — watching ${chatMap.size} source(s)` });

  // Visibility + safety net for dropped connections (GramJS also auto-reconnects).
  setInterval(async () => {
    try {
      if (!client.connected) {
        status.connected = false; broadcastStatus();
        log('⚠ connection dropped — reconnecting…');
        pushEvent({ type: 'error', text: 'connection dropped — reconnecting…' });
        await client.connect();
        status.connected = true; broadcastStatus();
        log('reconnected ✓');
        pushEvent({ type: 'log', text: 'reconnected ✓' });
      }
    } catch (e) {
      log('reconnect attempt failed:', (e && e.message) || e);
      pushEvent({ type: 'error', text: 'reconnect failed: ' + ((e && e.message) || e) });
    }
  }, 30000);
}

// Exit on any unrecoverable error so the process manager (pm2 / Docker
// restart:unless-stopped) restarts us cleanly instead of hanging in a bad state.
// Transient connection drops are handled by the reconnect loop, not here.
process.on('uncaughtException', (e) => { console.error('Fatal (uncaught):', (e && e.message) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('Fatal (unhandledRejection):', (e && e.message) || e); process.exit(1); });

main().catch((e) => { console.error('Fatal:', (e && e.message) || e); process.exit(1); });
