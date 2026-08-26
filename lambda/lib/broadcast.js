'use strict';

// Custom admin messages: send instantly, or schedule (daily times / weekly days
// / one-off), optionally pinned. Times are IST (Asia/Kolkata, no DST). The
// 5-minute tick evaluates schedules; a per-message lastSlot de-dups so each slot
// fires once.
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { publishToChannels } = require('./telegram');
const { logAudit } = require('./audit');

const BROADCASTS_KEY = 'broadcasts';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    day: d.getUTCDay(), // 0=Sun..6=Sat
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    hhmm: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
  };
}

function hhmmToMinutes(t) {
  const [h, m] = String(t).split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

async function getBroadcasts() {
  const cfg = await getConfig(BROADCASTS_KEY);
  return (cfg && cfg.items) || [];
}

function sanitize(b) {
  const times = Array.isArray(b.times)
    ? b.times.filter((t) => /^\d{1,2}:\d{2}$/.test(t)).slice(0, 6)
    : [];
  const days = Array.isArray(b.days) ? b.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
  return {
    id: b.id || `bc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    text: String(b.text || '').slice(0, 3500),
    pin: !!b.pin,
    enabled: b.enabled !== false,
    mode: b.mode === 'once' ? 'once' : 'recurring',
    times,
    days,
    onceAt: typeof b.onceAt === 'string' ? b.onceAt : null, // 'YYYY-MM-DDTHH:MM' IST
    lastSlot: b.lastSlot || null,
    createdAt: b.createdAt || new Date().toISOString(),
  };
}

async function saveBroadcast(input) {
  if (!input || !String(input.text || '').trim()) {
    throw new ApiError(400, 'Message text is required.');
  }
  const items = await getBroadcasts();
  const clean = sanitize(input);
  const idx = items.findIndex((b) => b.id === clean.id);
  if (idx >= 0) items[idx] = { ...items[idx], ...clean };
  else items.push(clean);
  await setConfig(BROADCASTS_KEY, { items });
  return items;
}

async function deleteBroadcast(id) {
  const items = (await getBroadcasts()).filter((b) => b.id !== id);
  await setConfig(BROADCASTS_KEY, { items });
  return items;
}

// Send a message to all active channels right now.
async function sendNow(text, pin) {
  if (!String(text || '').trim()) throw new ApiError(400, 'Message text is required.');
  const sent = await publishToChannels(text, { pin: !!pin });
  await logAudit('broadcast', `Sent custom message now to ${sent} channel(s)${pin ? ' (pinned)' : ''}.`);
  return { sent };
}

// Evaluate schedules on the tick. Returns how many messages were sent.
async function runBroadcasts() {
  const items = await getBroadcasts();
  if (!items.length) return { sent: 0 };
  const ist = istNow();
  let changed = false;
  let sent = 0;

  for (const b of items) {
    if (!b.enabled) continue;
    let slot = null;

    if (b.mode === 'once') {
      if (b.onceAt && `${ist.date}T${ist.hhmm}` >= b.onceAt && b.lastSlot !== b.onceAt) {
        slot = b.onceAt;
      }
    } else {
      const days = b.days && b.days.length ? b.days : [0, 1, 2, 3, 4, 5, 6];
      if (days.includes(ist.day)) {
        for (const t of b.times || []) {
          const diff = ist.minutes - hhmmToMinutes(t);
          if (diff >= 0 && diff <= 5) {
            const s = `${ist.date} ${t}`;
            if (b.lastSlot !== s) {
              slot = s;
              break;
            }
          }
        }
      }
    }

    if (slot) {
      const n = await publishToChannels(b.text, { pin: !!b.pin });
      sent += n;
      b.lastSlot = slot;
      if (b.mode === 'once') b.enabled = false;
      changed = true;
      await logAudit('broadcast', `Scheduled message sent to ${n} channel(s)${b.pin ? ' (pinned)' : ''}.`);
    }
  }

  if (changed) await setConfig(BROADCASTS_KEY, { items });
  return { sent };
}

module.exports = { getBroadcasts, saveBroadcast, deleteBroadcast, sendNow, runBroadcasts };
