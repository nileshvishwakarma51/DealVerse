'use strict';

// Telegram bot flow for the price tracker. Presentation only — persistence and
// alert logic live in pricetracker.js. Requiring ./telegram here is safe:
// telegram.js only lazy-requires this module (inside processUpdate).
const { ApiError } = require('./errors');
const { tgCall, sendMessage } = require('./telegram');
const { getProductPrice, parsePrice, round2 } = require('./price');
const affiliate = require('./affiliate');
const tracker = require('./pricetracker');
const state = require('./botstate');

const URL_RE = /https?:\/\/[^\s]+/i;
const firstUrl = (text) => {
  const m = String(text || '').match(URL_RE);
  return m ? m[0] : null;
};
const shortTitle = (t, n = 40) => {
  const s = String(t || 'product').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// Whether our affiliate program covers this product's marketplace. Flipkart is
// always eligible; for Amazon only amazon.in (our associate tag is India). Other
// Amazon domains still get tracked, just with the plain link.
function affiliateEligible(snapshot) {
  if (snapshot.marketplace === 'FLIPKART') return true;
  try {
    return new URL(snapshot.canonicalUrl || snapshot.productUrl).hostname.toLowerCase().endsWith('amazon.in');
  } catch {
    return false;
  }
}

// ── Entry: /pricetracker → main menu ─────────────────────────────────────────
async function startTrackerFlow(token, chatId, from, trailingText) {
  const url = firstUrl(trailingText);
  if (url) return resolveAndAskMode(token, chatId, from, url); // "/pricetracker <link>" shortcut
  await state.clearState(chatId);
  await sendMessage(token, chatId, '📊 *Price Tracker*\n\nWhat would you like to do?', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Track new product', callback_data: 'tracker:new' }],
        [{ text: '📋 Manage existing', callback_data: 'tracker:list' }],
      ],
    },
  });
}

async function beginNew(token, chatId, from) {
  await state.setState(chatId, state.WAITING_FOR_TRACKER_URL, { userId: from && from.id });
  await sendMessage(
    token,
    chatId,
    '📎 Send me the Amazon or Flipkart product link you want to track.\n\n' +
      'Tip: open the product, pick your exact variant (size/colour), then copy that link. Send /cancel to stop.'
  );
}

// Resolve a link → price + title (+ affiliate link), then ask for the alert mode.
async function resolveAndAskMode(token, chatId, from, url) {
  await sendMessage(token, chatId, '⏳ Fetching the current price…');
  let snapshot;
  try {
    snapshot = await getProductPrice(url);
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : 'Could not read that product page. Try another link.';
    await sendMessage(token, chatId, `⚠️ ${msg}`);
    return;
  }
  if (snapshot.price == null) {
    await sendMessage(token, chatId, "⚠️ I couldn't read a price from that page right now (blocked or out of stock). Please try again shortly.");
    return;
  }
  // Best-effort affiliate link (so alerts monetise) — only for marketplaces our
  // affiliate program covers (amazon.in + Flipkart). Other Amazon domains (.com,
  // .co.uk …) are still fully trackable, just with the plain product link.
  let affiliateUrl = snapshot.canonicalUrl || snapshot.productUrl;
  if (affiliateEligible(snapshot)) {
    try {
      const r = await affiliate.generateLink(url, { withMeta: false });
      if (r && r.affiliateUrl) affiliateUrl = r.affiliateUrl;
    } catch {
      /* keep the plain URL */
    }
  }
  await state.setState(chatId, state.WAITING_FOR_MODE, { userId: from && from.id, snapshot, affiliateUrl });
  const cur = snapshot.currency || '';
  await sendMessage(
    token,
    chatId,
    `🛒 ${shortTitle(snapshot.title, 80)}\n\nCurrent price: ${cur}${round2(snapshot.price)}\n${affiliateUrl}\n\nHow should I alert you?`,
    {
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔔 Alert on any price drop', callback_data: 'tracker:mode_dec' }],
          [{ text: '🎯 Alert at/below a price', callback_data: 'tracker:mode_thr' }],
        ],
      },
    }
  );
}

// ── Text router (called by telegram.processUpdate). Returns true if consumed. ──
async function maybeHandleState(token, chatId, from, text) {
  const st = await state.getState(chatId);
  if (!st) return false;

  if (st.state === state.WAITING_FOR_TRACKER_URL) {
    const url = firstUrl(text);
    if (!url) {
      await sendMessage(token, chatId, "That doesn't look like a link. Send a product URL, or /cancel.");
      return true;
    }
    await state.clearState(chatId);
    await resolveAndAskMode(token, chatId, from, url);
    return true;
  }

  if (st.state === state.WAITING_FOR_MODE) {
    await sendMessage(token, chatId, 'Please tap one of the buttons above to choose how to be alerted, or /cancel.');
    return true;
  }

  if (st.state === state.WAITING_FOR_THRESHOLD) {
    const val = parsePrice(text);
    if (val == null || val <= 0) {
      await sendMessage(token, chatId, 'Please send a valid number, e.g. 200 (or /cancel).');
      return true;
    }
    const d = st.data || {};
    await state.clearState(chatId);
    try {
      if (d.editId) {
        const upd = await tracker.setMode(d.editId, from && from.id, 'THRESHOLD', val);
        if (!upd) return (await sendMessage(token, chatId, '⚠️ That tracker no longer exists.'), true);
        await confirmSaved(token, chatId, upd);
      } else {
        const t = await tracker.addTracker({
          userId: from && from.id,
          chatId,
          snapshot: d.snapshot,
          affiliateUrl: d.affiliateUrl,
          mode: 'THRESHOLD',
          threshold: val,
        });
        await confirmSaved(token, chatId, t);
      }
    } catch (err) {
      await sendMessage(token, chatId, `⚠️ ${err.message}`);
    }
    return true;
  }

  return false;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function ruleLine(t) {
  const cur = t.currency || '';
  return t.mode === 'THRESHOLD'
    ? `Alert at/below ${cur}${round2(t.threshold)}`
    : `Alert on any new low (below ${cur}${round2(t.lastNotifiedPrice)})`;
}

function detailKeyboard(t) {
  const toggle =
    t.status === 'active'
      ? { text: '⏸ Stop', callback_data: `tracker:stop:${t.id}` }
      : { text: '▶️ Resume', callback_data: `tracker:resume:${t.id}` };
  return {
    inline_keyboard: [
      [toggle],
      [{ text: '✏️ Edit alert', callback_data: `tracker:edit:${t.id}` }],
      [{ text: '🗑 Delete', callback_data: `tracker:del:${t.id}` }],
      [{ text: '⬅️ My trackers', callback_data: 'tracker:list' }],
    ],
  };
}

function detailText(t) {
  const cur = t.currency || '';
  const now = t.lastPrice != null ? `${cur}${round2(t.lastPrice)}` : '—';
  return (
    `${shortTitle(t.title, 80)}\n\n` +
    `Status: ${t.status === 'active' ? '🟢 Active' : '⏸ Paused'}\n` +
    `Marketplace: ${t.marketplace}\n` +
    `Started at: ${cur}${round2(t.startPrice)}\n` +
    `Current: ${now}\n` +
    `${ruleLine(t)}\n\n` +
    `${t.affiliateUrl || t.canonicalUrl || t.productUrl}`
  );
}

async function confirmSaved(token, chatId, t) {
  const cur = t.currency || '';
  await sendMessage(token, chatId, `✅ Saved.\n\n${shortTitle(t.title, 80)}\n${ruleLine(t)}\n${t.affiliateUrl || t.productUrl}`, {
    reply_markup: detailKeyboard(t),
  });
}

async function editText(token, chatId, messageId, text, keyboard) {
  try {
    await tgCall(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
    return true;
  } catch {
    return false;
  }
}

async function showMyTrackers(token, chatId, from, editMessageId) {
  const list = await tracker.listTrackers(from && from.id);
  if (!list.length) {
    const text = 'You have no price trackers yet.\n\nTap below to start one.';
    const kb = { inline_keyboard: [[{ text: '➕ Track new product', callback_data: 'tracker:new' }]] };
    if (!editMessageId || !(await editText(token, chatId, editMessageId, text, kb))) await sendMessage(token, chatId, text, { reply_markup: kb });
    return;
  }
  const text = `📋 Your trackers (${list.length}):\n\nTap one to manage it.`;
  const kb = {
    inline_keyboard: list.map((t) => [
      { text: `${t.status === 'active' ? '🟢' : '⏸'} ${shortTitle(t.title, 30)}`, callback_data: `tracker:view:${t.id}` },
    ]),
  };
  if (!editMessageId || !(await editText(token, chatId, editMessageId, text, kb))) await sendMessage(token, chatId, text, { reply_markup: kb });
}

async function showDetail(token, chatId, messageId, t) {
  if (!messageId || !(await editText(token, chatId, messageId, detailText(t), detailKeyboard(t)))) {
    await sendMessage(token, chatId, detailText(t), { disable_web_page_preview: true, reply_markup: detailKeyboard(t) });
  }
}

// ── Callback (inline button) dispatch ────────────────────────────────────────
async function handleCallback(token, cq) {
  const data = String(cq.data || '');
  const from = cq.from || {};
  const msg = cq.message || {};
  const chatId = msg.chat && msg.chat.id;
  const messageId = msg.message_id;
  const answer = (text, alert) =>
    tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: text || '', show_alert: !!alert }).catch(() => {});

  if (!data.startsWith('tracker:') || chatId == null) return answer();
  const [, action, id] = data.split(':');

  // ── No-id actions ──
  if (action === 'new') {
    await answer();
    return beginNew(token, chatId, from);
  }
  if (action === 'list') {
    await answer();
    return showMyTrackers(token, chatId, from, messageId);
  }
  if (action === 'mode_dec' || action === 'mode_thr') {
    const st = await state.getState(chatId);
    if (!st || st.state !== state.WAITING_FOR_MODE || !st.data || !st.data.snapshot) {
      return answer('This request expired. Start again with /pricetracker.', true);
    }
    if (String(st.data.userId) !== String(from.id)) return answer('Not your request.', true);
    if (action === 'mode_thr') {
      await state.setState(chatId, state.WAITING_FOR_THRESHOLD, { userId: from.id, snapshot: st.data.snapshot, affiliateUrl: st.data.affiliateUrl });
      await answer();
      return sendMessage(token, chatId, "💰 Send the target price — just the number, e.g. 200. I'll alert you when it reaches that or lower.");
    }
    await state.clearState(chatId);
    await answer('Saved ✓');
    try {
      const t = await tracker.addTracker({ userId: from.id, chatId, snapshot: st.data.snapshot, affiliateUrl: st.data.affiliateUrl, mode: 'DECREASE' });
      return confirmSaved(token, chatId, t);
    } catch (err) {
      return sendMessage(token, chatId, `⚠️ ${err.message}`);
    }
  }

  // ── Id actions: verify ownership ──
  const t = await tracker.getTracker(id);
  if (!t) return answer('That tracker no longer exists.', true);
  if (String(t.userId) !== String(from.id)) return answer("That isn't your tracker.", true);

  if (action === 'view') {
    await answer();
    return showDetail(token, chatId, messageId, t);
  }
  if (action === 'stop' || action === 'resume') {
    const updated = action === 'stop' ? await tracker.stopTracker(id, from.id) : await tracker.resumeTracker(id, from.id);
    await answer(action === 'stop' ? 'Paused.' : 'Resumed.');
    return showDetail(token, chatId, messageId, updated || t);
  }
  if (action === 'edit') {
    await answer();
    return editText(token, chatId, messageId, `How should I alert you for:\n\n${shortTitle(t.title, 60)}?`, {
      inline_keyboard: [
        [{ text: '🔔 Any price drop', callback_data: `tracker:edit_dec:${id}` }],
        [{ text: '🎯 At/below a price', callback_data: `tracker:edit_thr:${id}` }],
        [{ text: '⬅️ Back', callback_data: `tracker:view:${id}` }],
      ],
    });
  }
  if (action === 'edit_dec') {
    const updated = await tracker.setMode(id, from.id, 'DECREASE');
    await answer('Now alerting on any price drop.');
    return showDetail(token, chatId, messageId, updated || t);
  }
  if (action === 'edit_thr') {
    await state.setState(chatId, state.WAITING_FOR_THRESHOLD, { userId: from.id, editId: id });
    await answer();
    return sendMessage(token, chatId, "💰 Send the target price — just the number, e.g. 200. I'll alert you when it reaches that or lower.");
  }
  if (action === 'del') {
    await answer();
    return editText(token, chatId, messageId, `Delete this tracker permanently?\n\n${shortTitle(t.title, 60)}`, {
      inline_keyboard: [
        [
          { text: '✅ Yes, delete', callback_data: `tracker:del_confirm:${id}` },
          { text: '↩️ Keep it', callback_data: `tracker:view:${id}` },
        ],
      ],
    });
  }
  if (action === 'del_confirm') {
    const ok = await tracker.deleteTracker(id, from.id);
    await answer(ok ? 'Deleted.' : 'Already gone.');
    return editText(token, chatId, messageId, `🗑 Deleted “${shortTitle(t.title, 60)}”.`, {
      inline_keyboard: [[{ text: '📋 My trackers', callback_data: 'tracker:list' }]],
    });
  }

  return answer();
}

// ── /cancel ───────────────────────────────────────────────────────────────────
async function handleCancel(token, chatId) {
  const st = await state.getState(chatId);
  await state.clearState(chatId);
  await sendMessage(token, chatId, st ? '👍 Cancelled.' : 'Nothing to cancel.');
}

module.exports = {
  startTrackerFlow,
  maybeHandleState,
  showMyTrackers,
  handleCallback,
  handleCancel,
};
