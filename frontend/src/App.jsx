import React, { useEffect, useRef, useState } from 'react';

// API paths resolve relative to the current document (served under /<stage>/).
const api = (p) => new URL(p, document.baseURI).toString();
const TOKEN_KEY = 'dv_admin_token';
const SUPER_TOKEN_KEY = 'dv_super_token';
const stageBase = new URL('.', document.baseURI).pathname; // e.g. /prod/

function isAdminPath() {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/admin');
}
function isSuperPath() {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/super-admin');
}
function navTo(view) {
  const p = view === 'admin' ? stageBase + 'admin' : stageBase + 'home';
  window.history.pushState({}, '', p);
}

const LOGO = new URL('dealverse.png', document.baseURI).toString();

// Inline icons (stroke = currentColor) for the sidebar / topbar.
const IC = {
  tag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3m10-10h-3M5 12H2m15.5-6.5-2 2m-9 9-2 2m13 0-2-2m-9-9-2-2" strokeLinecap="round"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m21 4-9 8-9-4 18-4Z" strokeLinejoin="round"/><path d="M12 12 9 21l-1-6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  rss: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h10M7 13h6" strokeLinecap="round"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  mega: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 10v4l7 4V6l-7 4Z" strokeLinejoin="round"/><path d="M14 9a4 4 0 0 1 0 6" strokeLinecap="round"/></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5" strokeLinecap="round"/></svg>,
  menu: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8" cy="8" r="4"/><path d="m11 11 8 8m-3-3 2-2m-4 0 2-2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6m2 8a6 6 0 0 0-3-5.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  code: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2-11-4 14" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

// Admin login persists across browser/app restarts (localStorage), so the
// Flutter app (and the browser) stays logged in until the user taps "Log out".
const adminToken = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export default function App() {
  const [token, setToken] = useState(() => adminToken.get());
  const [view, setView] = useState(() => {
    if (isAdminPath()) return adminToken.get() ? 'admin' : 'login';
    return 'user';
  });

  useEffect(() => {
    const onPop = () => {
      if (isAdminPath()) setView(adminToken.get() ? 'admin' : 'login');
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
    adminToken.set(t);
    setToken(t);
    navTo('admin');
    setView('admin');
  }
  function logout() {
    adminToken.clear();
    setToken('');
    goHome();
  }

  if (isSuperPath()) {
    return <SuperAdmin />;
  }

  if (view === 'admin') {
    return <AdminPanel token={token} onUnauthorized={logout} onLogout={logout} onHome={goHome} />;
  }

  // User / login: simple centered layout with a slim top bar.
  return (
    <div className="site">
      <header className="site-top">
        <div className="brand" onClick={goHome} style={{ cursor: 'pointer' }}>
          <img src={LOGO} alt="DealVerse" className="brand-logo" />
          <span className="brand-name">DealVerse</span>
        </div>
        <button className="link" onClick={goAdmin}>Admin</button>
      </header>
      <main className="site-main">
        {view === 'user' && <UserPanel />}
        {view === 'login' && <LoginPanel onLoggedIn={onLoggedIn} onCancel={goHome} />}
      </main>
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
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ name, password }),
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
      <h2>Merchant login</h2>
      <p className="subtitle">Sign in with the name and password you were given.</p>
      <label htmlFor="mname">Name</label>
      <input id="mname" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="username" />
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <p className="status err">{error}</p>}
      <div className="row">
        <button type="submit" disabled={loading || name.trim() === '' || password === ''}>
          {loading ? 'Checking…' : 'Log in'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/* ─────────────────────────── Super-admin ─────────────────────────── */

function SuperAdmin() {
  const [token, setToken] = useState(() => sessionStorage.getItem(SUPER_TOKEN_KEY) || '');

  function onLoggedIn(t) {
    sessionStorage.setItem(SUPER_TOKEN_KEY, t);
    setToken(t);
  }
  function logout() {
    sessionStorage.removeItem(SUPER_TOKEN_KEY);
    setToken('');
  }

  return (
    <div className="site">
      <header className="site-top">
        <div className="brand">
          <img src={LOGO} alt="DealVerse" className="brand-logo" />
          <span className="brand-name">DealVerse · Super-admin</span>
        </div>
        {token && <button className="link" onClick={logout}>Log out</button>}
      </header>
      <main className="site-main">
        {token
          ? <SuperPanel token={token} onUnauthorized={logout} />
          : <SuperLogin onLoggedIn={onLoggedIn} />}
      </main>
    </div>
  );
}

function SuperLogin({ onLoggedIn }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function login(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api('api/super/login'), {
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
      <h2>Super-admin login</h2>
      <p className="subtitle">Enter the super-admin password to manage merchants.</p>
      <label htmlFor="spw">Password</label>
      <input id="spw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
      {error && <p className="status err">{error}</p>}
      <div className="row">
        <button type="submit" disabled={loading || secret === ''}>
          {loading ? 'Checking…' : 'Log in'}
        </button>
      </div>
    </form>
  );
}

function SuperPanel({ token, onUnauthorized }) {
  const [merchants, setMerchants] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [created, setCreated] = useState(null);

  const call = async (p, opts = {}) => {
    const res = await fetch(api(p), {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      onUnauthorized();
      throw new Error('Session expired.');
    }
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Request failed.');
    return data;
  };

  async function load() {
    setError(null);
    try {
      const data = await call('api/super/merchants');
      setMerchants(data.merchants || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function add(e) {
    e.preventDefault();
    setBusy('add');
    setError(null);
    setCreated(null);
    try {
      const data = await call('api/super/merchants/add', {
        method: 'POST',
        body: JSON.stringify({ name: newName, password: newPass }),
      });
      setMerchants(data.merchants || []);
      setCreated({ name: newName, password: newPass });
      setNewName('');
      setNewPass('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function act(path, id, key) {
    setBusy(key);
    setError(null);
    try {
      const data = await call(path, { method: 'POST', body: JSON.stringify({ id }) });
      setMerchants(data.merchants || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function del(id, name) {
    if (!window.confirm(`Delete merchant "${name}"? This permanently wipes all of its data (bot, channels, listeners, config, audit). This cannot be undone.`)) {
      return;
    }
    await act('api/super/merchants/delete', id, `del-${id}`);
  }

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h2>Merchants</h2>
      <p className="subtitle">Create, deactivate, or delete merchant accounts. Each merchant is fully isolated.</p>

      {error && <p className="status err">{error}</p>}

      {merchants === null && <p className="meta">Loading…</p>}

      {merchants && merchants.length > 0 && (
        <div className="merchant-list">
          {merchants.map((m) => (
            <div key={m.id} className="merchant-row">
              <div className="merchant-info">
                <span className="merchant-name">{m.name}</span>
                <span className={`badge ${m.active ? 'ok' : 'off'}`}>{m.active ? 'Active' : 'Deactivated'}</span>
                {m.id === 'default' && <span className="badge">default</span>}
              </div>
              <div className="row">
                {m.active
                  ? <button className="secondary" disabled={busy === `deact-${m.id}`} onClick={() => act('api/super/merchants/deactivate', m.id, `deact-${m.id}`)}>
                      {busy === `deact-${m.id}` ? '…' : 'Deactivate'}
                    </button>
                  : <button className="secondary" disabled={busy === `act-${m.id}`} onClick={() => act('api/super/merchants/activate', m.id, `act-${m.id}`)}>
                      {busy === `act-${m.id}` ? '…' : 'Activate'}
                    </button>}
                {m.id !== 'default' && (
                  <button className="danger" disabled={busy === `del-${m.id}`} onClick={() => del(m.id, m.name)}>
                    {busy === `del-${m.id}` ? '…' : 'Delete'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <form className="add-merchant" onSubmit={add}>
        <h3>Add a merchant</h3>
        <label htmlFor="nm">Name</label>
        <input id="nm" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. acme-deals" />
        <label htmlFor="np">Password</label>
        <input id="np" type="text" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="at least 4 characters" />
        <div className="row">
          <button type="submit" disabled={busy === 'add' || newName.trim() === '' || newPass.length < 4}>
            {busy === 'add' ? 'Creating…' : 'Add merchant'}
          </button>
        </div>
      </form>

      {created && (
        <p className="status ok">
          Created <strong>{created.name}</strong>. Share these credentials — name <strong>{created.name}</strong>, password <strong>{created.password}</strong>. They log in at the normal <code>/admin</code> page.
        </p>
      )}
    </div>
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

function AdminPanel({ token, onUnauthorized, onLogout, onHome }) {
  const authFetch = useRef(makeAuth(token, onUnauthorized)).current;
  const [active, setActive] = useState('amazon');
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = [
    ['amazon', 'Affiliate settings', IC.tag],
    ['telegram-login', 'Telegram login', IC.key],
    ['telegram', 'Telegram bot', IC.send],
    ['listeners', 'Listener channels', IC.rss],
    ['automation', 'Automation', IC.clock],
    ['broadcasts', 'Custom messages', IC.mega],
    ['import-users', 'Import users', IC.users],
    ['price-tracker', 'Price Tracker', IC.tag],
    ['ai-dev', 'AI Developer', IC.code],
    ['audit', 'Audit log', IC.list],
  ];
  const titles = Object.fromEntries(nav.map(([id, label]) => [id, label]));

  function renderSection() {
    switch (active) {
      case 'amazon': return <AmazonConfig authFetch={authFetch} onNavigate={go} />;
      case 'telegram-login': return <TelegramLogin authFetch={authFetch} />;
      case 'telegram': return <TelegramConfig authFetch={authFetch} />;
      case 'listeners': return <ListenerConfig authFetch={authFetch} onNavigate={go} />;
      case 'automation': return <AutomationConfig authFetch={authFetch} />;
      case 'broadcasts': return <BroadcastConfig authFetch={authFetch} />;
      case 'import-users': return <ImportUsers authFetch={authFetch} onNavigate={go} />;
      case 'price-tracker': return <PriceTrackerConfig authFetch={authFetch} />;
      case 'ai-dev': return <AIDevConfig authFetch={authFetch} />;
      case 'audit': return <AuditConfig authFetch={authFetch} />;
      default: return null;
    }
  }
  function go(id) { setActive(id); setMenuOpen(false); }

  return (
    <div className="admin-shell">
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="side-brand" onClick={onHome} style={{ cursor: 'pointer' }}>
          <img src={LOGO} alt="DealVerse" className="side-logo" />
          <span className="side-name">DealVerse</span>
        </div>
        <nav className="side-nav">
          {nav.map(([id, label, icon]) => (
            <a key={id} className={active === id ? 'on' : ''} onClick={() => go(id)}>
              {icon}<span>{label}</span>
            </a>
          ))}
        </nav>
        <button className="link side-logout" onClick={onLogout}>Log out</button>
      </aside>

      <div className="admin-main">
        <header className="admin-top">
          <div className="admin-top-left">
            <button className="ibtn menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">{IC.menu}</button>
            <div>
              <div className="crumb">Admin <span>/</span> <b>{titles[active]}</b></div>
              <h1 className="ptitle">{titles[active]}</h1>
            </div>
          </div>
          <div className="avatar">DV</div>
        </header>
        <div className="admin-content">
          <div className="card admin-card">{renderSection()}</div>
        </div>
      </div>
    </div>
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
    if (!window.confirm('Delete this scheduled message? This cannot be undone.')) return;
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

// Friendly tab labels per audit `type`, in display order. Types not listed here
// still get a tab (auto-appended) so nothing is ever hidden.
const AUDIT_TABS = [
  ['bot', 'Bot links'],
  ['website', 'Website links'],
  ['price', 'Price tracker'],
  ['cron', 'Listener cron'],
  ['ingest', 'Real-time'],
  ['mtproto', 'Import users'],
  ['broadcast', 'Broadcasts'],
];

function AuditConfig({ authFetch }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');

  async function load() {
    setLoading(true);
    try {
      const res = await authFetch('api/admin/audit');
      const data = await res.json();
      setItems(data.audit || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load().catch(() => setLoading(false)); /* eslint-disable-next-line */ }, []);

  // Count per type + build the visible tab list (known order first, then extras).
  const byType = {};
  items.forEach((a) => { const t = a.type || 'other'; byType[t] = (byType[t] || 0) + 1; });
  const known = AUDIT_TABS.filter(([t]) => byType[t]);
  const extras = Object.keys(byType)
    .filter((t) => !AUDIT_TABS.some(([x]) => x === t))
    .map((t) => [t, t]);
  const visibleTabs = [...known, ...extras];

  const q = query.trim().toLowerCase();
  const byTab = tab === 'all' ? items : items.filter((a) => (a.type || 'other') === tab);
  const shown = q
    ? byTab.filter((a) =>
        `${a.type || ''} ${a.message || ''} ${a.detail || ''}`.toLowerCase().includes(q))
    : byTab;

  return (
    <>
      <p className="subtitle">Recent activity (kept 2 days). Pick a category tab, or search across all. Rows with a ▸ expand to show the full flow — which links were found, how each converted, and whether it posted (and why not).</p>
      <div className="row" style={{ marginTop: 0, gap: 6, flexWrap: 'wrap' }}>
        <button className={tab === 'all' ? '' : 'secondary'} onClick={() => setTab('all')}>All ({items.length})</button>
        {visibleTabs.map(([t, label]) => (
          <button key={t} className={tab === t ? '' : 'secondary'} onClick={() => setTab(t)}>{label} ({byType[t]})</button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <input
          type="text"
          className="audit-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter logs… (e.g. user, cron, flipkart, @channel, error)"
        />
        {query && <button className="secondary" onClick={() => setQuery('')}>Clear</button>}
        <button className="secondary" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {!loading && items.length === 0 && <p className="meta">No activity yet.</p>}
      {!loading && items.length > 0 && shown.length === 0 && (
        <p className="meta">No logs {tab === 'all' ? '' : 'in this tab '}match{q ? ` “${query}”` : ''}.</p>
      )}
      {(q || tab !== 'all') && shown.length > 0 && <p className="meta">Showing {shown.length} log(s).</p>}
      {shown.map((a, i) => {
        const id = a.at ? `${a.at}#${i}` : String(i);
        const hasDetail = !!a.detail;
        const open = openId === id;
        return (
          <div key={id} className={`audit-row${hasDetail ? ' has-detail' : ''}`}>
            <div className="audit-head" onClick={() => hasDetail && setOpenId(open ? null : id)}>
              {hasDetail && <span className="audit-chev">{open ? '▾' : '▸'}</span>}
              <span className={`badge audit-${a.type}`}>{a.type}</span>
              <span className="audit-msg">{a.message}</span>
              <span className="meta audit-time">{a.at ? new Date(a.at).toLocaleString() : ''}</span>
            </div>
            {open && hasDetail && <pre className="audit-detail">{a.detail}</pre>}
          </div>
        );
      })}
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

function PriceTrackerConfig({ authFetch }) {
  const [cfg, setCfg] = useState(null);
  const [counts, setCounts] = useState(null);
  const [hours, setHours] = useState(6);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const res = await authFetch('api/admin/price-tracker');
    const data = await res.json();
    if (data.config) {
      setCfg(data.config);
      setEnabled(!!data.config.enabled);
      setHours(data.config.intervalHours || 6);
    }
    if (data.counts) setCounts(data.counts);
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line */ }, []);

  async function save() {
    setSaving(true); setMsg('');
    try {
      const res = await authFetch('api/admin/price-tracker/save', {
        method: 'POST',
        body: JSON.stringify({ enabled, intervalHours: Number(hours) }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed.');
      setCfg(data.config);
      setMsg('Saved ✓');
      load();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="subtitle">
        Users track product prices from the bot (<code>/pricetracker</code>). This controls how often the
        background job re-checks every tracked product and sends drop alerts.
      </p>
      {counts && (
        <div className="statusbox">
          <div className="meta">
            Trackers: <strong>{counts.total}</strong> total · {counts.active} active · {counts.paused} paused
          </div>
          {cfg && cfg.lastRunAt && (
            <div className="meta">Last full check: {new Date(cfg.lastRunAt).toLocaleString()}</div>
          )}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Toggle checked={enabled} onChange={setEnabled} label="Enable price checks" />
      </div>
      <label style={{ marginTop: 12, display: 'block' }}>Check every</label>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 4 }}>
        <input
          className="num"
          type="number"
          min="1"
          max="168"
          value={hours}
          disabled={!enabled}
          onChange={(e) => setHours(e.target.value)}
          style={{ width: 90 }}
        />
        <span className="meta">hours (1–168)</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {msg && <span className="meta">{msg}</span>}
      </div>
      <p className="meta" style={{ marginTop: 12 }}>
        Checks run on the existing 5-minute background job; the first tick after the interval elapses runs a
        full sweep. Amazon/Flipkart occasionally block price reads — those are skipped and retried next sweep.
      </p>
    </>
  );
}

const AIDEV_STATUS = {
  queued: ['Queued', 'badge'],
  running: ['Working…', 'badge'],
  ready: ['Ready ✓', 'badge ok'],
  failed: ['Failed ✗', 'badge off'],
  deploying: ['Deploying…', 'badge'],
  deployed: ['Deployed ✓', 'badge ok'],
  'deploy-failed': ['Deploy failed ✗', 'badge off'],
  reverting: ['Reverting…', 'badge'],
  reverted: ['Reverted ↩', 'badge'],
  'revert-failed': ['Revert failed ✗', 'badge off'],
  discarded: ['Discarded', 'badge'],
};

function AIDevConfig({ authFetch }) {
  const [cfg, setCfg] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [pat, setPat] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const res = await authFetch('api/admin/ai-dev');
    const data = await res.json();
    if (data.config) setCfg(data.config);
    if (data.tasks) setTasks(data.tasks);
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line */ }, []);

  // Poll while anything is in flight so status updates without manual refresh.
  const active = tasks.some((t) => ['queued', 'running', 'deploying'].includes(t.status));
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => load().catch(() => {}), 8000);
    return () => clearInterval(h);
    // eslint-disable-next-line
  }, [active]);

  async function savePat() {
    if (!pat.trim()) return;
    setBusy(true); setMsg('');
    try {
      const res = await authFetch('api/admin/ai-dev/config', { method: 'POST', body: JSON.stringify({ pat: pat.trim() }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not save.');
      setPat(''); setCfg(data.config); setMsg('GitHub connected ✓'); load();
    } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  }

  async function send() {
    if (!prompt.trim()) return;
    setBusy(true); setMsg('');
    try {
      const res = await authFetch('api/admin/ai-dev/tasks', { method: 'POST', body: JSON.stringify({ prompt: prompt.trim() }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not start the task.');
      setPrompt(''); setMsg('Sent to AI — it will implement this on a branch.'); load();
    } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  }

  async function act(id, kind) {
    const verb =
      kind === 'deploy' ? 'Deploy this change to production now?'
      : kind === 'revert' ? 'Revert this deployed change and redeploy production?'
      : 'Discard this change and delete its branch?';
    if (!window.confirm(verb)) return;
    setBusy(true); setMsg('');
    try {
      const res = await authFetch(`api/admin/ai-dev/tasks/${kind}`, { method: 'POST', body: JSON.stringify({ id }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Action failed.');
      load();
    } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  }

  const configured = cfg && cfg.configured;

  return (
    <>
      <p className="subtitle">
        Describe a change in plain English. An AI coding agent implements it on a separate branch, runs the
        tests/build, and shows the result here. Nothing reaches production until you tap <strong>Deploy</strong>.
      </p>

      {!configured ? (
        <>
          <label>GitHub token</label>
          <p className="meta">A fine-grained token for <code>{(cfg && cfg.repo) || 'DealVerse'}</code> with Contents + Actions read/write. Stored securely on the server.</p>
          <div className="row" style={{ gap: 8 }}>
            <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="github_pat_…" style={{ flex: 1, minWidth: 220 }} />
            <button onClick={savePat} disabled={busy || !pat.trim()}>Connect</button>
          </div>
        </>
      ) : (
        <>
          <div className="statusbox">
            <div className="meta">Repo: <strong>{cfg.owner}/{cfg.repo}</strong> · GitHub connected ✓</div>
          </div>

          <label style={{ marginTop: 12, display: 'block' }}>What should the AI change?</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Add a Refresh button beside the Search button on the audit log"
            rows={3}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.95rem', padding: 8 }}
          />
          <div className="row" style={{ gap: 8 }}>
            <button onClick={send} disabled={busy || !prompt.trim()}>Send to AI</button>
            <button className="secondary" onClick={() => load().catch(() => {})} disabled={busy}>Refresh</button>
          </div>
        </>
      )}
      {msg && <p className="meta">{msg}</p>}

      {configured && tasks.length === 0 && <p className="meta">No AI tasks yet.</p>}
      {tasks.map((t) => {
        const [label, cls] = AIDEV_STATUS[t.status] || ['—', 'badge'];
        return (
          <div key={t.id} className="listrow" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 200 }}>
              <span className={cls}>{label}</span>{' '}
              {t.prompt}
              <div className="meta">
                {t.branch}
                {' · '}<a href={t.diffUrl} target="_blank" rel="noreferrer">view diff</a>
                {t.developUrl && <> · <a href={t.developUrl} target="_blank" rel="noreferrer">run log</a></>}
                {t.deployUrl && <> · <a href={t.deployUrl} target="_blank" rel="noreferrer">deploy log</a></>}
                {t.revertUrl && <> · <a href={t.revertUrl} target="_blank" rel="noreferrer">revert log</a></>}
              </div>
            </span>
            <span className="rowactions">
              {(t.status === 'ready' || t.status === 'deploy-failed') && (
                <button onClick={() => act(t.id, 'deploy')} disabled={busy}>{t.status === 'deploy-failed' ? 'Retry deploy' : 'Deploy'}</button>
              )}
              {(t.status === 'deployed' || t.status === 'revert-failed') && (
                <button onClick={() => act(t.id, 'revert')} disabled={busy}>{t.status === 'revert-failed' ? 'Retry revert' : 'Revert change'}</button>
              )}
              {!['discarded', 'deployed', 'deploying', 'reverting', 'reverted'].includes(t.status) && (
                <button className="link" onClick={() => act(t.id, 'discard')} disabled={busy}>Discard</button>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}

// Collapsed by default; mounts its children only when first opened.
// `bare` renders a lighter box for nested sub-sections.
// Sliding on/off toggle switch (pill + knob). Use this wherever a toggle is
// wanted instead of a plain checkbox.
function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`toggle-sw${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track"><span className="toggle-knob" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

function Collapsible({ title, children, bare = false, defaultOpen = false, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`${bare ? 'subcoll' : 'card'}${className ? ' ' + className : ''}`}>
      <div className="collhead" onClick={() => setOpen((o) => !o)}>
        <h2>{title}</h2>
        <span className="chev">{open ? '▲' : '▼'}</span>
      </div>
      {open && <div className="collbody">{children}</div>}
    </div>
  );
}

function AmazonConfig({ authFetch, onNavigate }) {
  const [mode, setMode] = useState('TAG');
  const [tag, setTag] = useState('');
  const [amazonActive, setAmazonActive] = useState(true);
  const [curl, setCurl] = useState('');
  const [status, setStatus] = useState(null);
  const [amazonSave, setAmazonSave] = useState(null);
  const [curlSave, setCurlSave] = useState(null);
  const [savingAmazon, setSavingAmazon] = useState(false);
  const [savingCurl, setSavingCurl] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState(null);
  // Flipkart
  const [fk, setFk] = useState({ active: false, botUsername: '' });
  const [fkUser, setFkUser] = useState('');
  const [savingFk, setSavingFk] = useState(false);
  const [fkSave, setFkSave] = useState(null);
  const [fkTestUrl, setFkTestUrl] = useState('');
  const [fkTesting, setFkTesting] = useState(false);
  const [fkTestMsg, setFkTestMsg] = useState(null);

  async function loadConfig() {
    const res = await authFetch('api/admin/config');
    const data = await res.json();
    if (data.amazon) {
      setMode(data.amazon.mode || 'TAG');
      setTag(data.amazon.tag || '');
      setAmazonActive(data.amazon.active !== false);
    }
    if (data.flipkart) {
      setFk(data.flipkart);
      setFkUser(data.flipkart.botUsername || '');
    }
    setStatus(data.sitestripe || null);
  }
  useEffect(() => {
    loadConfig().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleAmazon(next) {
    setAmazonActive(next);
    try {
      await authFetch('api/admin/amazon/active', { method: 'POST', body: JSON.stringify({ active: next }) });
    } catch { setAmazonActive(!next); }
  }

  async function saveFlipkart(next) {
    setSavingFk(true); setFkSave(null);
    try {
      const body = next || { active: fk.active, botUsername: fkUser };
      const res = await authFetch('api/admin/flipkart', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setFk(data.flipkart); setFkUser(data.flipkart.botUsername || '');
      setFkSave({ type: 'ok', text: 'Saved.' });
    } catch (e) {
      setFkSave({ type: 'err', text: e.message });
      loadConfig().catch(() => {});
    } finally { setSavingFk(false); }
  }

  async function testFlipkart() {
    setFkTesting(true); setFkTestMsg(null);
    try {
      const res = await authFetch('api/admin/flipkart/test', { method: 'POST', body: JSON.stringify({ url: fkTestUrl }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Test failed.');
      setFkTestMsg({ type: 'ok', text: `Converted → ${data.result.affiliateUrl}` });
    } catch (e) {
      setFkTestMsg({ type: 'err', text: e.message });
    } finally { setFkTesting(false); }
  }

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

  async function testSession() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await authFetch('api/admin/amazon/sitestripe/test', { method: 'POST', body: '{}' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Test failed.');
      if (data.sitestripe) setStatus(data.sitestripe);
      const r = data.result || {};
      setTestMsg(r.working ? { type: 'ok', text: 'Session works ✅' } : { type: 'err', text: `${r.expired ? 'Session expired' : 'Not working'} — ${r.error}` });
    } catch (err) {
      setTestMsg({ type: 'err', text: err.message });
    } finally {
      setTesting(false);
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

  const sessionExpired = status && status.configured && status.status === 'expired';

  return (
    <>
      {sessionExpired && (
        <div className="banner-warn">
          ⚠ Your SiteStripe session has expired — links are falling back to your affiliate <strong>tag</strong>
          (longer URLs, not <code>link.amazon</code>). Paste a fresh SiteStripe cURL below to restore it.
          {status.expiredAt ? <span className="meta"> (since {new Date(status.expiredAt).toLocaleString()})</span> : null}
        </div>
      )}

      <p className="subtitle">Choose which stores are active and how their affiliate links are generated. Expand a store to configure it.</p>

      {/* ── Amazon ─────────────────────────────────────────────────────── */}
      <Collapsible
        className="platform-section"
        title={
          <span className="platform-title">
            Amazon
            <span className={`badge ${amazonActive ? 'ok' : 'off'}`}>{amazonActive ? 'Active' : 'Off'}</span>
          </span>
        }
      >
        <div className="platform-switch">
          <Toggle checked={amazonActive} onChange={toggleAmazon} label="Amazon enabled" />
        </div>

        <Collapsible title="Link mode &amp; tag" bare>
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
        </Collapsible>

        <Collapsible title="SiteStripe session" bare>
          <p className="subtitle">
            Paste the SiteStripe <code>getShortUrl</code> cURL (DevTools → Network → Copy as cURL). Needed for SITE_STRIPE mode.
          </p>

          <div className="statusbox">
            {status && status.configured ? (
              <>
                <div>
                  <strong>Session configured</strong>{' '}
                  {status.status === 'expired'
                    ? <span className="badge" style={{ background: 'rgba(248,113,113,.14)', color: 'var(--red)', borderColor: 'rgba(248,113,113,.4)', marginLeft: 4 }}>expired</span>
                    : <span className="badge ok" style={{ marginLeft: 4 }}>active</span>}
                </div>
                {status.status === 'expired' && (
                  <div className="status err" style={{ marginTop: 6 }}>
                    ⚠ This SiteStripe session has expired — paste a fresh cURL below.
                    {status.expiredAt ? ` (since ${new Date(status.expiredAt).toLocaleString()})` : ''}
                  </div>
                )}
                <div className="meta">endpoint: {status.endpoint}</div>
                <div className="meta">cookies: {status.hasCookies ? `${status.cookieCount} present` : 'none'}</div>
                {status.configuredAt && <div className="meta">saved: {new Date(status.configuredAt).toLocaleString()}</div>}
                {status.testedAt && <div className="meta">last tested: {new Date(status.testedAt).toLocaleString()}</div>}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="secondary" onClick={testSession} disabled={testing}>{testing ? 'Testing…' : 'Test session'}</button>
                  {testMsg && <span className={`status ${testMsg.type}`}>{testMsg.text}</span>}
                </div>
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
      </Collapsible>

      {/* ── Flipkart ───────────────────────────────────────────────────── */}
      <Collapsible
        className="platform-section"
        title={
          <span className="platform-title">
            Flipkart
            <span className={`badge ${fk.active ? 'ok' : 'off'}`}>{fk.active ? 'Active' : 'Off'}</span>
          </span>
        }
      >
        <div className="platform-switch">
          <Toggle
            checked={fk.active}
            onChange={(next) => saveFlipkart({ active: next, botUsername: fkUser })}
            label="Flipkart enabled"
          />
        </div>

        <Collapsible title="Conversion bot" bare>
          <p className="subtitle">
            Flipkart links are converted by your <strong>conversion bot</strong> (e.g. an EarnKaro bot). Because Telegram
            bots can't message other bots, this runs through your logged-in Telegram account —
            set that up under{' '}
            <a className="inline-link" onClick={() => onNavigate && onNavigate('telegram-login')}>Telegram login</a>{' '}
            first. Paste a Flipkart link anywhere Amazon works and it's converted the same way.
          </p>

          <label htmlFor="fkbot">Conversion bot @username</label>
          <input id="fkbot" type="text" value={fkUser} onChange={(e) => setFkUser(e.target.value)} placeholder="e.g. @EarnKaroBot" />
          <div className="row">
            <button onClick={() => saveFlipkart()} disabled={savingFk}>{savingFk ? 'Saving…' : 'Save Flipkart'}</button>
            {fkSave && <span className={`status ${fkSave.type}`}>{fkSave.text}</span>}
          </div>
        </Collapsible>

        <Collapsible title="Test Flipkart conversion" bare>
          <p className="subtitle">Paste a real Flipkart product link to confirm the bot converts it. This messages your conversion bot only — it does not post to any channel.</p>
          <label htmlFor="fktest">Flipkart product link</label>
          <input id="fktest" type="text" value={fkTestUrl} onChange={(e) => setFkTestUrl(e.target.value)} placeholder="https://www.flipkart.com/... or https://dl.flipkart.com/..." />
          <div className="row">
            <button className="secondary" onClick={testFlipkart} disabled={fkTesting || fkTestUrl.trim() === ''}>{fkTesting ? 'Testing…' : 'Test conversion'}</button>
          </div>
          {fkTestMsg && <p className={`status ${fkTestMsg.type}`} style={{ wordBreak: 'break-all' }}>{fkTestMsg.text}</p>}
        </Collapsible>
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
  const [reReg, setReReg] = useState(false);
  async function reregister() {
    if (!confirm('Re-register the bot? Channels and all settings are kept — this just refreshes Telegram permissions (needed for Price Tracker buttons).')) return;
    setReReg(true);
    try {
      const res = await authFetch('api/admin/telegram/reregister', { method: 'POST', body: '{}' });
      const data = await res.json();
      if (!data.success) alert(data.error || 'Could not re-register the bot.');
      else alert('Bot re-registered ✓ — inline buttons are now active.');
      load();
    } finally {
      setReReg(false);
    }
  }
  async function removeChannel(id) {
    if (!window.confirm('Remove this channel from the bot? The bot will stop posting to it.')) return;
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
          <div className="statusbox" onClick={() => setExpanded((v) => !v)} style={{ cursor: 'pointer' }}>
            <div>
              <strong>@{tg.username || 'bot'}</strong>{' '}
              {tg.confirmed ? <span className="badge ok">active</span> : <span className="badge">setup pending</span>}
              <span className="chev" style={{ float: 'right' }}>{expanded ? '▲' : '▼'}</span>
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
                <button className="secondary" onClick={reregister} disabled={reReg}>{reReg ? 'Re-registering…' : 'Re-register bot'}</button>
                <button className="link" onClick={removeBot}>Remove bot</button>
              </div>
              <p className="meta" style={{ marginTop: 4 }}>
                “Re-register bot” refreshes the webhook so inline buttons (Price Tracker) work. Safe — channels &amp; settings are preserved.
              </p>
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

function ListenerConfig({ authFetch, onNavigate }) {
  const [listeners, setListeners] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [msgFor, setMsgFor] = useState(null); // { username, limit }
  const [mtLoggedIn, setMtLoggedIn] = useState(null);

  async function load() {
    const res = await authFetch('api/admin/listener');
    const data = await res.json();
    setListeners(data.listeners || []);
  }
  async function loadMt() {
    try {
      const res = await authFetch('api/admin/mtproto');
      const data = await res.json();
      setMtLoggedIn(!!(data.mtproto && data.mtproto.loggedIn));
    } catch { setMtLoggedIn(false); }
  }
  useEffect(() => {
    load().catch(() => {});
    loadMt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(username) {
    if (!window.confirm(`Remove listener @${username}? It will stop being read and auto-posted.`)) return;
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
        Read Telegram channels and re-publish their Amazon &amp; Flipkart deals with your affiliate links. Public
        channels work with no setup; private groups / preview-disabled channels need Telegram login.
      </p>

      {mtLoggedIn === false && (
        <div className="hintbox">
          Private group or preview-disabled channel? You'll need to log in with a Telegram user account first.{' '}
          <a className="inline-link" onClick={() => onNavigate && onNavigate('telegram-login')}>Set up Telegram login →</a>
        </div>
      )}

      <div className="sub-title" style={{ marginTop: 20 }}>Channels</div>
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
          onNavigate={onNavigate}
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
          <strong>{channel.title}</strong> <span className="meta">@{channel.username}</span>{' '}
          <span className="badge" style={{ marginLeft: 2 }}>
            {channel.source === 'mtproto' ? 'logged-in' : 'public'}
          </span>
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

function AddListenerModal({ authFetch, onClose, onSaved, onNavigate }) {
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
      const res = await authFetch('api/admin/listener/add', {
        method: 'POST',
        body: JSON.stringify({ channel, title, source: preview && preview.source }),
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
    <Modal title="Add listener channel" onClose={onClose}>
      <p className="subtitle">
        Enter a channel or group (@username or t.me link), then test-read it. Public channels read directly;
        groups / private channels use your logged-in Telegram access (set up above).
      </p>
      <label htmlFor="ch">Channel / group</label>
      <input id="ch" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="https://t.me/FLTlooters or @FLTlooters" />
      <div className="row">
        <button className="secondary" onClick={test} disabled={busy || channel.trim() === ''}>{busy ? 'Reading…' : 'Test read'}</button>
      </div>
      {error && (
        <>
          <p className="status err">{error}</p>
          {/(log ?in|logged.?in|member|private|mtproto|preview)/i.test(error) && (
            <p className="meta">
              This looks like a private group / preview-disabled channel.{' '}
              <a className="inline-link" onClick={() => { onClose(); onNavigate && onNavigate('telegram-login'); }}>
                Set up Telegram login →
              </a>
            </p>
          )}
        </>
      )}

      {preview && (
        <>
          <div className="statusbox">
            <div>
              <strong>@{preview.username}</strong> — last {preview.messages.length} messages{' '}
              <span className={`badge ${preview.source === 'mtproto' ? '' : 'ok'}`} style={{ marginLeft: 4 }}>
                {preview.source === 'mtproto' ? 'via logged-in access' : 'public'}
              </span>
            </div>
            {preview.messages.map((m) => (
              <div key={m.id} className="meta" style={{ marginTop: 6 }}>• {(m.text || '').slice(0, 90) || '(no text)'}</div>
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

/* ─────────────────────────── Telegram login (New) ─────────────────────────── */

function TelegramLogin({ authFetch }) {
  return (
    <>
      <p className="subtitle">
        <span className="badge">new · optional</span> Log in with a Telegram <strong>user account</strong> (not the bot).
        This unlocks three things: reading <strong>private groups</strong> / preview-disabled channels in listeners,
        converting <strong>Flipkart</strong> links through your conversion bot, and <strong>importing users</strong>.
        It's read-only for listening; nothing is auto-posted from here.
      </p>

      <div className="guide">
        <div className="sub-title">Setup — two steps</div>
        <ol className="steps">
          <li>
            <strong>Get your API keys.</strong> Open <code>my.telegram.org</code> → log in → <em>API development tools</em> →
            create an app. Copy the <code>api_id</code> (a number) and <code>api_hash</code> (a long hex string).
            You can create these on any of your accounts.
          </li>
          <li>
            <strong>Log in with your phone.</strong> Save the keys below, then click <em>Log in with phone</em>, enter the
            code Telegram sends you (and your 2-step password if you have one). Use the account that is a <em>member</em>
            of the groups you want to read / import from.
          </li>
        </ol>
        <p className="meta">Your api_hash and session are stored securely and never shown again. Use “Clear credentials” to switch accounts.</p>
      </div>

      <MtprotoAccess authFetch={authFetch} />
    </>
  );
}

/* ─────────────────────────── Import users (beta) ─────────────────────────── */

const WELCOME_DEFAULT = `🔥 Welcome to DealVerse! 🔥

Yahan milegi Amazon, Flipkart, Myntra, Meesho aur dusri online shopping websites ki best deals, offers aur lowest-price products 🛍️💸

✅ Best price comparison
🔥 Latest offers & discounts
⚡ Limited-time deals

Kuch buy karna ho? Hume message karo — hum aapke liye best possible deal dhoondhne ki koshish karenge.

---

🎁 2% Cashback bhi pao!

🛒 Buy karo • Screenshot bhejo • 2% Cashback pao!

Channel se buy karo ya @DealVerse_Auto_bot se apna product link banao.

📸 Purchase ka screenshot bhejo → eligible purchase verify hone par 2% cashback UPI se diya jayega.

📌 T&C: Affiliate commission receive hone ke baad hi 2% cashback diya jayega.

📩 Contact: @Deal_verse_08

🚀 DealVerse ko join karke rakho — best deal kabhi bhi aa sakti hai!`;

// 12 hours after HH:MM (wraps past midnight). Used for the "twice a day" option.
function plus12h(hhmm) {
  const [h, m] = String(hhmm || '08:00').split(':').map((x) => parseInt(x, 10) || 0);
  return `${String((h + 12) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ImportUsers({ authFetch, onNavigate }) {
  // daily auto-add
  const [auto, setAuto] = useState(null);
  const [timeOne, setTimeOne] = useState('08:00');
  const [twiceDaily, setTwiceDaily] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const [autoMsg, setAutoMsg] = useState(null);
  const [loggedIn, setLoggedIn] = useState(null);
  const [dialogs, setDialogs] = useState([]);
  const [pool, setPool] = useState(null);
  // fetch phase
  const [source, setSource] = useState('');
  const [fetchLimit, setFetchLimit] = useState(200);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState(null);
  // add phase (manual, one user at a time)
  const [target, setTarget] = useState('');
  const [addingId, setAddingId] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [rowErr, setRowErr] = useState({});
  const [floodStop, setFloodStop] = useState(false);
  const [addMsg, setAddMsg] = useState(null);
  const [errPopup, setErrPopup] = useState(null);
  // invite/DM message template
  const [message, setMessage] = useState('');
  const [savingMsg, setSavingMsg] = useState(false);
  const [msgSaved, setMsgSaved] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  async function loadPool() {
    const res = await authFetch('api/admin/mtproto/import/status');
    const data = await res.json();
    if (data.pool) { setPool(data.pool); setMessage((m) => m || data.pool.message || ''); }
  }
  async function init() {
    try {
      const res = await authFetch('api/admin/mtproto');
      const data = await res.json();
      const li = !!(data.mtproto && data.mtproto.loggedIn);
      setLoggedIn(li);
      if (li) {
        const dres = await authFetch('api/admin/mtproto/dialogs', { method: 'POST', body: JSON.stringify({ limit: 100 }) });
        const ddata = await dres.json();
        setDialogs((ddata.dialogs || []).filter((d) => d.isGroup || d.isChannel));
        await loadPool();
        try {
          const ares = await authFetch('api/admin/mtproto/import/auto');
          const adata = await ares.json();
          if (adata.auto) {
            setAuto({ ...adata.auto, welcome: adata.auto.welcome || WELCOME_DEFAULT });
            const times = adata.auto.times && adata.auto.times.length ? adata.auto.times : ['08:00'];
            setTimeOne(times[0]);
            setTwiceDaily(times.length >= 2);
          }
        } catch { /* ignore */ }
      }
    } catch { setLoggedIn(false); }
  }
  useEffect(() => { init(); /* eslint-disable-next-line */ }, []);

  async function saveAuto(patch) {
    setSavingAuto(true); setAutoMsg(null);
    try {
      const body = { ...auto, ...patch };
      const times = twiceDaily ? [timeOne, plus12h(timeOne)] : [timeOne];
      const res = await authFetch('api/admin/mtproto/import/auto', {
        method: 'POST',
        body: JSON.stringify({ enabled: body.enabled, times, count: Number(body.count), target: body.target, welcome: body.welcome }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setAuto({ ...data.auto, welcome: data.auto.welcome || WELCOME_DEFAULT });
      if (data.auto.times && data.auto.times.length) {
        setTimeOne(data.auto.times[0]);
        setTwiceDaily(data.auto.times.length >= 2);
      }
      setAutoMsg({ type: 'ok', text: 'Saved.' });
    } catch (e) {
      setAutoMsg({ type: 'err', text: e.message });
    } finally { setSavingAuto(false); }
  }

  async function fetchMembers() {
    if (!source.trim()) return;
    setFetching(true); setFetchMsg(null);
    try {
      const res = await authFetch('api/admin/mtproto/import/fetch', { method: 'POST', body: JSON.stringify({ source, limit: Number(fetchLimit) }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Fetch failed.');
      setPool(data.pool);
      setFetchMsg({ type: 'ok', text: `Pool now has ${data.pool.counts.pending} pending member(s).` });
    } catch (e) { setFetchMsg({ type: 'err', text: e.message }); } finally { setFetching(false); }
  }

  async function addOne(id) {
    if (!target.trim()) { setErrPopup('Select a destination channel at the top of Step 2 first.'); return; }
    setAddingId(id); setAddMsg(null);
    setRowErr((p) => { const n = { ...p }; delete n[id]; return n; });
    try {
      const res = await authFetch('api/admin/mtproto/import/add-one', { method: 'POST', body: JSON.stringify({ target, userId: id }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Add failed.');
      const r = data.result;
      if (r.pool) setPool(r.pool);
      if (r.status !== 'added') {
        // Surface the whole raw Telegram error in a pop-up.
        const full = r.error || `Telegram returned status: ${r.status}`;
        setErrPopup(full);
        setRowErr((p) => ({ ...p, [id]: full }));
        if (r.status === 'flood') setFloodStop(true);
      }
    } catch (e) {
      setErrPopup(e.message); // e.g. daily cap reached, channel resolve failed, session expired
    } finally { setAddingId(null); }
  }

  async function saveMessage() {
    setSavingMsg(true); setMsgSaved(false);
    try {
      const res = await authFetch('api/admin/mtproto/import/message', { method: 'POST', body: JSON.stringify({ message }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      if (data.pool) setPool(data.pool);
      setMsgSaved(true);
    } catch (e) { setErrPopup(e.message); } finally { setSavingMsg(false); }
  }

  async function sendOne(id) {
    if (!message.trim()) { setErrPopup('Write the invite message first (the box at the top of Step 2).'); return; }
    setSendingId(id); setRowErr((p) => { const n = { ...p }; delete n[id]; return n; });
    try {
      const res = await authFetch('api/admin/mtproto/import/send-one', { method: 'POST', body: JSON.stringify({ userId: id, message }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Send failed.');
      const r = data.result;
      if (r.pool) setPool(r.pool);
      if (r.status !== 'sent') {
        const full = r.error || `Telegram returned status: ${r.status}`;
        setErrPopup(full);
        setRowErr((p) => ({ ...p, [id]: full }));
        if (r.status === 'flood') setFloodStop(true);
      }
    } catch (e) { setErrPopup(e.message); } finally { setSendingId(null); }
  }

  async function syncTarget() {
    if (!target.trim()) { setErrPopup('Select the target channel first.'); return; }
    setSyncBusy(true);
    try {
      const res = await authFetch('api/admin/mtproto/import/sync-target', { method: 'POST', body: JSON.stringify({ target }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Sync failed.');
      if (data.result && data.result.pool) setPool(data.result.pool);
      setAddMsg({ type: 'ok', text: `Removed ${data.result.removed} member(s) already in the channel.` });
    } catch (e) { setErrPopup(e.message); } finally { setSyncBusy(false); }
  }

  async function clearPool() {
    if (!confirm('Clear the saved candidate pool? This does not remove anyone already added to your channel.')) return;
    const res = await authFetch('api/admin/mtproto/import/clear', { method: 'POST', body: '{}' });
    const data = await res.json();
    if (data.pool) { setPool(data.pool); setRowErr({}); setFloodStop(false); setFetchMsg(null); setAddMsg(null); }
  }

  if (loggedIn === null) return <p className="meta">Loading…</p>;

  if (!loggedIn) {
    return (
      <>
        <p className="subtitle">
          <span className="badge">beta</span> Import members from a group you're in into your own channel.
        </p>
        <div className="hintbox">
          This needs a logged-in Telegram user account.{' '}
          <a className="inline-link" onClick={() => onNavigate && onNavigate('telegram-login')}>Set up Telegram login →</a>
        </div>
      </>
    );
  }

  const c = (pool && pool.counts) || { total: 0, pending: 0, added: 0, privacy: 0, failed: 0 };

  return (
    <>
      <p className="subtitle">
        <span className="badge">beta</span> <strong>Step 1:</strong> fetch members from a source group into a saved pool.{' '}
        <strong>Step 2:</strong> pick your channel, then add members <strong>one at a time</strong> by clicking each row.
      </p>

      <div className="banner-warn">
        ⚠ <strong>Use sparingly.</strong> Telegram treats bulk-adding as spam — most people's privacy blocks it, and your
        account gets <strong>flood-limited after only a few</strong>. Fetching is safe (read-only); each add is the risky
        part (capped 30/day). Add a little, over days. Any Telegram error is shown to you in full.
      </div>

      {/* Pool status */}
      <div className="statusbox">
        <div className="pool-stats">
          <span className="pool-stat"><b>{c.total}</b> in pool</span>
          <span className="pool-stat pending"><b>{c.pending}</b> pending</span>
          <span className="pool-stat added"><b>{c.added}</b> added</span>
          <span className="pool-stat privacy"><b>{c.privacy}</b> privacy-blocked</span>
          <span className="pool-stat failed"><b>{c.failed}</b> failed</span>
        </div>
        {pool && pool.source && <div className="meta" style={{ marginTop: 6 }}>source: {pool.source}{pool.fetchedAt ? ` · fetched ${new Date(pool.fetchedAt).toLocaleString()}` : ''}</div>}
        {pool && pool.target && <div className="meta">last target: {pool.target}</div>}
        {c.total > 0 && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="link danger" onClick={clearPool}>Clear pool</button>
          </div>
        )}
      </div>

      {/* Step 1 — fetch */}
      <Collapsible title="Step 1 · Fetch members into the pool" bare>
        <label htmlFor="src">Source group (this account must be a member)</label>
        <input id="src" type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="@somegroup or https://t.me/somegroup" />
        <label htmlFor="flim" style={{ marginTop: 12 }}>Max members to read this fetch</label>
        <input id="flim" className="num" type="number" min="1" max="500" value={fetchLimit} onChange={(e) => setFetchLimit(e.target.value)} style={{ width: 90 }} />
        <p className="meta">Reading is safe. New members are added to the pool as “pending”; duplicates are skipped.</p>
        <div className="row">
          <button onClick={fetchMembers} disabled={fetching || !source.trim()}>{fetching ? 'Fetching…' : 'Fetch members'}</button>
          {fetchMsg && <span className={`status ${fetchMsg.type}`}>{fetchMsg.text}</span>}
        </div>
      </Collapsible>

      {/* Step 2 — add / message members one by one */}
      <Collapsible title={`Step 2 · Add members to your channel${pool && pool.users ? ` (${pool.users.length})` : ''}`} bare>
        <label htmlFor="tgt">Target — your channel/group (only ones you admin are listed)</label>
        <select id="tgt" className="select" value={target} onChange={(e) => { setTarget(e.target.value); setAddMsg(null); }}>
          <option value="">Select a destination…</option>
          {dialogs.filter((d) => d.admin).map((d) => (
            <option key={d.id} value={d.username || d.id}>
              {d.title}{d.username ? ` (@${d.username})` : ''}
            </option>
          ))}
        </select>
        {dialogs.length > 0 && dialogs.filter((d) => d.admin).length === 0 && (
          <p className="meta">No channels where this account is an admin. Make this account an admin (with “Add members”) of your channel.</p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={syncTarget} disabled={syncBusy || !target.trim()}>
            {syncBusy ? 'Checking…' : 'Remove members already in this channel'}
          </button>
          {addMsg && <span className={`status ${addMsg.type}`}>{addMsg.text}</span>}
        </div>

        {/* Invite / DM message template */}
        <label htmlFor="invmsg" style={{ marginTop: 16 }}>Invite message (used by “Send message”)</label>
        <textarea id="invmsg" value={message} onChange={(e) => { setMessage(e.target.value); setMsgSaved(false); }}
          placeholder={'Hi! Join our channel for the best prices + an extra 2% cashback from us — guaranteed lowest, just try once.\nChannel: https://t.me/yourchannel\nBot: https://t.me/yourbot'} />
        <div className="row">
          <button className="secondary" onClick={saveMessage} disabled={savingMsg}>{savingMsg ? 'Saving…' : 'Save message'}</button>
          {msgSaved && <span className="status ok">✓ saved</span>}
        </div>
        <p className="meta">
          Tip: if adding hits a flood limit, you can still <strong>Send message</strong> to invite people to join on their own.
          But note — cold-DMing strangers is also treated as spam and can get the account limited; use it sparingly (max {20}/day).
        </p>

        {floodStop && (
          <div className="banner-warn" style={{ marginTop: 12 }}>
            ⛔ Telegram hit this account with a <strong>flood limit</strong>. Stop now and wait (hours–days) — retrying makes it
            worse. Check <code>@SpamBot</code> in Telegram for status. The pool is saved; continue later.
          </div>
        )}

        {(!pool || !pool.users || pool.users.length === 0) ? (
          <p className="meta" style={{ marginTop: 12 }}>No members in the pool yet — fetch some in Step 1.</p>
        ) : (
          <div className="pool-list" style={{ marginTop: 12 }}>
            {pool.users.map((u) => (
              <div key={u.id} className="pool-row">
                <span className="pool-user">{u.username ? '@' + u.username : (u.firstName || 'user')}</span>
                <span className={`badge ${u.status === 'added' ? 'ok' : u.status === 'pending' ? '' : 'off'}`}>{u.status}</span>
                {u.messagedAt && <span className="badge" title={`messaged ${new Date(u.messagedAt).toLocaleString()}`}>messaged</span>}
                <span className="pool-actions">
                  {u.status === 'pending' && (
                    <button className="secondary pool-btn" disabled={!target.trim() || addingId === u.id || floodStop} onClick={() => addOne(u.id)}>
                      {addingId === u.id ? 'Adding…' : 'Add to channel'}
                    </button>
                  )}
                  <button className="secondary pool-btn" disabled={sendingId === u.id || floodStop} onClick={() => sendOne(u.id)}>
                    {sendingId === u.id ? 'Sending…' : 'Send message'}
                  </button>
                </span>
                {(rowErr[u.id] || u.lastError || u.messageError) && <span className="meta pool-err">{rowErr[u.id] || u.lastError || u.messageError}</span>}
              </div>
            ))}
          </div>
        )}
      </Collapsible>

      {/* Step 3 — daily automation */}
      {auto && (
        <Collapsible title={`Automation · scheduled auto-add${auto.enabled ? ' (on)' : ' (off)'}`} bare>
          <p className="subtitle">
            At each scheduled time, automatically add up to {auto.count || 5} pending members to a channel, remove them from
            the pool, and post your welcome message there. Each run is kept small ({'≤'}5) to stay under Telegram's flood limit.
          </p>

          <div className="row" style={{ margin: '4px 0 14px' }}>
            <Toggle checked={auto.enabled} onChange={(v) => saveAuto({ enabled: v })} label="Enable scheduled auto-add" />
          </div>

          <div className="auto-grid">
            <div>
              <label htmlFor="atime">Time (IST, 24h)</label>
              <input id="atime" type="time" className="select" value={timeOne} onChange={(e) => setTimeOne(e.target.value)} />
            </div>
            <div>
              <label htmlFor="acount">Members per run (max 5)</label>
              <input id="acount" className="num" type="number" min="1" max="5" value={auto.count || 5} onChange={(e) => setAuto({ ...auto, count: e.target.value })} />
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <Toggle checked={twiceDaily} onChange={setTwiceDaily} label="Run twice a day" />
          </div>
          <p className="meta">
            {twiceDaily
              ? <>Runs at <strong>{timeOne}</strong> and <strong>{plus12h(timeOne)}</strong> (12 hours apart), each once per day.</>
              : <>Runs once a day at <strong>{timeOne}</strong>. Turn on “Run twice a day” to also run at <strong>{plus12h(timeOne)}</strong>.</>}
          </p>

          <label htmlFor="atgt" style={{ marginTop: 12 }}>Target channel (you must be admin)</label>
          <select id="atgt" className="select" value={auto.target || ''} onChange={(e) => setAuto({ ...auto, target: e.target.value })}>
            <option value="">Select a destination…</option>
            {dialogs.filter((d) => d.admin).map((d) => (
              <option key={d.id} value={d.username || d.id}>{d.title}{d.username ? ` (@${d.username})` : ''}</option>
            ))}
          </select>

          <label htmlFor="awelcome" style={{ marginTop: 12 }}>Welcome message (posted to the channel after adding)</label>
          <textarea id="awelcome" value={auto.welcome || ''} onChange={(e) => setAuto({ ...auto, welcome: e.target.value })} style={{ minHeight: 220 }} />

          <div className="row">
            <button onClick={() => saveAuto({})} disabled={savingAuto}>{savingAuto ? 'Saving…' : 'Save automation'}</button>
            {autoMsg && <span className={`status ${autoMsg.type}`}>{autoMsg.text}</span>}
          </div>

          <p className="meta">Runs on the 5-minute cron; the first tick at/after each time fires that slot once.</p>

          {auto.history && auto.history.length > 0 && (
            <>
              <div className="sub-title" style={{ marginTop: 18 }}>Recent runs</div>
              <div className="pool-list">
                {[...auto.history].reverse().map((h, i) => {
                  const total = (h.added || 0) + (h.privacy || 0) + (h.failed || 0);
                  return (
                    <div key={i} className="pool-row">
                      <span className="pool-user">{h.at ? new Date(h.at).toLocaleString() : (h.slot || '')}</span>
                      <span className={`badge ${h.added ? 'ok' : 'off'}`}>added {h.added || 0}</span>
                      {h.privacy ? <span className="badge">privacy {h.privacy}</span> : null}
                      {h.failed ? <span className="badge off">failed {h.failed}</span> : null}
                      {h.flooded ? <span className="badge off">flood-stopped</span> : null}
                      {h.welcomeSent ? <span className="badge ok">welcome</span> : null}
                      {h.note ? <span className="meta">{h.note}</span> : null}
                    </div>
                  );
                })}
              </div>
              <p className="meta" style={{ marginTop: 8 }}>
                Total added by automation: <strong>{auto.history.reduce((s, h) => s + (h.added || 0), 0)}</strong> across {auto.history.length} run(s) shown.
              </p>
            </>
          )}
        </Collapsible>
      )}

      {errPopup && (
        <Modal title="Telegram response" onClose={() => setErrPopup(null)}>
          <p className="subtitle">The add did not go through. Telegram's exact response:</p>
          <pre className="err-dump">{errPopup}</pre>
          <div className="row">
            <button className="secondary" onClick={() => setErrPopup(null)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ─────────────────────────── MTProto (beta) ─────────────────────────── */

// Replace each source link in a message with its affiliate link (shared shape
// with the listener flow). Kept local so MTProto stays fully additive.
function composeAffiliateText(msg) {
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

// Optional "logged-in Telegram access" — shown at the top of the Listener
// section. Enables reading private groups / preview-disabled channels. When
// present, listeners auto-use it; without it they read public channels only.
function MtprotoAccess({ authFetch, startOpen = false }) {
  const [st, setSt] = useState(null);
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [savingApi, setSavingApi] = useState(false);
  const [apiMsg, setApiMsg] = useState(null);
  const [showLogin, setShowLogin] = useState(false);

  async function load() {
    const res = await authFetch('api/admin/mtproto');
    const data = await res.json();
    if (data.mtproto) {
      setSt(data.mtproto);
      if (data.mtproto.apiId) setApiId((v) => v || data.mtproto.apiId);
    }
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line */ }, []);

  async function saveApi() {
    setSavingApi(true); setApiMsg(null);
    try {
      const res = await authFetch('api/admin/mtproto/api', { method: 'POST', body: JSON.stringify({ apiId, apiHash }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
      setSt(data.mtproto); setApiHash(''); setApiMsg({ type: 'ok', text: 'Saved.' });
    } catch (e) { setApiMsg({ type: 'err', text: e.message }); } finally { setSavingApi(false); }
  }

  async function logout() {
    if (!confirm('Log the Telegram user account out and revoke its session?')) return;
    const res = await authFetch('api/admin/mtproto/logout', { method: 'POST', body: '{}' });
    const data = await res.json();
    if (data.mtproto) setSt(data.mtproto);
  }

  async function clearCreds() {
    if (!confirm('Clear ALL credentials and the session? You can then set up a different account.')) return;
    const res = await authFetch('api/admin/mtproto/clear', { method: 'POST', body: '{}' });
    const data = await res.json();
    if (data.mtproto) { setSt(data.mtproto); setApiId(''); setApiHash(''); setApiMsg(null); }
  }

  const apiConfigured = st && st.apiConfigured;
  const loggedIn = st && st.loggedIn;
  const summary = loggedIn
    ? `logged in${st.user && st.user.username ? ' · @' + st.user.username : ''}`
    : apiConfigured ? 'credentials saved · not logged in' : 'not set up';

  return (
    <Collapsible title={`Logged-in Telegram access — ${summary}`} bare defaultOpen={startOpen}>
      <p className="subtitle">
        <span className="badge">beta · optional</span> Not required. Without it, listeners read only
        <strong> public channels</strong> with a t.me preview. Log in with a Telegram <strong>user account</strong>
        (a member of the groups) to also read <strong>private groups</strong> and preview-disabled channels — then
        the listener uses the right method automatically. Read-only; nothing is auto-posted.
      </p>

      <Collapsible title="API credentials" bare>
        <p className="subtitle">
          Create an app at <code>my.telegram.org → API development tools</code> for an <code>api_id</code> and
          <code> api_hash</code>. The api_hash is stored securely and never shown again. (You can create these on
          any account — the phone login below is what actually reads.)
        </p>
        <div className="statusbox">
          {apiConfigured
            ? <div className="meta">api_id <strong>{st.apiId}</strong> · api_hash saved ✅</div>
            : <div className="meta">Not configured yet.</div>}
        </div>
        <label htmlFor="mapi">api_id</label>
        <input id="mapi" type="text" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="1234567" />
        <label htmlFor="mhash" style={{ marginTop: 12 }}>api_hash</label>
        <input id="mhash" type="password" value={apiHash} onChange={(e) => setApiHash(e.target.value)}
          placeholder={apiConfigured ? '•••••••• (saved — enter to replace)' : '0123456789abcdef0123456789abcdef'} />
        <div className="row">
          <button onClick={saveApi} disabled={savingApi || apiId.trim() === '' || apiHash.trim() === ''}>
            {savingApi ? 'Saving…' : 'Save credentials'}
          </button>
          {apiMsg && <span className={`status ${apiMsg.type}`}>{apiMsg.text}</span>}
        </div>
      </Collapsible>

      <div className="sub-title" style={{ marginTop: 20 }}>Account</div>
      <div className="statusbox">
        {loggedIn ? (
          <>
            <div>
              <strong>{st.user && (st.user.firstName || st.user.username || 'Logged in')}</strong>
              {st.user && st.user.username ? <span className="meta"> · @{st.user.username}</span> : null}
              <span className="badge ok" style={{ marginLeft: 6 }}>logged in</span>
            </div>
            {st.user && st.user.phone && <div className="meta">phone: {st.user.phone}</div>}
            {st.loggedInAt && <div className="meta">since: {new Date(st.loggedInAt).toLocaleString()}</div>}
          </>
        ) : (
          <div className="meta">
            Not logged in.{st && st.awaitingCode ? ` A login code was requested for ${st.pendingPhone || 'your number'} — continue login to enter it.` : ''}
          </div>
        )}
      </div>
      <div className="row">
        {!loggedIn && (
          <button disabled={!apiConfigured} onClick={() => setShowLogin(true)} title={apiConfigured ? '' : 'Save API credentials first'}>
            {st && st.awaitingCode ? 'Continue login' : 'Log in with phone'}
          </button>
        )}
        {loggedIn && <button className="link danger" onClick={logout}>Log out</button>}
        {(apiConfigured || loggedIn || (st && st.awaitingCode)) && (
          <button className="link danger" onClick={clearCreds}>Clear credentials</button>
        )}
      </div>

      {showLogin && (
        <MtprotoLoginModal
          authFetch={authFetch}
          onClose={() => setShowLogin(false)}
          onDone={() => { setShowLogin(false); load(); }}
        />
      )}
    </Collapsible>
  );
}

function MtprotoLoginModal({ authFetch, onClose, onDone }) {
  const [step, setStep] = useState(1); // 1 = phone, 2 = code (+2fa)
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If a code was already requested in a previous session, jump straight to step 2.
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('api/admin/mtproto');
        const data = await res.json();
        if (data.mtproto && data.mtproto.awaitingCode) setStep(2);
      } catch { /* ignore */ }
    })();
  }, [authFetch]);

  async function sendCode() {
    setBusy(true); setError(null);
    try {
      const res = await authFetch('api/admin/mtproto/send-code', { method: 'POST', body: JSON.stringify({ phone }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not send code.');
      setStep(2);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function signIn() {
    setBusy(true); setError(null);
    try {
      const res = await authFetch('api/admin/mtproto/sign-in', { method: 'POST', body: JSON.stringify({ code, password }) });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // 401 with a 2FA prompt → reveal the password field and let them retry.
        if (res.status === 401 && /two-step|password/i.test(data.error || '')) {
          setNeedPassword(true);
          throw new Error(data.error || 'Enter your two-step verification password.');
        }
        throw new Error(data.error || 'Sign in failed.');
      }
      onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Log in with a Telegram account" onClose={onClose}>
      {step === 1 && (
        <>
          <p className="subtitle">Step 1 — enter the phone number of the account. Telegram will send it a login code.</p>
          <label htmlFor="mp">Phone (international)</label>
          <input id="mp" type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+9198XXXXXXXX" autoFocus />
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button onClick={sendCode} disabled={busy || phone.trim() === ''}>{busy ? 'Sending…' : 'Send code'}</button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="subtitle">Step 2 — enter the login code Telegram sent (in the app / SMS). Add your two-step password only if prompted.</p>
          <label htmlFor="mc">Login code</label>
          <input id="mc" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="12345" autoFocus />
          {needPassword && (
            <>
              <label htmlFor="m2fa" style={{ marginTop: 12 }}>Two-step verification password</label>
              <input id="m2fa" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </>
          )}
          {error && <p className="status err">{error}</p>}
          <div className="row">
            <button onClick={signIn} disabled={busy || code.trim() === ''}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <button className="secondary" onClick={() => { setStep(1); setError(null); }}>Back</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function MtprotoMessagesModal({ authFetch, peer, limit, onClose }) {
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState({}); // id -> 'sending' | 'ok' | error string

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await authFetch('api/admin/mtproto/messages', { method: 'POST', body: JSON.stringify({ peer, limit }) });
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
  }, [authFetch, peer, limit]);

  function msgHasAffiliate(msg) {
    return (msg.items || []).some((it) => it.affiliate && it.affiliate.affiliateUrl);
  }

  async function sendToChannel(msg) {
    if (!msgHasAffiliate(msg)) return;
    setSent((s) => ({ ...s, [msg.id]: 'sending' }));
    try {
      // Re-uses the EXISTING bot publish path (same as the listener feature).
      const res = await authFetch('api/admin/listener/publish', { method: 'POST', body: JSON.stringify({ text: composeAffiliateText(msg) }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed.');
      setSent((s) => ({ ...s, [msg.id]: 'ok' }));
    } catch (err) {
      setSent((s) => ({ ...s, [msg.id]: err.message }));
    }
  }

  return (
    <Modal title={`${peer} — last ${limit} messages`} onClose={onClose}>
      {loading && <p className="meta">Reading messages and generating affiliate links…</p>}
      {error && <p className="status err">{error}</p>}
      {!loading && messages.length === 0 && !error && <p className="meta">No messages found.</p>}
      {!loading && messages.map((m) => (
        <div key={m.id} className="msgcard">
          <div className="msgtext">{m.text || '(no text)'}</div>
          {(m.items || []).map((it, i) => (
            <div key={i} className="linkitem">
              {it.affiliate && it.affiliate.affiliateUrl ? (
                <a className="affiliate" href={it.affiliate.affiliateUrl} target="_blank" rel="noreferrer">{it.affiliate.affiliateUrl}</a>
              ) : (
                <span className="meta">⚠ {(it.affiliate && it.affiliate.error) || 'Could not convert'} — {it.sourceUrl}</span>
              )}
            </div>
          ))}
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
