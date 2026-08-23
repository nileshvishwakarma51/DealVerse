import React, { useEffect, useState } from 'react';

// The app is served from the same API Gateway stage as the backend, so we
// resolve "config" relative to the current document (e.g. https://.../prod/).
const CONFIG_URL = new URL('config', document.baseURI).toString();

export default function App() {
  const [curl, setCurl] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'ok' | 'err', text }
  const [updatedAt, setUpdatedAt] = useState(null);

  // Load the currently saved config on mount.
  useEffect(() => {
    fetch(CONFIG_URL)
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setCurl(data.config.curl || '');
          setUpdatedAt(data.config.updatedAt || null);
        }
      })
      .catch(() => {
        /* first load with no saved config is fine */
      });
  }, []);

  async function saveConfig() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setUpdatedAt(data.config?.updatedAt || null);
      setStatus({ type: 'ok', text: 'Config saved.' });
    } catch (err) {
      setStatus({ type: 'err', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app">
      <h1>DealVerse Config</h1>
      <p className="subtitle">Paste a curl command and save it to DynamoDB.</p>

      <label htmlFor="curl">curl command</label>
      <textarea
        id="curl"
        value={curl}
        onChange={(e) => setCurl(e.target.value)}
        placeholder="curl 'https://example.com' -H 'accept: application/json' ..."
      />

      <div className="row">
        <button onClick={saveConfig} disabled={saving || curl.trim() === ''}>
          {saving ? 'Saving…' : 'Save Config'}
        </button>
        {status && <span className={`status ${status.type}`}>{status.text}</span>}
      </div>

      {updatedAt && (
        <p className="meta">Last saved: {new Date(updatedAt).toLocaleString()}</p>
      )}
    </div>
  );
}
