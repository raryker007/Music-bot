/**
 * ============================================================
 *  Premium Video Downloader — Telegram Bot  v2.0
 *  Upgrades:
 *    ✅ 8 Platforms (+ Twitter/X, Vimeo, Pinterest, Dailymotion)
 *    ✅ Quality picker (480p / 720p / 1080p / 4K / MP3)
 *    ✅ Download history per user (/history)
 *    ✅ Feedback & star rating system (/feedback)
 *    ✅ Full Admin Panel (/admin, /ban, /unban)
 *    ✅ Playlist detection (YouTube)
 *    ✅ New user notify to admin
 *    ✅ Cancel any request (/cancel)
 *    ✅ Settings page (/settings)
 * ============================================================
 */

'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ─── Config ──────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = parseInt(process.env.ADMIN_ID, 10);
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-mini-app.vercel.app';

const RATE_LIMIT_MS  = 5_000;
const PROGRESS_STEPS = [10, 25, 45, 65, 80, 95, 100];
const STEP_DELAY_MS  = 800;
const QUEUE_DELAY_MS = 1_200;
const MAX_HISTORY    = 20;

// ─── Platform definitions ─────────────────────────────────────
const SUPPORTED_PLATFORMS = {
  youtube     : /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)[\w-]+/i,
  tiktok      : /(?:https?:\/\/)?(?:www\.)?(?:vm\.tiktok\.com|tiktok\.com)\/.+/i,
  facebook    : /(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.watch)\/.+/i,
  instagram   : /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/.+/i,
  twitter     : /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i,
  vimeo       : /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/\d+/i,
  pinterest   : /(?:https?:\/\/)?(?:www\.)?pinterest\.com\/pin\/.+/i,
  dailymotion : /(?:https?:\/\/)?(?:www\.)?dailymotion\.com\/video\/.+/i,
};

const PLATFORM_ICONS = {
  youtube: '🔴', tiktok: '🎵', facebook: '📘', instagram: '📸',
  twitter: '🐦', vimeo: '🎬', pinterest: '📌', dailymotion: '📹',
};

const GENERIC_URL_RE = /https?:\/\/[^\s]+/i;

// ─── In-memory store (swap for Redis/DB in production) ────────
const store = {
  users     : new Map(), // userId → { firstName, username, joinedAt, requests, history[], banned, plan }
  lastReq   : new Map(), // userId → timestamp
  totalReq  : 0,
  feedback  : [],        // { userId, type, text|stars, date }
  pendingDl : new Map(), // userId → { url, platform } awaiting quality pick
};

// ─── Bot init ────────────────────────────────────────────────
if (!BOT_TOKEN) { console.error('[FATAL] BOT_TOKEN is not set.'); process.exit(1); }
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Utility helpers ─────────────────────────────────────────
const delay      = (ms) => new Promise((r) => setTimeout(r, ms));
const capitalize = (s)  => s.charAt(0).toUpperCase() + s.slice(1);

function log(userId, action, extra = '') {
  console.log(`[${new Date().toISOString()}] USER:${userId} | ${action}${extra ? ' | ' + extra : ''}`);
}

function formatUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}

function isPlaylist(url) { return /playlist\?list=/i.test(url); }

// ─── Store helpers ────────────────────────────────────────────
function registerUser(msg) {
  const { id, first_name, username } = msg.from;
  if (!store.users.has(id)) {
    store.users.set(id, {
      firstName : first_name,
      username  : username || '',
      joinedAt  : new Date(),
      requests  : 0,
      history   : [],
      banned    : false,
      plan      : 'free',
    });
    log(id, 'NEW_USER', first_name);
    // Notify admin
    if (ADMIN_ID) {
      bot.sendMessage(ADMIN_ID,
        `👤 *New user joined!*\n\n🔖 Name: ${first_name}\n🆔 ID: \`${id}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
}

function getUser(userId) { return store.users.get(userId); }

function isRateLimited(userId) {
  const last = store.lastReq.get(userId) || 0;
  const now  = Date.now();
  if (now - last < RATE_LIMIT_MS) return true;
  store.lastReq.set(userId, now);
  return false;
}

function isBanned(userId) { return store.users.get(userId)?.banned === true; }

function addToHistory(userId, entry) {
  const user = store.users.get(userId);
  if (!user) return;
  user.history.unshift({ ...entry, date: new Date().toISOString() });
  if (user.history.length > MAX_HISTORY) user.history.pop();
  user.requests += 1;
  store.totalReq += 1;
}

// ─── Platform helpers ─────────────────────────────────────────
function detectPlatform(url) {
  for (const [p, re] of Object.entries(SUPPORTED_PLATFORMS)) {
    if (re.test(url)) return p;
  }
  return null;
}

function extractUrl(text) {
  const m = text.match(GENERIC_URL_RE);
  return m ? m[0] : null;
}

// ─── Keyboards ───────────────────────────────────────────────
function miniAppKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🚀 Open Mini App', web_app: { url: MINI_APP_URL } },
    ]],
  };
}

function qualityKeyboard(url, platform) {
  const urlKey = url.slice(0, 48);
  const needs4K = ['youtube', 'vimeo'].includes(platform);
  return {
    inline_keyboard: [
      [
        { text: '🎬 1080p HD',  callback_data: `q:1080:${urlKey}` },
        { text: '📺 720p',      callback_data: `q:720:${urlKey}`  },
      ],
      [
        { text: '📱 480p',      callback_data: `q:480:${urlKey}`  },
        { text: '🎵 MP3 Audio', callback_data: `q:mp3:${urlKey}`  },
      ],
      ...(needs4K ? [[
        { text: '👑 4K Ultra HD (Premium)', callback_data: `q:4k:${urlKey}` },
      ]] : []),
      [
        { text: '❌ Cancel', callback_data: 'cancel' },
      ],
    ],
  };
}

function downloadKeyboard(url) {
  return {
    inline_keyboard: [
      [
        { text: '🎬 Download MP4', callback_data: `dl_mp4:${url.slice(0, 60)}` },
        { text: '🎵 Download MP3', callback_data: `dl_mp3:${url.slice(0, 60)}` },
      ],
      [
        { text: '📂 My History',      callback_data: 'history'      },
        { text: '🔁 New Download',    callback_data: 'new_download'  },
      ],
      [
        { text: '⭐ Rate Bot',  callback_data: 'rate'    },
        { text: '👑 Premium',   callback_data: 'premium' },
      ],
    ],
  };
}

function premiumKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🥈 Pro — $4.99/mo',   callback_data: 'buy_pro'   },
        { text: '🥇 Elite — $9.99/mo', callback_data: 'buy_elite' },
      ],
      [{ text: '🔙 Back', callback_data: 'back_start' }],
    ],
  };
}

function ratingKeyboard() {
  return {
    inline_keyboard: [[
      { text: '1⭐', callback_data: 'rate:1' },
      { text: '2⭐', callback_data: 'rate:2' },
      { text: '3⭐', callback_data: 'rate:3' },
      { text: '4⭐', callback_data: 'rate:4' },
      { text: '5⭐', callback_data: 'rate:5' },
    ]],
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '👥 Users',      callback_data: 'admin_users'     },
        { text: '📊 Full Stats', callback_data: 'admin_stats'     },
      ],
      [
        { text: '💬 Feedbacks',      callback_data: 'admin_feedbacks'       },
        { text: '📢 Broadcast Help', callback_data: 'admin_broadcast_hint'  },
      ],
    ],
  };
}

// ─── Message templates ────────────────────────────────────────
const MSG = {
  welcome: (name) => `
✨ *Welcome, ${name}!*

🎬 *Premium Video Downloader v2.0*

📥 *8 Supported Platforms:*
🔴 YouTube  •  🎵 TikTok  •  📘 Facebook
📸 Instagram  •  🐦 Twitter/X  •  🎬 Vimeo
📌 Pinterest  •  📹 Dailymotion

━━━━━━━━━━━━━━━━━━━━
💡 *Just paste any video link!*
📊 Choose quality: *480p · 720p · 1080p · 4K · MP3*
📂 View history: /history
  `.trim(),

  help: `
📖 *How to use this bot:*

1️⃣ Copy a video URL from any supported platform
2️⃣ Paste it here in the chat
3️⃣ Choose your *quality & format*
4️⃣ Download instantly ⚡

━━━━━━━━━━━━━━━━━━━━
🔧 *Commands:*
• /start    — Open the bot
• /help     — Show this guide
• /history  — Your download history
• /stats    — Bot statistics
• /premium  — Upgrade your plan
• /feedback — Send us feedback
• /settings — Your account info
• /cancel   — Cancel current request

🌐 *Platforms:*
YouTube · TikTok · Instagram · Facebook
Twitter/X · Vimeo · Pinterest · Dailymotion

💬 *Support:* @YourSupportHandle
  `.trim(),

  askQuality: (platform, url) => `
${PLATFORM_ICONS[platform] || '🎬'} *${capitalize(platform)} detected!*

🔗 \`${url.slice(0, 50)}${url.length > 50 ? '…' : ''}\`

━━━━━━━━━━━━━━━━━━━━
📊 *Choose your quality:*
  `.trim(),

  queued      : `🕐 *Request queued...*\n\nStarting shortly...`,
  processing  : (p, q) => `⚙️ *Processing ${PLATFORM_ICONS[p] || '🎬'} ${capitalize(p)} video...*\n\n📊 Quality: \`${q}\`\n⏳ Progress: \`[░░░░░░░░░░]\` 0%`,
  progress    : (pct, p, q) => {
    const filled = Math.round(pct / 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `⚙️ *Processing ${PLATFORM_ICONS[p] || '🎬'} ${capitalize(p)} video...*\n\n📊 Quality: \`${q}\`\n⏳ Progress: \`[${bar}]\` ${pct}%`;
  },
  completed: (p, q) => `
✅ *Download Ready!*

${PLATFORM_ICONS[p] || '🎬'} *Platform:* ${capitalize(p)}
🏆 *Quality:* ${q}
⚡ *Status:* Ready

_Choose your format below:_
  `.trim(),

  history: (entries) => {
    if (!entries || entries.length === 0) {
      return `📭 *No download history yet.*\n\nSend a video URL to get started!`;
    }
    const lines = entries.slice(0, 10).map((e, i) =>
      `${i + 1}. ${PLATFORM_ICONS[e.platform] || '🎬'} *${capitalize(e.platform)}* — ${e.quality} — ${new Date(e.date).toLocaleDateString()}`
    ).join('\n');
    return `📂 *Your Recent Downloads* (${Math.min(entries.length, 10)} of ${entries.length}):\n\n${lines}`;
  },

  settings: (user) => `
⚙️ *Your Account*

👤 *Name:* ${user.firstName}
📦 *Plan:* ${user.plan === 'elite' ? '🥇 Elite' : user.plan === 'pro' ? '🥈 Pro' : '🆓 Free'}
📥 *Total Downloads:* ${user.requests}
📅 *Member since:* ${new Date(user.joinedAt).toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━
🔢 *Quality:* Ask each time
🔔 *Notifications:* Enabled
  `.trim(),

  feedback    : `💬 *Send us your feedback!*\n\nType your message below.\nPress /cancel to abort.`,
  feedbackOK  : `✅ *Thank you for your feedback!*\n\nWe'll review it shortly.`,
  cancelled   : `❌ *Cancelled.*\n\nSend a new URL whenever you're ready.`,
  banned      : `🚫 *You are banned.*\n\nContact support if this is a mistake.`,

  invalidUrl: `
❌ *Unsupported URL*

Supported platforms:
🔴 YouTube  •  🎵 TikTok  •  📘 Facebook
📸 Instagram  •  🐦 Twitter/X  •  🎬 Vimeo
📌 Pinterest  •  📹 Dailymotion

💡 *Example:*
\`https://www.youtube.com/watch?v=dQw4w9WgXcQ\`
  `.trim(),

  rateLimited : `⏳ *Slow down!* One request every *5 seconds* please.`,
  error       : `⚠️ *Something went wrong.*\n\nPlease try again. Use /help if the issue persists.`,

  premium: `
👑 *Premium Plans*

┌─────────────────────────────────┐
│  🆓 *Free*                        │
│  ✅ 10 downloads / day            │
│  ✅ 720p max quality              │
│  ✅ 8 platforms                   │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  🥈 *Pro* — $4.99/mo              │
│  ✅ 100 downloads / day           │
│  ✅ 1080p quality                 │
│  ✅ MP3 extraction                │
│  ✅ Priority queue                │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  🥇 *Elite* — $9.99/mo            │
│  ✅ Unlimited downloads           │
│  ✅ 4K when available             │
│  ✅ Playlist / Batch downloads    │
│  ✅ Dedicated server              │
│  ✅ API access                    │
└─────────────────────────────────┘

🔗 *Tap below to upgrade →*
  `.trim(),

  playlist: (url) => `
📋 *YouTube Playlist Detected!*

🔗 \`${url.slice(0, 50)}...\`

👑 *Playlist downloads require Elite plan.*

Upgrade below or send a *single video URL* instead.
  `.trim(),
};

// ─── Feedback state (users awaiting feedback input) ───────────
const feedbackPending = new Set();

// ─── Handlers ────────────────────────────────────────────────

async function handleStart(msg) {
  const { id, first_name } = msg.from;
  registerUser(msg);
  log(id, '/start');
  await bot.sendChatAction(id, 'typing');
  await bot.sendMessage(id, MSG.welcome(first_name), {
    parse_mode  : 'Markdown',
    reply_markup: miniAppKeyboard(),
  });
}

async function handleHelp(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/help');
  await bot.sendChatAction(id, 'typing');
  await bot.sendMessage(id, MSG.help, { parse_mode: 'Markdown' });
}

async function handleHistory(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/history');
  const user = getUser(id);
  await bot.sendMessage(id, MSG.history(user?.history || []), { parse_mode: 'Markdown' });
}

async function handleSettings(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/settings');
  const user = getUser(id);
  if (!user) return;
  await bot.sendMessage(id, MSG.settings(user), { parse_mode: 'Markdown' });
}

async function handleStats(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/stats');
  const premiumUsers = [...store.users.values()].filter(u => u.plan !== 'free').length;
  const text = `
📊 *Bot Statistics*

👥 *Total users:*    ${store.users.size}
👑 *Premium users:*  ${premiumUsers}
📥 *Total requests:* ${store.totalReq}
💬 *Feedbacks:*      ${store.feedback.length}
🕐 *Uptime:*         ${formatUptime(process.uptime())}
  `.trim();
  await bot.sendMessage(id, text, { parse_mode: 'Markdown' });
}

async function handlePremium(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/premium');
  await bot.sendChatAction(id, 'typing');
  await bot.sendMessage(id, MSG.premium, {
    parse_mode  : 'Markdown',
    reply_markup: premiumKeyboard(),
  });
}

async function handleFeedback(msg) {
  const { id } = msg.from;
  registerUser(msg);
  log(id, '/feedback');
  feedbackPending.add(id);
  await bot.sendMessage(id, MSG.feedback, { parse_mode: 'Markdown' });
}

async function handleCancel(msg) {
  const { id } = msg.from;
  store.pendingDl.delete(id);
  feedbackPending.delete(id);
  log(id, '/cancel');
  await bot.sendMessage(id, MSG.cancelled, { parse_mode: 'Markdown' });
}

async function handleAdmin(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });
  const text = `
🛡️ *Admin Panel*

👥 Users: ${store.users.size}
📥 Requests: ${store.totalReq}
💬 Feedbacks: ${store.feedback.length}
⏰ Uptime: ${formatUptime(process.uptime())}
  `.trim();
  await bot.sendMessage(id, text, {
    parse_mode  : 'Markdown',
    reply_markup: adminKeyboard(),
  });
}

/** Core video processing pipeline */
async function handleVideoUrl(msg, url, platform, quality = '720p') {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log(userId, 'VIDEO_REQUEST', `${platform} | ${quality} | ${url}`);
  addToHistory(userId, { url, platform, quality });

  let statusMsg;
  try {
    await bot.sendChatAction(chatId, 'typing');
    statusMsg = await bot.sendMessage(chatId, MSG.queued, { parse_mode: 'Markdown' });
    await delay(QUEUE_DELAY_MS);

    await bot.editMessageText(MSG.processing(platform, quality), {
      chat_id   : chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
    });

    for (const pct of PROGRESS_STEPS) {
      await delay(STEP_DELAY_MS);
      await bot.editMessageText(MSG.progress(pct, platform, quality), {
        chat_id   : chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown',
      });
    }

    await delay(400);
    await bot.editMessageText(MSG.completed(platform, quality), {
      chat_id     : chatId,
      message_id  : statusMsg.message_id,
      parse_mode  : 'Markdown',
      reply_markup: downloadKeyboard(url),
    });

  } catch (err) {
    console.error(`[ERROR] handleVideoUrl | user:${userId} |`, err.message);
    const target = statusMsg ? { chat_id: chatId, message_id: statusMsg.message_id } : null;
    if (target) {
      await bot.editMessageText(MSG.error, { ...target, parse_mode: 'Markdown' }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, MSG.error, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

/** Incoming text message handler */
async function handleMessage(msg) {
  if (!msg.text || msg.text.startsWith('/')) return;

  const { id } = msg.from;
  registerUser(msg);

  if (isBanned(id)) return bot.sendMessage(id, MSG.banned, { parse_mode: 'Markdown' });

  // ── Feedback flow ──────────────────────────────────
  if (feedbackPending.has(id)) {
    feedbackPending.delete(id);
    store.feedback.push({ userId: id, type: 'text', text: msg.text, date: new Date().toISOString() });
    log(id, 'FEEDBACK', msg.text.slice(0, 60));
    if (ADMIN_ID) {
      bot.sendMessage(ADMIN_ID,
        `💬 *Feedback from* \`${id}\`:\n\n${msg.text}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    return bot.sendMessage(id, MSG.feedbackOK, { parse_mode: 'Markdown' });
  }

  // ── Rate limit ─────────────────────────────────────
  if (isRateLimited(id)) {
    log(id, 'RATE_LIMITED');
    return bot.sendMessage(id, MSG.rateLimited, { parse_mode: 'Markdown' });
  }

  // ── URL detection ──────────────────────────────────
  const url = extractUrl(msg.text);
  if (!url) return bot.sendMessage(id, MSG.invalidUrl, { parse_mode: 'Markdown' });

  const platform = detectPlatform(url);
  if (!platform) {
    log(id, 'UNSUPPORTED_URL', url);
    return bot.sendMessage(id, MSG.invalidUrl, { parse_mode: 'Markdown' });
  }

  // ── Playlist check ─────────────────────────────────
  if (platform === 'youtube' && isPlaylist(url)) {
    const user = getUser(id);
    if (user?.plan !== 'elite') {
      return bot.sendMessage(id, MSG.playlist(url), {
        parse_mode  : 'Markdown',
        reply_markup: premiumKeyboard(),
      });
    }
  }

  // ── Ask quality ────────────────────────────────────
  store.pendingDl.set(id, { url, platform });
  log(id, 'ASK_QUALITY', `${platform} | ${url}`);
  return bot.sendMessage(id, MSG.askQuality(platform, url), {
    parse_mode  : 'Markdown',
    reply_markup: qualityKeyboard(url, platform),
  });
}

/** Callback query handler */
async function handleCallback(query) {
  const { id: queryId, data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;

  await bot.answerCallbackQuery(queryId);
  log(userId, 'CALLBACK', data);

  // ── Quality selection ──────────────────────────────
  if (data.startsWith('q:')) {
    const [, quality, ...urlParts] = data.split(':');
    const urlFrag  = urlParts.join(':');
    const pending  = store.pendingDl.get(userId);
    const url      = pending?.url || urlFrag;
    const platform = pending?.platform || 'unknown';
    store.pendingDl.delete(userId);

    const qualityLabels = { '1080':'1080p HD', '720':'720p HD', '480':'480p', 'mp3':'MP3 Audio', '4k':'4K Ultra HD' };
    const qualityLabel  = qualityLabels[quality] || quality;

    // 4K gate
    const user = getUser(userId);
    if (quality === '4k' && user?.plan === 'free') {
      return bot.sendMessage(chatId,
        `👑 *4K requires Elite plan.*\n\nUpgrade to unlock 4K downloads!`,
        { parse_mode: 'Markdown', reply_markup: premiumKeyboard() }
      );
    }

    try {
      await bot.editMessageText(
        `⏳ *Starting...*\n\n${PLATFORM_ICONS[platform] || '🎬'} ${capitalize(platform)} | ${qualityLabel}`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown' }
      );
    } catch {}

    return handleVideoUrl(
      { chat: { id: chatId }, from: { id: userId } },
      url, platform, qualityLabel
    );
  }

  // ── Download format buttons ────────────────────────
  if (data.startsWith('dl_mp4:') || data.startsWith('dl_mp3:')) {
    const format = data.startsWith('dl_mp4') ? 'MP4 🎬' : 'MP3 🎵';
    return bot.sendMessage(chatId,
      `⏳ *Preparing ${format} download...*\n\n_Integrate your download service here (yt-dlp, RapidAPI, etc.)_`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── History ────────────────────────────────────────
  if (data === 'history') {
    const user = getUser(userId);
    return bot.sendMessage(chatId, MSG.history(user?.history || []), { parse_mode: 'Markdown' });
  }

  // ── New download ───────────────────────────────────
  if (data === 'new_download') {
    return bot.sendMessage(chatId, '📎 *Send me a new video URL!*', { parse_mode: 'Markdown' });
  }

  // ── Cancel ─────────────────────────────────────────
  if (data === 'cancel') {
    store.pendingDl.delete(userId);
    return bot.editMessageText(MSG.cancelled, {
      chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown',
    }).catch(() => bot.sendMessage(chatId, MSG.cancelled, { parse_mode: 'Markdown' }));
  }

  // ── Rate the bot ───────────────────────────────────
  if (data === 'rate') {
    return bot.sendMessage(chatId, '⭐ *How would you rate this bot?*', {
      parse_mode: 'Markdown', reply_markup: ratingKeyboard(),
    });
  }

  if (data.startsWith('rate:')) {
    const stars   = parseInt(data.split(':')[1]);
    const emojis  = ['😕', '😐', '🙂', '😊', '🤩'];
    store.feedback.push({ userId, type: 'rating', stars, date: new Date().toISOString() });
    log(userId, 'RATING', `${stars}/5`);
    if (ADMIN_ID) {
      bot.sendMessage(ADMIN_ID, `⭐ Rating ${stars}/5 from \`${userId}\``, { parse_mode: 'Markdown' }).catch(() => {});
    }
    return bot.editMessageText(
      `${emojis[stars - 1]} *Thanks for rating ${stars}/5!*\n\nYour feedback helps us improve.`,
      { chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  // ── Premium ────────────────────────────────────────
  if (['premium', 'upgrade_now', 'buy_pro', 'buy_elite'].includes(data)) {
    await bot.sendChatAction(chatId, 'typing');
    return bot.sendMessage(chatId, MSG.premium, {
      parse_mode: 'Markdown', reply_markup: premiumKeyboard(),
    });
  }

  // ── Back to start ──────────────────────────────────
  if (data === 'back_start') {
    return bot.sendMessage(chatId, MSG.welcome(from.first_name), {
      parse_mode: 'Markdown', reply_markup: miniAppKeyboard(),
    });
  }

  // ── Admin: Users ───────────────────────────────────
  if (data === 'admin_users' && userId === ADMIN_ID) {
    const list = [...store.users.entries()].slice(0, 15).map(([uid, u]) =>
      `• ${u.firstName} (\`${uid}\`) — ${u.requests} dls — ${u.plan}${u.banned ? ' 🚫' : ''}`
    ).join('\n');
    return bot.sendMessage(chatId, `👥 *Users (top 15):*\n\n${list || 'None'}`, { parse_mode: 'Markdown' });
  }

  // ── Admin: Feedbacks ───────────────────────────────
  if (data === 'admin_feedbacks' && userId === ADMIN_ID) {
    const fbs = store.feedback.slice(-8).map((f, i) =>
      f.type === 'rating'
        ? `${i + 1}. ⭐${f.stars} from \`${f.userId}\``
        : `${i + 1}. 💬 \`${f.userId}\`: ${(f.text || '').slice(0, 60)}`
    ).join('\n');
    return bot.sendMessage(chatId, `💬 *Recent Feedbacks:*\n\n${fbs || 'None'}`, { parse_mode: 'Markdown' });
  }

  // ── Admin: Stats ───────────────────────────────────
  if (data === 'admin_stats' && userId === ADMIN_ID) {
    const premiumN = [...store.users.values()].filter(u => u.plan !== 'free').length;
    return bot.sendMessage(chatId, `
📊 *Full Stats*

👥 Users: ${store.users.size}
👑 Premium: ${premiumN}
📥 Requests: ${store.totalReq}
💬 Feedbacks: ${store.feedback.length}
⏰ Uptime: ${formatUptime(process.uptime())}
    `.trim(), { parse_mode: 'Markdown' });
  }

  if (data === 'admin_broadcast_hint' && userId === ADMIN_ID) {
    return bot.sendMessage(chatId, '📢 Use: `/broadcast Your message here`', { parse_mode: 'Markdown' });
  }
}

// ─── Admin commands ───────────────────────────────────────────

/** /broadcast <text>  — Admin only */
async function handleBroadcast(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });

  const text = msg.text.replace('/broadcast', '').trim();
  if (!text) return bot.sendMessage(id, '⚠️ Usage: `/broadcast <message>`', { parse_mode: 'Markdown' });

  log(id, 'BROADCAST', text);
  let sent = 0, failed = 0;
  for (const [uid, user] of store.users) {
    if (user.banned) continue;
    try {
      await bot.sendMessage(uid, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
      sent++;
    } catch { failed++; }
    await delay(50);
  }
  return bot.sendMessage(id, `✅ Broadcast complete.\n📤 Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'Markdown' });
}

/** /ban <userId>  — Admin only */
async function handleBan(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });
  const targetId = parseInt(msg.text.replace('/ban', '').trim());
  if (!targetId) return bot.sendMessage(id, '⚠️ Usage: `/ban <userId>`', { parse_mode: 'Markdown' });
  const user = store.users.get(targetId);
  if (!user) return bot.sendMessage(id, '❌ User not found.', { parse_mode: 'Markdown' });
  user.banned = true;
  log(id, 'BAN', `${targetId}`);
  return bot.sendMessage(id, `✅ User \`${targetId}\` (*${user.firstName}*) has been *banned*.`, { parse_mode: 'Markdown' });
}

/** /unban <userId>  — Admin only */
async function handleUnban(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });
  const targetId = parseInt(msg.text.replace('/unban', '').trim());
  if (!targetId) return bot.sendMessage(id, '⚠️ Usage: `/unban <userId>`', { parse_mode: 'Markdown' });
  const user = store.users.get(targetId);
  if (!user) return bot.sendMessage(id, '❌ User not found.', { parse_mode: 'Markdown' });
  user.banned = false;
  log(id, 'UNBAN', `${targetId}`);
  return bot.sendMessage(id, `✅ User \`${targetId}\` (*${user.firstName}*) has been *unbanned*.`, { parse_mode: 'Markdown' });
}

// ─── Event wiring ─────────────────────────────────────────────
bot.onText(/\/start/,     handleStart);
bot.onText(/\/help/,      handleHelp);
bot.onText(/\/history/,   handleHistory);
bot.onText(/\/settings/,  handleSettings);
bot.onText(/\/stats/,     handleStats);
bot.onText(/\/premium/,   handlePremium);
bot.onText(/\/feedback/,  handleFeedback);
bot.onText(/\/cancel/,    handleCancel);
bot.onText(/\/admin/,     handleAdmin);
bot.onText(/\/broadcast/, handleBroadcast);
bot.onText(/\/ban/,       handleBan);
bot.onText(/\/unban/,     handleUnban);
bot.on('message',         handleMessage);
bot.on('callback_query',  handleCallback);

// ─── Global error handlers ────────────────────────────────────
bot.on('polling_error', (err) => console.error('[POLLING ERROR]', err.code, err.message));
bot.on('error',         (err) => console.error('[BOT ERROR]', err.message));
process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));
process.on('uncaughtException',  (e) => console.error('[UNCAUGHT]', e.message));

// ─── Startup ─────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀  Premium Video Downloader Bot v2.0 — ONLINE');
console.log(`👑  Admin ID    : ${ADMIN_ID || 'NOT SET'}`);
console.log(`🌐  Mini App    : ${MINI_APP_URL}`);
console.log('🎯  Platforms   : YouTube · TikTok · Instagram · Facebook');
console.log('                  Twitter/X · Vimeo · Pinterest · Dailymotion');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
