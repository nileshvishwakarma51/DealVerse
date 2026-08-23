import React, { useEffect, useState } from 'react';

// The app is served from the same API Gateway stage as the backend, so API
// paths resolve relative to the current document (e.g. https://.../prod/).
const api = (p) => new URL(p, document.baseURI).toString();
const TOKEN_KEY = 'dv_admin_token';

export default function App() {
  const [view, setView] = useState('user'); // 'user' | 'login' | 'admin'
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');

  function goAdmin() {
    setView(token ? 'admin' : 'login');
  }
  function onLoggedIn(t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    setView('admin');
  }
  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setView('user');
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>DealVerse</h1>
        {view === 'admin' ? (
          <button className="link" onClick={logout}>Log out</button>
        ) : (
          <button className="link" onClick={goAdmin}>Admin</button>
        )}
      </header>

      {view === 'user' && <UserPanel />}
      {view === 'login' && (
        <LoginPanel onLoggedIn={onLoggedIn} onCancel={() => setView('user')} />
      )}
      {view === 'admin' && (
        <AdminPanel token={token} onUnauthorized={logout} />
      )}
    </div>
  );
}

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
      <p className="subtitle">Paste an amazon.in product link to get an affiliate link.</p>

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
      <p className="subtitle">Enter the admin password to configure the affiliate session.</p>
      <label htmlFor="pw">Password</label>
      <input
        id="pw"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        autoFocus
      />
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

function AdminPanel({ token, onUnauthorized }) {
  const [mode, setMode] = useState('TAG');
  const [tag, setTag] = useState('');
  const [curl, setCurl] = useState('');
  const [status, setStatus] = useState(null); // masked sitestripe status
  const [amazonSave, setAmazonSave] = useState(null);
  const [curlSave, setCurlSave] = useState(null);
  const [savingAmazon, setSavingAmazon] = useState(false);
  const [savingCurl, setSavingCurl] = useState(false);

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  async function loadConfig() {
    const res = await fetch(api('api/admin/config'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return onUnauthorized();
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
      const res = await fetch(api('api/admin/amazon'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ mode, tag }),
      });
      if (res.status === 401) return onUnauthorized();
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
      const res = await fetch(api('api/admin/amazon/sitestripe'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ curl }),
      });
      if (res.status === 401) return onUnauthorized();
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
          <input
            type="radio"
            name="mode"
            checked={mode === 'SITE_STRIPE'}
            onChange={() => setMode('SITE_STRIPE')}
          />
          SITE_STRIPE <span className="meta">— live SiteStripe link, TAG fallback</span>
        </label>
      </div>

      <label htmlFor="tag" style={{ marginTop: 16 }}>Associate tag</label>
      <input
        id="tag"
        type="text"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder="e.g. dealverse08-21"
      />
      <p className="meta">Used for TAG mode and as the SITE_STRIPE fallback.</p>

      <div className="row">
        <button onClick={saveAmazon} disabled={savingAmazon}>
          {savingAmazon ? 'Saving…' : 'Save Settings'}
        </button>
        {amazonSave && <span className={`status ${amazonSave.type}`}>{amazonSave.text}</span>}
      </div>

      <hr className="divider" />

      <h2>SiteStripe session</h2>
      <p className="subtitle">
        Paste the SiteStripe <code>getShortUrl</code> cURL (DevTools → Network → right-click the
        request → Copy as cURL). Only needed for SITE_STRIPE mode.
      </p>

      <div className="statusbox">
        {status && status.configured ? (
          <>
            <div><strong>Session configured</strong></div>
            <div className="meta">endpoint: {status.endpoint}</div>
            <div className="meta">cookies: {status.hasCookies ? `${status.cookieCount} present` : 'none'}</div>
            {status.configuredAt && (
              <div className="meta">saved: {new Date(status.configuredAt).toLocaleString()}</div>
            )}
          </>
        ) : (
          <div className="meta">No session configured yet.</div>
        )}
      </div>

      <label htmlFor="curl">SiteStripe cURL</label>
      <textarea
        id="curl"
        value={curl}
        onChange={(e) => setCurl(e.target.value)}
        placeholder="curl 'https://www.amazon.in/associates/sitestripe/getShortUrl?...' -H '...' -b '...'"
      />

      <div className="row">
        <button onClick={saveCurl} disabled={savingCurl || curl.trim() === ''}>
          {savingCurl ? 'Saving…' : 'Save Session'}
        </button>
        {curlSave && <span className={`status ${curlSave.type}`}>{curlSave.text}</span>}
      </div>
    </div>
  );
}
