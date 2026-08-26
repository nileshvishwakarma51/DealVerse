import React, { useEffect, useRef, useState } from 'react';

// API paths resolve relative to the current document (served under /<stage>/).
const api = (p) => new URL(p, document.baseURI).toString();
const TOKEN_KEY = 'dv_admin_token';
const stageBase = new URL('.', document.baseURI).pathname; // e.g. /prod/

function isAdminPath() {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/admin');
}
function navTo(view) {
  const p = view === 'admin' ? stageBase + 'admin' : stageBase + 'home';
  window.history.pushState({}, '', p);
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [view, setView] = useState(() => {
    if (isAdminPath()) return sessionStorage.getItem(TOKEN_KEY) ? 'admin' : 'login';
    return 'user';
  });

  useEffect(() => {
    const onPop = () => {
      if (isAdminPath()) setView(sessionStorage.getItem(TOKEN_KEY) ? 'admin' : 'login');
      else setView('user');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function goAdmin() {
    navTo('admin');
    setView(token ? 'admin' : 'login');
  }
  function goHome() {
    navTo('home');
    setView('user');
  }
  function onLoggedIn(t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    navTo('admin');
    setView('admin');
  }
  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    goHome();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={goHome} style={{ cursor: 'pointer' }}>
          <img src={new URL('dealverse.png', document.baseURI).toString()} alt="DealVerse" className="brand-logo" />
          <h1>DealVerse</h1>
        </div>
        {view === 'admin' ? (
          <button className="link" onClick={logout}>Log out</button>
        ) : (
          <button className="link" onClick={goAdmin}>Admin</button>
        )}
      </header>

      {view === 'user' && <UserPanel />}
      {view === 'login' && <LoginPanel onLoggedIn={onLoggedIn} onCancel={goHome} />}
      {view === 'admin' && <AdminPanel token={token} onUnauthorized={logout} />}
    </div>
  );
}

/* ─────────────────────────── User panel ─────────────────────────── */

function UserPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch(api('api/affiliate/generate-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not generate link.');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.affiliateUrl);
    setCopied(true);
  }

  return (
    <div className="card">
      <h2>Get an affiliate link</h2>
      <p className="subtitle">Paste an Amazon product link to get an affiliate link.</p>

      <label htmlFor="url">Product link</label>
      <input
        id="url"
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.amazon.in/dp/XXXXXXXXXX  or  https://amzn.in/d/xxxx"
      />

      <div className="row">
        <button onClick={generate} disabled={loading || url.trim() === ''}>
          {loading ? 'Generating…' : 'Generate Affiliate Link'}
        </button>
      </div>

      {error && <p className="status err">{error}</p>}

      {result && (
        <div className="result">
          {result.product && result.product.title && (
            <p className="product-title">{result.product.title}</p>
          )}
          {result.product && result.product.price && (
            <p className="meta">Price: {result.product.price}</p>
          )}
          <label>Affiliate link</label>
          <div className="row">
            <a href={result.affiliateUrl} target="_blank" rel="noreferrer" className="affiliate">
              {result.affiliateUrl}
            </a>
            <button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="meta">
            via {result.method === 'sitestripe' ? 'SiteStripe' : 'affiliate tag'}
            {result.fallback ? ' (fallback)' : ''}
            {result.asin ? ` · ASIN ${result.asin}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Login ─────────────────────────── */

function LoginPanel({ onLoggedIn, onCancel }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function login(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api('api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Login failed.');
      onLoggedIn(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card" onSubmit={login}>
      <h2>Admin login</h2>
      <p className="subtitle">Enter the admin password.</p>
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
      {error && <p className="status err">{error}</p>}
      <div className="row">
        <button type="submit" disabled={loading || secret === ''}>
          {loading ? 'Checking…' : 'Log in'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/* ─────────────────────────── Admin ─────────────────────────── */

function makeAuth(token, onUnauthorized) {
  return async (p, opts = {}) => {
    const res = await fetch(api(p), {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      onUnauthorized();
      throw new Error('Session expired.');
    }
    return res;
  };
}

function AdminPanel({ token, onUnauthorized }) {
  const authFetch = useRef(makeAuth(token, onUnauthorized)).current;
  return (
    <>
      <Collapsible title="Amazon affiliate config">
        <AmazonConfig authFetch={authFetch} />
      </Collapsible>
      <Collapsible title="Telegram bot">
        <TelegramConfig authFetch={authFetch} />
      </Collapsible>
      <Collapsible title="Listener channels">
        <ListenerConfig authFetch={authFetch} />
      </Collapsible>
      <Collapsible title="Automation">
        <AutomationConfig authFetch={authFetch} />
      </Collapsible>
      <Collapsible title="Custom messages">
        <BroadcastConfig authFetch={authFetch} />
      </Collapsible>
      <Collapsible title="Audit log">
        <AuditConfig authFetch={authFetch} />
      </Collapsible>
    </>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function BroadcastConfig({ authFetch }) {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const [pin, setPin] = useState(false);
  const [mode, setMode] = useState('recurring'); // 'recurring' | 'once'
  const [times, setTimes] = useState('12:00');
  const [days, setDays] = useState([]); // empty = every day
  const [onceAt, setOnceAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function load() {
    const res = await authFetch('api/admin/broadcasts');
    const data = await res.json();
    setItems(data.broadcasts || []);
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line */ }, []);

  function toggleDay(d) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  }

  async function sendNow() {
    if (!text.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const res = await authFetch('api/admin/broadcasts/send-now', { method: 'POST', body: JSON.stringify({ text, pin }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Send failed.');
      setMsg({ type: 'ok', text: `Sent to ${data.result.sent} channel(s).` });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  }

  async function schedule() {
    if (!text.trim()) return;
    setBusy(true); setMsg(null);
    const body = { text, pin, mode, enabled: true };
    if (mode === 'once') body.onceAt = onceAt;
    else { body.times = times.split(',').map((t) => t.trim()).filter(Boolean); body.days = days; }
    try {
      const res = await authFetch('api/admin/broadcasts/save', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setItems(data.broadcasts || []);
      setMsg({ type: 'ok', text: 'Scheduled.' });
      setText('');
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  }

  async function remove(id) {
    const res = await authFetch('api/admin/broadcasts/delete', { method: 'POST', body: JSON.stringify({ id }) });
    const data = await res.json();
    setItems(data.broadcasts || []);
  }

  return (
    <>
      <p className="subtitle">Send a custom message to all active channels now, or schedule it (times are IST).</p>
      <label htmlFor="bmsg">Message</label>
      <textarea id="bmsg" value={text} onChange={(e) => setText(e.target.value)} placeholder="🔥 Big Billion Deals — loot coming soon!" style={{ minHeight: 90 }} />
      <label className="opt" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
        <span>Pin this message in the channel</span>
      </label>

      <div className="row">
        <button onClick={sendNow} disabled={busy || !text.trim()}>Send now</button>
      </div>

      <hr className="divider" />
      <div className="sub-title">Schedule</div>
      <div className="toggle" style={{ marginTop: 8 }}>
        <label className="opt"><input type="radio" checked={mode === 'recurring'} onChange={() => setMode('recurring')} /> Recurring (daily / weekly)</label>
        <label className="opt"><input type="radio" checked={mode === 'once'} onChange={() => setMode('once')} /> Once (specific date & time)</label>
      </div>

      {mode === 'recurring' ? (
        <>
          <label htmlFor="btimes" style={{ marginTop: 12 }}>Times (IST, comma-separated)</label>
          <input id="btimes" type="text" value={times} onChange={(e) => setTimes(e.target.value)} placeholder="12:00, 18:00" />
          <p className="meta" style={{ marginTop: 10 }}>Days (none = every day):</p>
          <div className="auto-row">
            {WEEKDAYS.map((w, i) => (
              <label key={i} className="opt" style={{ fontWeight: 400 }}>
                <input type="checkbox" checked={days.includes(i)} onChange={() => toggleDay(i)} /> {w}
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <label htmlFor="bonce" style={{ marginTop: 12 }}>Date & time (IST)</label>
          <input id="bonce" type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
        </>
      )}

      <div className="row">
        <button onClick={schedule} disabled={busy || !text.trim()}>Schedule</button>
        {msg && <span className={`status ${msg.type}`}>{msg.text}</span>}
      </div>

      {items.length > 0 && <div className="sub-title" style={{ marginTop: 20 }}>Scheduled</div>}
      {items.map((b) => (
        <div key={b.id} className="listrow">
          <span>
            <div>{(b.text || '').slice(0, 60)}{b.text && b.text.length > 60 ? '…' : ''}</div>
            <div className="meta">
              {b.mode === 'once' ? `once @ ${b.onceAt || '?'}` : `${(b.times || []).join(', ')} ${b.days && b.days.length ? b.days.map((d) => WEEKDAYS[d]).join('/') : 'daily'}`}
              {b.pin ? ' · pinned' : ''}{b.enabled ? '' : ' · done'}
            </div>
          </span>
          <button className="link danger" onClick={() => remove(b.id)}>delete</button>
        </div>
      ))}
    </>
  );
}

function AuditConfig({ authFetch }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await authFetch('api/admin/audit');
      const data = await res.json();
      setItems(data.audit || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load().catch(() => setLoading(false)); /* eslint-disable-next-line */ }, []);

  return (
    <>
      <p className="subtitle">Recent activity (kept 2 days). Cron runs, bot/website links, and custom messages.</p>
      <div className="row" style={{ marginTop: 0 }}>
        <button className="secondary" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {!loading && items.length === 0 && <p className="meta">No activity yet.</p>}
      {items.map((a, i) => (
        <div key={i} className="audit-row">
          <span className={`badge audit-${a.type}`}>{a.type}</span>
          <span className="audit-msg">{a.message}</span>
          <span className="meta audit-time">{a.at ? new Date(a.at).toLocaleString() : ''}</span>
        </div>
      ))}
    </>
  );
}

function AutomationConfig({ authFetch }) {
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);

  async function load() {
    const res = await authFetch('api/admin/automation');
    const data = await res.json();
    if (data.automation) setStatus(data.automation);
  }
  useEffect(() => {
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await authFetch('api/admin/automation/run', { method: 'POST', body: '{}' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Run failed.');
      const r = data.result || {};
      setRunResult(r.skipped ? `Skipped (${r.skipped}).` : `Ran ${r.ran} listener(s); posted ${r.posted} new deal(s).`);
      load();
    } catch (err) {
      setRunResult(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <p className="subtitle">
        Each listener posts on its <strong>own interval</strong> (set “Auto” + interval + count on the
        listener above). A background checker wakes every ~5 minutes and runs only the listeners whose
        interval is due — so a 30-min listener posts every 30 min, not every 5. Runs never overlap.
      </p>
      <div className="row">
        <button className="secondary" onClick={runNow} disabled={running}>{running ? 'Running…' : 'Run all now'}</button>
        {status && status.running && <span className="meta">a run is in progress…</span>}
      </div>
      {runResult && <p className="meta">{runResult}</p>}
      {status && status.lastResult && status.lastResult.at && (
        <p className="meta">Last run: {new Date(status.lastResult.at).toLocaleString()} — {status.lastResult.posted} posted.</p>
      )}
    </>
  );
}

// Collapsed by default; mounts its children only when first opened.
// `bare` renders a lighter box for nested sub-sections.
function Collapsible({ title, children, bare = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={bare ? 'subcoll' : 'card'}>
      <div className="collhead" onClick={() => setOpen((o) => !o)}>
        <h2>{title}</h2>
        <span className="chev">{open ? '▲' : '▼'}</span>
      </div>
      {open && <div className="collbody">{children}</div>}
    </div>
  );
}

function AmazonConfig({ authFetch }) {
  const [mode, setMode] = useState('TAG');
  const [tag, setTag] = useState('');
  const [curl, setCurl] = useState('');
  const [status, setStatus] = useState(null);
  const [amazonSave, setAmazonSave] = useState(null);
  const [curlSave, setCurlSave] = useState(null);
  const [savingAmazon, setSavingAmazon] = useState(false);
  const [savingCurl, setSavingCurl] = useState(false);

  async function loadConfig() {
    const res = await authFetch('api/admin/config');
    const data = await res.json();
    if (data.amazon) {
      setMode(data.amazon.mode || 'TAG');
      setTag(data.amazon.tag || '');
    }
    setStatus(data.sitestripe || null);
  }
  useEffect(() => {
    loadConfig().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAmazon() {
    setSavingAmazon(true);
    setAmazonSave(null);
    try {
      const res = await authFetch('api/admin/amazon', { method: 'POST', body: JSON.stringify({ mode, tag }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setAmazonSave({ type: 'ok', text: 'Settings saved.' });
    } catch (err) {
      setAmazonSave({ type: 'err', text: err.message });
    } finally {
      setSavingAmazon(false);
    }
  }

  async function saveCurl() {
    setSavingCurl(true);
    setCurlSave(null);
    try {
      const res = await authFetch('api/admin/amazon/sitestripe', { method: 'POST', body: JSON.stringify({ curl }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setStatus(data.sitestripe || null);
      setCurlSave({ type: 'ok', text: 'Session saved.' });
      setCurl('');
    } catch (err) {
      setCurlSave({ type: 'err', text: err.message });
    } finally {
      setSavingCurl(false);
    }
  }

  return (
    <>
      <p className="subtitle">Choose how affiliate links are generated.</p>

      <label>Mode</label>
      <div className="toggle">
        <label className="opt">
          <input type="radio" name="mode" checked={mode === 'TAG'} onChange={() => setMode('TAG')} />
          TAG <span className="meta">— rewrite URL with an associate tag</span>
        </label>
        <label className="opt">
          <input type="radio" name="mode" checked={mode === 'SITE_STRIPE'} onChange={() => setMode('SITE_STRIPE')} />
          SITE_STRIPE <span className="meta">— live SiteStripe link, TAG fallback</span>
        </label>
      </div>

      <label htmlFor="tag" style={{ marginTop: 16 }}>Associate tag</label>
      <input id="tag" type="text" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. dealverse08-21" />
      <p className="meta">Used for TAG mode and as the SITE_STRIPE fallback.</p>

      <div className="row">
        <button onClick={saveAmazon} disabled={savingAmazon}>{savingAmazon ? 'Saving…' : 'Save Settings'}</button>
        {amazonSave && <span className={`status ${amazonSave.type}`}>{amazonSave.text}</span>}
      </div>

      <Collapsible title="SiteStripe session" bare defaultOpen={!!(status && status.configured)}>
        <p className="subtitle">
          Paste the SiteStripe <code>getShortUrl</code> cURL (DevTools → Network → Copy as cURL). Needed for SITE_STRIPE mode.
        </p>

        <div className="statusbox">
          {status && status.configured ? (
            <>
              <div><strong>Session configured</strong></div>
              <div className="meta">endpoint: {status.endpoint}</div>
              <div className="meta">cookies: {status.hasCookies ? `${status.cookieCount} present` : 'none'}</div>
              {status.configuredAt && <div className="meta">saved: {new Date(status.configuredAt).toLocaleString()}</div>}
            </>
          ) : (
            <div className="meta">No session configured yet.</div>
          )}
        </div>

        <label htmlFor="curl">SiteStripe cURL</label>
        <textarea id="curl" value={curl} onChange={(e) => setCurl(e.target.value)}
          placeholder="curl 'https://www.amazon.in/associates/sitestripe/getShortUrl?...' -H '...' -b '...'" />

        <div className="row">
          <button onClick={saveCurl} disabled={savingCurl || curl.trim() === ''}>{savingCurl ? 'Saving…' : 'Save Session'}</button>
          {curlSave && <span className={`status ${curlSave.type}`}>{curlSave.text}</span>}
        </div>
      </Collapsible>
    </>
  );
}

/* ─────────────────────────── Telegram ─────────────────────────── */

function TelegramConfig({ authFetch }) {
  const [tg, setTg] = useState(null);
  const [suggestedBaseUrl, setSuggestedBaseUrl] = useState('');
  const [showBotModal, setShowBotModal] = useState(false);
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    const res = await authFetch('api/admin/telegram');
    const data = await res.json();
    setTg(data.telegram || { configured: false });
    if (data.suggestedBaseUrl) setSuggestedBaseUrl(data.suggestedBaseUrl);
  }
  useEffect(() => {
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function removeBot() {
    if (!confirm('Remove the bot and its webhook?')) return;
    await authFetch('api/admin/telegram/remove', { method: 'POST', body: '{}' });
    load();
  }
  async function removeChannel(id) {
    await authFetch('api/admin/telegram/channel/remove', { method: 'POST', body: JSON.stringify({ id }) });
    load();
  }
  async function toggleAuto(id, autoPublish) {
    await authFetch('api/admin/telegram/channel/auto-publish', { method: 'POST', body: JSON.stringify({ id, autoPublish }) });
    load();
  }
  async function toggleActive(id, active) {
    await authFetch('api/admin/telegram/channel/active', { method: 'POST', body: JSON.stringify({ id, active }) });
    load();
  }

  const configured = tg && tg.configured;

  return (
    <>
      <p className="subtitle">Connect a bot so users can generate links in chat, and publish deals to channels.</p>

      {!configured ? (
        <div className="row">
          <button onClick={() => setShowBotModal(true)}>Add bot</button>
        </div>
      ) : (
        <>
          <div className="statusbox">
            <div>
              <strong>@{tg.username || 'bot'}</strong>{' '}
              {tg.confirmed ? <span className="badge ok">active</span> : <span className="badge">setup pending</span>}
              <button className="link" style={{ float: 'right' }} onClick={() => setExpanded((v) => !v)}>
                {expanded ? '▲' : '▼'}
              </button>
            </div>
            <div className="meta">webhook: {tg.webhookConfigured ? 'registered' : 'not set'}</div>
            <div className="meta">channels: {(tg.channels || []).length}</div>
          </div>

          {expanded && (
            <>
              <label>Channels</label>
              {(tg.channels || []).length === 0 && <p className="meta">No channels yet.</p>}
              {(tg.channels || []).map((c) => {
                const active = c.active !== false;
                return (
                  <div key={c.id} className="listrow">
                    <span>
                      {c.title} <span className="meta">({c.id})</span>
                      {!active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
                    </span>
                    <span className="rowactions">
                      <label className="opt toggle-sw" title="Master switch — inactive channels receive nothing">
                        <input type="checkbox" checked={active} onChange={(e) => toggleActive(c.id, e.target.checked)} />
                        <span>{active ? 'Active' : 'Off'}</span>
                      </label>
                      <label className="opt" style={{ fontWeight: 400 }} title="Auto-post user/website links to this channel">
                        <input type="checkbox" checked={!!c.autoPublish} disabled={!active} onChange={(e) => toggleAuto(c.id, e.target.checked)} />
                        <span className="meta">auto-post user links</span>
                      </label>
                      <button className="link" onClick={() => removeChannel(c.id)}>remove</button>
                    </span>
                  </div>
                );
              })}
              <div className="row">
                <button className="secondary" onClick={() => setShowChannelModal(true)}>Add channel</button>
                <button className="link" onClick={removeBot}>Remove bot</button>
              </div>
            </>
          )}
        </>
      )}

      {showBotModal && (
        <BotModal
          authFetch={authFetch}
          suggestedBaseUrl={suggestedBaseUrl}
          onClose={() => setShowBotModal(false)}
          onSaved={() => { setShowBotModal(false); load(); }}
        />
      )}
      {showChannelModal && (
        <ChannelModal
          authFetch={authFetch}
          onClose={() => setShowChannelModal(false)}
          onSaved={() => { setShowChannelModal(false); load(); }}
        />
      )}
    </>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BotModal({ authFetch, suggestedBaseUrl, onClose, onSaved }) {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState(suggestedBaseUrl || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inbound, setInbound] = useState(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/telegram/connect', {
        method: 'POST',
        body: JSON.stringify({ token, baseUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Connection failed.');
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Poll for the round-trip message once we're on step 2.
  useEffect(() => {
    if (step !== 2) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const res = await authFetch('api/admin/telegram');
        const data = await res.json();
        if (alive && data.telegram && data.telegram.lastInbound) setInbound(data.telegram.lastInbound);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [step, authFetch]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/telegram/save', { method: 'POST', body: '{}' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add bot" onClose={onClose}>
      {step === 1 && (
        <>
          <p className="subtitle">Step 1 — enter your bot token and this API's base URL. We'll register the webhook.</p>
          <label htmlFor="bt">Bot token</label>
          <input id="bt" type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC-..." />
          <label htmlFor="bu" style={{ marginTop: 12 }}>API Gateway base URL</label>
          <input id="bu" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://xxxx.execute-api.ap-south-1.amazonaws.com/prod" />
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button onClick={connect} disabled={busy || token.trim() === ''}>{busy ? 'Testing…' : 'Test connection'}</button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="subtitle">Step 2 — open your bot in Telegram and send it any message. It will reply “Hi from server”.</p>
          <div className="statusbox">
            {inbound ? (
              <>
                <div><strong>Message received ✅</strong></div>
                <div className="meta">from: {inbound.name}</div>
                <div className="meta">text: {inbound.text}</div>
              </>
            ) : (
              <div className="meta">Waiting for a message from the bot…</div>
            )}
          </div>
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button onClick={save} disabled={busy || !inbound}>{busy ? 'Saving…' : 'Save bot'}</button>
            <button className="secondary" onClick={() => setStep(1)}>Back</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ChannelModal({ authFetch, onClose, onSaved }) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [detected, setDetected] = useState(null);
  const [tested, setTested] = useState(false);

  // Poll for a channel post once we're detecting. Reset any stale detection
  // first so adding a second channel doesn't show the previously-added one.
  useEffect(() => {
    if (step !== 2) return undefined;
    let alive = true;
    let intervalId;
    const start = async () => {
      try {
        await authFetch('api/admin/telegram/channel/detect-reset', { method: 'POST', body: '{}' });
      } catch { /* ignore */ }
      if (!alive) return;
      setDetected(null);
      const tick = async () => {
        try {
          const res = await authFetch('api/admin/telegram');
          const data = await res.json();
          if (alive && data.telegram && data.telegram.lastChannel) setDetected(data.telegram.lastChannel);
        } catch { /* ignore */ }
      };
      tick();
      intervalId = setInterval(tick, 3000);
    };
    start();
    return () => { alive = false; if (intervalId) clearInterval(intervalId); };
  }, [step, authFetch]);

  async function sendTest() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/telegram/test-message', {
        method: 'POST',
        body: JSON.stringify({ chatId: detected.id, text: '✅ DealVerse test message.' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Test failed.');
      setTested(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/telegram/channel/add', {
        method: 'POST',
        body: JSON.stringify({ id: detected.id, title: detected.title }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add channel" onClose={onClose}>
      {step === 1 && (
        <>
          <p className="subtitle">Step 1 — add your bot as an <strong>administrator</strong> of the channel (with “Post messages” permission). Then click Done.</p>
          <div className="row">
            <button onClick={() => setStep(2)}>Done</button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="subtitle">Step 2 — post any message in the channel so we can detect its id.</p>
          <div className="statusbox">
            {detected ? (
              <>
                <div><strong>Channel detected ✅</strong></div>
                <div className="meta">title: {detected.title}</div>
                <div className="meta">id: {detected.id}</div>
              </>
            ) : (
              <div className="meta">Waiting for a channel post…</div>
            )}
          </div>
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button onClick={() => setStep(3)} disabled={!detected}>Use this channel</button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <p className="subtitle">Step 3 — send a test message to <strong>{detected.title}</strong>, confirm it arrived, then save.</p>
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button className="secondary" onClick={sendTest} disabled={busy}>{busy ? 'Sending…' : 'Send test message'}</button>
            {tested && <span className="status ok">Sent — check the channel.</span>}
          </div>
          <div className="row">
            <button onClick={save} disabled={busy || !tested}>{busy ? 'Saving…' : 'Save channel'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ─────────────────────────── Listener channels ─────────────────────────── */

function ListenerConfig({ authFetch }) {
  const [listeners, setListeners] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [msgFor, setMsgFor] = useState(null); // { username, limit }

  async function load() {
    const res = await authFetch('api/admin/listener');
    const data = await res.json();
    setListeners(data.listeners || []);
  }
  useEffect(() => {
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(username) {
    await authFetch('api/admin/listener/remove', { method: 'POST', body: JSON.stringify({ username }) });
    load();
  }
  async function saveAutomation(username, settings) {
    await authFetch('api/admin/listener/automation', { method: 'POST', body: JSON.stringify({ username, ...settings }) });
    load();
  }

  return (
    <>
      <p className="subtitle">
        Read public channels (no login) and re-publish their Amazon deals with your affiliate link.
      </p>

      {listeners.length === 0 && <p className="meta">No listener channels yet.</p>}
      {listeners.map((c) => (
        <ListenerRow
          key={c.username}
          channel={c}
          onOpen={(limit) => setMsgFor({ username: c.username, limit })}
          onRemove={() => remove(c.username)}
          onSaveAutomation={(settings) => saveAutomation(c.username, settings)}
        />
      ))}

      <div className="row">
        <button className="secondary" onClick={() => setShowAdd(true)}>Add listener</button>
      </div>

      {showAdd && (
        <AddListenerModal
          authFetch={authFetch}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
      {msgFor && (
        <ListenerMessagesModal
          authFetch={authFetch}
          channel={msgFor.username}
          limit={msgFor.limit}
          onClose={() => setMsgFor(null)}
        />
      )}
    </>
  );
}

function ListenerRow({ channel, onOpen, onRemove, onSaveAutomation }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(10);
  const [auto, setAuto] = useState(!!channel.auto);
  const [intervalMin, setIntervalMin] = useState(channel.intervalMinutes ?? 60);
  const [count, setCount] = useState(channel.count ?? 5);
  const [saved, setSaved] = useState(false);

  async function saveAuto(next) {
    setSaved(false);
    await onSaveAutomation(next);
    setSaved(true);
  }

  return (
    <div className="listener-card">
      <div className="listener-head" onClick={() => setOpen((o) => !o)}>
        <div>
          <strong>{channel.title}</strong> <span className="meta">@{channel.username}</span>
          <div className="meta">
            {auto ? `auto · every ${intervalMin || 0} min · ${count} msgs` : 'auto off'}
          </div>
        </div>
        <span className="chev">{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="listener-body">
          <div className="sub">
            <div className="sub-title">Manual fetch</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => onOpen(10)}>Last 10</button>
              <button className="secondary" onClick={() => onOpen(20)}>Last 20</button>
              <input className="num" type="number" min="1" max="30" value={custom}
                onChange={(e) => setCustom(e.target.value)} title="custom count" />
              <button className="secondary" onClick={() => onOpen(Math.min(Math.max(parseInt(custom, 10) || 1, 1), 30))}>Fetch</button>
            </div>
          </div>

          <div className="sub">
            <div className="sub-title">Automation</div>
            <label className="opt" style={{ fontWeight: 500, marginTop: 8 }}>
              <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setSaved(false); }} />
              <span>Auto-post new deals from this channel</span>
            </label>
            <div className="auto-row">
              <span className="meta">every</span>
              <input className="num" type="number" min="0" max="1440" value={intervalMin} onChange={(e) => { setIntervalMin(e.target.value); setSaved(false); }} />
              <span className="meta">min · latest</span>
              <input className="num" type="number" min="1" max="20" value={count} onChange={(e) => { setCount(e.target.value); setSaved(false); }} />
              <span className="meta">msgs</span>
            </div>
            <p className="meta">Interval 0 = every check (~5 min).</p>
            <div className="row">
              <button onClick={() => saveAuto({ auto, intervalMinutes: Number(intervalMin), count: Number(count) })}>Save automation</button>
              {saved && <span className="status ok">✓ saved</span>}
            </div>
          </div>

          <div className="row">
            <button className="link danger" onClick={onRemove}>Remove channel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddListenerModal({ authFetch, onClose, onSaved }) {
  const [channel, setChannel] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // { username, messages }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/listener/test', { method: 'POST', body: JSON.stringify({ channel }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not read channel.');
      setPreview(data);
      if (!title) setTitle(data.username);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('api/admin/listener/add', { method: 'POST', body: JSON.stringify({ channel, title }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add listener channel" onClose={onClose}>
      <p className="subtitle">Enter a public channel (@username or t.me link), then test-read it.</p>
      <label htmlFor="ch">Channel</label>
      <input id="ch" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="https://t.me/FLTlooters or @FLTlooters" />
      <div className="row">
        <button className="secondary" onClick={test} disabled={busy || channel.trim() === ''}>{busy ? 'Reading…' : 'Test read'}</button>
      </div>
      {error && <p className="status err">{error}</p>}

      {preview && (
        <>
          <div className="statusbox">
            <div><strong>@{preview.username}</strong> — last {preview.messages.length} messages</div>
            {preview.messages.map((m) => (
              <div key={m.id} className="meta" style={{ marginTop: 6 }}>• {m.text.slice(0, 90) || '(no text)'}</div>
            ))}
          </div>
          <label htmlFor="lt">Title</label>
          <input id="lt" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="row">
            <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save listener'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ListenerMessagesModal({ authFetch, channel, limit, onClose }) {
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState({}); // id -> 'sending' | 'ok' | error string

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await authFetch('api/admin/listener/messages', { method: 'POST', body: JSON.stringify({ channel, limit }) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not read messages.');
        if (alive) setMessages(data.messages || []);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [authFetch, channel, limit]);

  const [sendingAll, setSendingAll] = useState(false);
  const [verify, setVerify] = useState({}); // affiliateUrl -> 'checking' | {tag, matches, error}

  function msgHasAffiliate(msg) {
    return (msg.items || []).some((it) => it.affiliate && it.affiliate.affiliateUrl);
  }

  // Replace each source link in the message text with its affiliate link.
  function composeText(msg) {
    let text = msg.text || '';
    let appended = '';
    for (const it of msg.items || []) {
      const aff = it.affiliate && it.affiliate.affiliateUrl;
      if (!aff) continue;
      if (text.includes(it.sourceUrl)) text = text.split(it.sourceUrl).join(aff);
      else appended += `\n${aff}`;
    }
    return (text + appended).trim();
  }

  async function sendToChannel(msg) {
    if (!msgHasAffiliate(msg)) return;
    setSent((s) => ({ ...s, [msg.id]: 'sending' }));
    try {
      const res = await authFetch('api/admin/listener/publish', { method: 'POST', body: JSON.stringify({ text: composeText(msg) }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed.');
      setSent((s) => ({ ...s, [msg.id]: 'ok' }));
    } catch (err) {
      setSent((s) => ({ ...s, [msg.id]: err.message }));
    }
  }

  async function sendAll() {
    setSendingAll(true);
    for (const m of messages) {
      if (msgHasAffiliate(m) && sent[m.id] !== 'ok') {
        // eslint-disable-next-line no-await-in-loop
        await sendToChannel(m);
      }
    }
    setSendingAll(false);
  }

  async function verifyLink(url) {
    setVerify((v) => ({ ...v, [url]: 'checking' }));
    try {
      const res = await authFetch('api/admin/affiliate/verify', { method: 'POST', body: JSON.stringify({ url }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Verify failed.');
      setVerify((v) => ({ ...v, [url]: { ok: data.ok, status: data.status } }));
    } catch (err) {
      setVerify((v) => ({ ...v, [url]: { error: err.message } }));
    }
  }

  const sendable = messages.filter(msgHasAffiliate).length;

  return (
    <Modal title={`@${channel} — ${limit} Amazon deals`} onClose={onClose}>
      {loading && <p className="meta">Reading messages and generating affiliate links…</p>}
      {error && <p className="status err">{error}</p>}
      {!loading && messages.length > 0 && (
        <div className="row" style={{ marginTop: 0, marginBottom: 12 }}>
          <button onClick={sendAll} disabled={sendingAll || sendable === 0}>
            {sendingAll ? 'Sending…' : `Send all to channel (${sendable})`}
          </button>
          <span className="meta">{messages.length} messages</span>
        </div>
      )}
      {!loading && messages.length === 0 && !error && (
        <p className="meta">No Amazon-link messages found in this channel.</p>
      )}
      {!loading && messages.map((m) => (
        <div key={m.id} className="msgcard">
          <div className="msgtext">{m.text || '(no text)'}</div>
          {(m.items || []).map((it, i) => {
            const v = verify[it.affiliate && it.affiliate.affiliateUrl];
            return (
              <div key={i} className="linkitem">
                {it.affiliate && it.affiliate.affiliateUrl ? (
                  <>
                    <a className="affiliate" href={it.affiliate.affiliateUrl} target="_blank" rel="noreferrer">{it.affiliate.affiliateUrl}</a>
                    <div className="row" style={{ marginTop: 4 }}>
                      <button className="link" onClick={() => verifyLink(it.affiliate.affiliateUrl)}>verify</button>
                      {v === 'checking' && <span className="meta">checking…</span>}
                      {v && typeof v === 'object' && (
                        v.error
                          ? <span className="status err">{v.error}</span>
                          : <span className={v.ok ? 'status ok' : 'status err'}>{v.ok ? '✓ ' : '⚠ '}{v.status}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="meta">⚠ {(it.affiliate && it.affiliate.error) || 'Could not convert'} — {it.sourceUrl}</span>
                )}
              </div>
            );
          })}
          {msgHasAffiliate(m) && (
            <div className="row">
              <button className="secondary" onClick={() => sendToChannel(m)} disabled={sent[m.id] === 'sending' || sent[m.id] === 'ok'}>
                {sent[m.id] === 'ok' ? 'Sent ✅' : sent[m.id] === 'sending' ? 'Sending…' : 'Send to channel'}
              </button>
              {typeof sent[m.id] === 'string' && sent[m.id] !== 'ok' && sent[m.id] !== 'sending' && (
                <span className="status err">{sent[m.id]}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </Modal>
  );
}
