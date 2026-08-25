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
        <h1 onClick={goHome} style={{ cursor: 'pointer' }}>DealVerse</h1>
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
      <AmazonConfig authFetch={authFetch} />
      <TelegramConfig authFetch={authFetch} />
      <ListenerConfig authFetch={authFetch} />
    </>
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
    <div className="card">
      <h2>Amazon affiliate config</h2>
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

      <hr className="divider" />

      <h2>SiteStripe session</h2>
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
    </div>
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

  const configured = tg && tg.configured;

  return (
    <div className="card">
      <h2>Telegram bot</h2>
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
              {(tg.channels || []).map((c) => (
                <div key={c.id} className="listrow">
                  <span>{c.title} <span className="meta">({c.id})</span></span>
                  <button className="link" onClick={() => removeChannel(c.id)}>remove</button>
                </div>
              ))}
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
    </div>
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

  // Poll for a channel post once we're detecting.
  useEffect(() => {
    if (step !== 2) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const res = await authFetch('api/admin/telegram');
        const data = await res.json();
        if (alive && data.telegram && data.telegram.lastChannel) setDetected(data.telegram.lastChannel);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
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

  return (
    <div className="card">
      <h2>Listener channels</h2>
      <p className="subtitle">
        Read public channels (no login) and re-publish their Amazon deals with your affiliate link.
      </p>

      {listeners.length === 0 && <p className="meta">No listener channels yet.</p>}
      {listeners.map((c) => (
        <div key={c.username} className="listrow">
          <span>{c.title} <span className="meta">(@{c.username})</span></span>
          <span>
            <button className="link" onClick={() => setMsgFor({ username: c.username, limit: 10 })}>last 10</button>
            <button className="link" onClick={() => setMsgFor({ username: c.username, limit: 20 })}>last 20</button>
            <button className="link" onClick={() => remove(c.username)}>remove</button>
          </span>
        </div>
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

  async function sendToChannel(msg) {
    const affUrl = msg.affiliate && msg.affiliate.affiliateUrl;
    if (!affUrl) return;
    const text = msg.sourceUrl ? msg.text.replace(msg.sourceUrl, affUrl) : `${msg.text}\n${affUrl}`;
    setSent((s) => ({ ...s, [msg.id]: 'sending' }));
    try {
      const res = await authFetch('api/admin/listener/publish', { method: 'POST', body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed.');
      setSent((s) => ({ ...s, [msg.id]: 'ok' }));
    } catch (err) {
      setSent((s) => ({ ...s, [msg.id]: err.message }));
    }
  }

  return (
    <Modal title={`@${channel} — last ${limit}`} onClose={onClose}>
      {loading && <p className="meta">Reading messages and generating affiliate links…</p>}
      {error && <p className="status err">{error}</p>}
      {!loading && messages.map((m) => (
        <div key={m.id} className="msgcard">
          <div className="msgtext">{m.text || '(no text)'}</div>
          {m.affiliate && m.affiliate.affiliateUrl && (
            <a className="affiliate" href={m.affiliate.affiliateUrl} target="_blank" rel="noreferrer">{m.affiliate.affiliateUrl}</a>
          )}
          {m.affiliate && m.affiliate.error && <div className="status err">{m.affiliate.error}</div>}
          {!m.sourceUrl && <div className="meta">No Amazon link in this message.</div>}
          {m.affiliate && m.affiliate.affiliateUrl && (
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
