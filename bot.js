/**
 * ============================================================
 *  Premium Video Downloader — Telegram Bot  v3.0
 *  Upgrades over v2:
 *    ✅ REAL downloads via yt-dlp (files sent to Telegram!)
 *    ✅ Real-time yt-dlp progress updates
 *    ✅ Auto-send video/audio file to user
 *    ✅ Large files (>50MB) → download link via web server
 *    ✅ Error messages: private/age-restricted/geo-blocked
 *    ✅ All previous features (admin, history, premium, etc.)
 * ============================================================
 */

'use strict';

require('dotenv').config();
const TelegramBot   = require('node-telegram-bot-api');
const { spawn }     = require('child_process');
const fs            = require('fs');
const path          = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Config ──────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = parseInt(process.env.ADMIN_ID, 10);
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-mini-app.vercel.app';
const BASE_URL     = process.env.BASE_URL     || 'http://localhost:3000';
const TMP_DIR      = process.env.TMP_DIR      || '/tmp/video-dl';

const RATE_LIMIT_MS  = 5_000;
const PROGRESS_STEPS = [10, 20, 35, 50, 65, 80, 92];
const STEP_DELAY_MS  = 1_500;
const MAX_HISTORY    = 20;
const MAX_TG_SIZE    = 50 * 1024 * 1024; // 50 MB Telegram limit

// Ensure tmp dir
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

// ─── Quality → yt-dlp format string ───────────────────────────
const FMT_MAP = {
  '1080' : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720'  : 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480'  : 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
  '4k'   : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
};

const QUALITY_NUM_MAP = {
  '1080p hd'   : '1080',
  '720p hd'    : '720',
  '480p'       : '480',
  '4k ultra hd': '4k',
  'mp3 audio'  : 'mp3',
};

// ─── In-memory store ─────────────────────────────────────────
const store = {
  users     : new Map(),
  lastReq   : new Map(),
  totalReq  : 0,
  feedback  : [],
  pendingDl : new Map(),
};

// ─── Bot init ────────────────────────────────────────────────
if (!BOT_TOKEN) { console.error('[FATAL] BOT_TOKEN is not set.'); process.exit(1); }
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Utility helpers ─────────────────────────────────────────
const delay      = (ms)  => new Promise(r => setTimeout(r, ms));
const capitalize = (s)   => s.charAt(0).toUpperCase() + s.slice(1);
const formatSize = (b)   => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

function log(userId, action, extra = '') {
  console.log(`[${new Date().toISOString()}] USER:${userId} | ${action}${extra ? ' | ' + extra : ''}`);
}

function formatUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}

function isPlaylist(url) { return /playlist\?list=/i.test(url); }

// ─── Find downloaded file by jobId prefix ────────────────────
function findJobFile(jobId) {
  try {
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId));
    return files.length > 0 ? path.join(TMP_DIR, files[0]) : null;
  } catch { return null; }
}

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
    if (ADMIN_ID) {
      bot.sendMessage(ADMIN_ID,
        `👤 *New user joined!*\n\n🔖 Name: ${first_name}\n🆔 ID: \`${id}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
}

function getUser(userId)      { return store.users.get(userId); }
function isBanned(userId)     { return store.users.get(userId)?.banned === true; }

function isRateLimited(userId) {
  const last = store.lastReq.get(userId) || 0;
  const now  = Date.now();
  if (now - last < RATE_LIMIT_MS) return true;
  store.lastReq.set(userId, now);
  return false;
}

function addToHistory(userId, entry) {
  const user = store.users.get(userId);
  if (!user) return;
  user.history.unshift({ ...entry, date: new Date().toISOString() });
  if (user.history.length > MAX_HISTORY) user.history.pop();
  user.requests  += 1;
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
  const urlKey  = url.slice(0, 48);
  const needs4K = ['youtube', 'vimeo'].includes(platform);
  return {
    inline_keyboard: [
      [
        { text: '🎬 1080p HD',  callback_data: `q:1080:${urlKey}` },
        { text: '📺 720p HD',   callback_data: `q:720:${urlKey}`  },
      ],
      [
        { text: '📱 480p',      callback_data: `q:480:${urlKey}`  },
        { text: '🎵 MP3 Audio', callback_data: `q:mp3:${urlKey}`  },
      ],
      ...(needs4K ? [[
        { text: '👑 4K Ultra HD (Premium)', callback_data: `q:4k:${urlKey}` },
      ]] : []),
      [{ text: '❌ Cancel', callback_data: 'cancel' }],
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
        { text: '💬 Feedbacks',      callback_data: 'admin_feedbacks'      },
        { text: '📢 Broadcast Help', callback_data: 'admin_broadcast_hint' },
      ],
    ],
  };
}

// ─── Progress bar helper ──────────────────────────────────────
function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ─── Message templates ────────────────────────────────────────
const MSG = {
  welcome: (name) => `
✨ *Welcome, ${name}!*

🎬 *Premium Video Downloader v3.0*

📥 *8 Supported Platforms:*
🔴 YouTube  •  🎵 TikTok  •  📘 Facebook
📸 Instagram  •  🐦 Twitter/X  •  🎬 Vimeo
📌 Pinterest  •  📹 Dailymotion

━━━━━━━━━━━━━━━━━━━━
💡 *Just paste any video link to start!*
📊 Choose quality: *480p · 720p · 1080p · 4K · MP3*
📂 View history: /history
  `.trim(),

  help: `
📖 *How to use:*

1️⃣ Copy a video URL from any platform
2️⃣ Paste it here in the chat
3️⃣ Choose your *quality & format*
4️⃣ Wait while I download & send it to you ⚡

━━━━━━━━━━━━━━━━━━━━
🔧 *Commands:*
• /start    — Welcome screen
• /help     — This guide
• /history  — Download history
• /stats    — Bot statistics
• /premium  — Upgrade plan
• /feedback — Send feedback
• /settings — Account info
• /cancel   — Cancel current request

💬 Support: @YourSupportHandle
  `.trim(),

  askQuality: (platform, url) => `
${PLATFORM_ICONS[platform] || '🎬'} *${capitalize(platform)} detected!*

🔗 \`${url.slice(0, 50)}${url.length > 50 ? '…' : ''}\`

━━━━━━━━━━━━━━━━━━━━
📊 *Choose download quality:*
  `.trim(),

  queued     : `🕐 *Request queued...*\n\nStarting download shortly...`,

  downloading: (p, q, pct) => `
⬇️ *Downloading ${PLATFORM_ICONS[p] || '🎬'} ${capitalize(p)} video...*

📊 Quality: \`${q}\`
⏳ Progress: \`[${progressBar(pct)}]\` ${pct}%
  `.trim(),

  processing : (p, q) => `
⚙️ *Processing ${PLATFORM_ICONS[p] || '🎬'} ${capitalize(p)}...*

📊 Quality: \`${q}\`
⏳ \`[░░░░░░░░░░]\` Starting...
  `.trim(),

  sending    : (p, q) => `
📤 *Sending to Telegram...*

${PLATFORM_ICONS[p] || '🎬'} ${capitalize(p)} | ${q}
⏳ \`[██████████]\` 100% — Uploading...
  `.trim(),

  completed  : (p, q, size) => `
✅ *Download Complete!*

${PLATFORM_ICONS[p] || '🎬'} *Platform:* ${capitalize(p)}
🏆 *Quality:* ${q}
📦 *Size:* ${size}
  `.trim(),

  largeFile  : (p, q, size, link) => `
✅ *Download Ready!*

${PLATFORM_ICONS[p] || '🎬'} *Platform:* ${capitalize(p)}
🏆 *Quality:* ${q}
📦 *Size:* ${size} *(too large for Telegram)*

🔗 *Tap below to download ↓*
_(Link expires in 1 hour)_
  `.trim(),

  history: (entries) => {
    if (!entries || entries.length === 0)
      return `📭 *No download history yet.*\n\nSend a video URL to get started!`;
    const lines = entries.slice(0, 10).map((e, i) =>
      `${i + 1}. ${PLATFORM_ICONS[e.platform] || '🎬'} *${capitalize(e.platform)}* — ${e.quality} — ${new Date(e.date).toLocaleDateString()}`
    ).join('\n');
    return `📂 *Your Downloads* (${Math.min(entries.length, 10)} of ${entries.length}):\n\n${lines}`;
  },

  settings: (user) => `
⚙️ *Your Account*

👤 *Name:* ${user.firstName}
📦 *Plan:* ${user.plan === 'elite' ? '🥇 Elite' : user.plan === 'pro' ? '🥈 Pro' : '🆓 Free'}
📥 *Downloads:* ${user.requests}
📅 *Joined:* ${new Date(user.joinedAt).toLocaleDateString()}
  `.trim(),

  feedback    : `💬 *Send your feedback!*\n\nType your message below.\nPress /cancel to abort.`,
  feedbackOK  : `✅ *Thank you for your feedback!*\n\nWe'll review it shortly.`,
  cancelled   : `❌ *Cancelled.*\n\nSend a new URL whenever you're ready.`,
  banned      : `🚫 *You are banned.*\n\nContact support if this is a mistake.`,
  rateLimited : `⏳ *Too fast!* Wait a few seconds, then try again.`,
  error       : `⚠️ *Something went wrong.*\n\nPlease try again. Use /help if the issue persists.`,

  invalidUrl: `
❌ *Unsupported URL*

Supported platforms:
🔴 YouTube  •  🎵 TikTok  •  📘 Facebook
📸 Instagram  •  🐦 Twitter/X  •  🎬 Vimeo
📌 Pinterest  •  📹 Dailymotion

💡 *Example:*
\`https://www.youtube.com/watch?v=dQw4w9WgXcQ\`
  `.trim(),

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
│  ✅ API access                    │
└─────────────────────────────────┘
  `.trim(),

  playlist: (url) => `
📋 *YouTube Playlist Detected!*

🔗 \`${url.slice(0, 50)}...\`

👑 *Playlist downloads require Elite plan.*

Upgrade below or send a *single video URL* instead.
  `.trim(),
};

// ─── Feedback state ───────────────────────────────────────────
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

// ─── CORE: Real Video Download + Send ────────────────────────
async function handleVideoUrl(msg, url, platform, quality = '720p HD') {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log(userId, 'DOWNLOAD_START', `${platform} | ${quality} | ${url}`);
  addToHistory(userId, { url, platform, quality });

  const qualityKey = quality.toLowerCase();
  const isAudio    = qualityKey === 'mp3 audio';
  const qualityNum = QUALITY_NUM_MAP[qualityKey] || '720';
  const ext        = isAudio ? 'mp3' : 'mp4';
  const jobId      = uuidv4();
  const outTpl     = path.join(TMP_DIR, `${jobId}.%(ext)s`);

  // Build yt-dlp args
  let ytArgs;
  if (isAudio) {
    ytArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-warnings', '-o', outTpl, url];
  } else {
    const fmt = FMT_MAP[qualityNum] || FMT_MAP['720'];
    ytArgs = ['-f', fmt, '--merge-output-format', 'mp4', '--no-warnings', '-o', outTpl, url];
  }

  let statusMsg;

  try {
    await bot.sendChatAction(chatId, 'typing');
    statusMsg = await bot.sendMessage(chatId, MSG.processing(platform, quality), {
      parse_mode: 'Markdown',
    });

    // ── Run yt-dlp ──────────────────────────────────────────
    let lastPct        = 0;
    let lastEditTime   = Date.now();
    const EDIT_COOLDOWN = 3000; // edit at most every 3s (avoid flood)

    await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', ytArgs);
      let   stderr = '';

      proc.stderr.on('data', async (chunk) => {
        const text = chunk.toString();
        stderr    += text;

        // Parse real yt-dlp progress percentage
        const match = text.match(/(\d{1,3}\.\d)%/);
        if (match) {
          const pct = parseFloat(match[1]);
          if (pct > lastPct + 5 && Date.now() - lastEditTime > EDIT_COOLDOWN) {
            lastPct      = pct;
            lastEditTime = Date.now();
            bot.editMessageText(
              MSG.downloading(platform, quality, Math.round(pct)),
              { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }
      });

      proc.on('close', code => {
        if (code === 0) return resolve();
        const err = new Error(stderr);
        err.stderr = stderr;
        reject(err);
      });

      proc.on('error', (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));

      // Kill after 10 minutes
      setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('Timeout')); }, 600_000);
    });

    // ── Find the downloaded file ────────────────────────────
    const filePath = findJobFile(jobId);
    if (!filePath) throw new Error('File not found after download');

    const stat       = fs.statSync(filePath);
    const sizeLabel  = formatSize(stat.size);

    // ── Update status: Sending ──────────────────────────────
    await bot.editMessageText(MSG.sending(platform, quality), {
      chat_id   : chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});

    if (stat.size > MAX_TG_SIZE) {
      // File > 50MB: provide download link
      const link = `${BASE_URL}/api/file/${jobId}`;
      await bot.editMessageText(MSG.largeFile(platform, quality, sizeLabel, link), {
        chat_id     : chatId,
        message_id  : statusMsg.message_id,
        parse_mode  : 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: `⬇️ Download ${sizeLabel}`, url: link },
          ]],
        },
      });
      log(userId, 'LARGE_FILE_LINK', sizeLabel);
      // Don't delete file - let it expire naturally
    } else {
      // Send file directly via Telegram
      await bot.sendChatAction(chatId, isAudio ? 'upload_voice' : 'upload_video');

      if (isAudio) {
        await bot.sendAudio(chatId, filePath, {
          caption   : `🎵 *${capitalize(platform)}* | MP3 Audio\n\n⬆️ Downloaded by @${(await bot.getMe()).username}`,
          parse_mode: 'Markdown',
        });
      } else {
        await bot.sendVideo(chatId, filePath, {
          caption          : `${PLATFORM_ICONS[platform] || '🎬'} *${capitalize(platform)}* | ${quality}\n\n✅ Downloaded via @${(await bot.getMe()).username}`,
          parse_mode       : 'Markdown',
          supports_streaming: true,
        });
      }

      // Delete the progress message
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      // Cleanup temp file
      fs.unlink(filePath, () => {});
      log(userId, 'FILE_SENT', `${sizeLabel} | ${platform} | ${quality}`);
    }

  } catch (err) {
    console.error(`[ERROR] handleVideoUrl | user:${userId} |`, err.message?.slice(0, 200));

    // Friendly error messages
    const errText =
      (err.message?.includes('Private') || err.message?.includes('private'))
        ? '🔒 *Private video*\n\nThis video cannot be downloaded (it\'s private).'
      : (err.message?.includes('age') || err.message?.includes('age-restricted'))
        ? '🔞 *Age-restricted video*\n\nThis video requires sign-in to access.'
      : (err.message?.includes('not available') || err.message?.includes('unavailable'))
        ? '🌍 *Video unavailable*\n\nThis video is not available in the server\'s region.'
      : (err.message?.includes('Timeout') || err.message?.includes('timeout'))
        ? '⏱️ *Timeout*\n\nThe download took too long. Try a shorter video or lower quality.'
      : (err.message?.includes('yt-dlp not found'))
        ? '⚙️ *Server error*\n\nyt-dlp is not installed. Contact admin.'
      : MSG.error;

    if (statusMsg) {
      await bot.editMessageText(errText, {
        chat_id   : chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown',
      }).catch(() =>
        bot.sendMessage(chatId, errText, { parse_mode: 'Markdown' }).catch(() => {})
      );
    } else {
      await bot.sendMessage(chatId, errText, { parse_mode: 'Markdown' }).catch(() => {});
    }

    // Cleanup any partial file
    const partial = findJobFile(jobId);
    if (partial) fs.unlink(partial, () => {});
  }
}

// ─── Incoming message handler ─────────────────────────────────
async function handleMessage(msg) {
  if (!msg.text || msg.text.startsWith('/')) return;

  const { id } = msg.from;
  registerUser(msg);

  if (isBanned(id)) return bot.sendMessage(id, MSG.banned, { parse_mode: 'Markdown' });

  // Feedback flow
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

  // Rate limit
  if (isRateLimited(id)) {
    log(id, 'RATE_LIMITED');
    return bot.sendMessage(id, MSG.rateLimited, { parse_mode: 'Markdown' });
  }

  // URL detection
  const url = extractUrl(msg.text);
  if (!url) return bot.sendMessage(id, MSG.invalidUrl, { parse_mode: 'Markdown' });

  const platform = detectPlatform(url);
  if (!platform) {
    log(id, 'UNSUPPORTED_URL', url);
    return bot.sendMessage(id, MSG.invalidUrl, { parse_mode: 'Markdown' });
  }

  // Playlist check
  if (platform === 'youtube' && isPlaylist(url)) {
    const user = getUser(id);
    if (user?.plan !== 'elite') {
      return bot.sendMessage(id, MSG.playlist(url), {
        parse_mode  : 'Markdown',
        reply_markup: premiumKeyboard(),
      });
    }
  }

  // Ask quality
  store.pendingDl.set(id, { url, platform });
  log(id, 'ASK_QUALITY', `${platform} | ${url}`);
  return bot.sendMessage(id, MSG.askQuality(platform, url), {
    parse_mode  : 'Markdown',
    reply_markup: qualityKeyboard(url, platform),
  });
}

// ─── Callback query handler ───────────────────────────────────
async function handleCallback(query) {
  const { id: queryId, data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;

  await bot.answerCallbackQuery(queryId);
  log(userId, 'CALLBACK', data);

  // ── Quality selection → start real download ────────────────
  if (data.startsWith('q:')) {
    const parts    = data.split(':');
    const quality  = parts[1]; // e.g. '720', '1080', 'mp3', '4k'
    const urlFrag  = parts.slice(2).join(':');
    const pending  = store.pendingDl.get(userId);
    const url      = pending?.url || urlFrag;
    const platform = pending?.platform || 'unknown';
    store.pendingDl.delete(userId);

    const qualityLabels = {
      '1080' : '1080p HD',
      '720'  : '720p HD',
      '480'  : '480p',
      'mp3'  : 'MP3 Audio',
      '4k'   : '4K Ultra HD',
    };
    const qualityLabel = qualityLabels[quality] || quality;

    // 4K gate
    const user = getUser(userId);
    if (quality === '4k' && user?.plan === 'free') {
      return bot.sendMessage(chatId,
        `👑 *4K requires Elite plan.*\n\nUpgrade to unlock 4K downloads!`,
        { parse_mode: 'Markdown', reply_markup: premiumKeyboard() }
      );
    }

    // Delete quality picker message
    await bot.deleteMessage(chatId, message.message_id).catch(() => {});

    // Start real download!
    return handleVideoUrl(
      { chat: { id: chatId }, from: { id: userId } },
      url, platform, qualityLabel
    );
  }

  // ── History ────────────────────────────────────────────────
  if (data === 'history') {
    const user = getUser(userId);
    return bot.sendMessage(chatId, MSG.history(user?.history || []), { parse_mode: 'Markdown' });
  }

  // ── Cancel ─────────────────────────────────────────────────
  if (data === 'cancel') {
    store.pendingDl.delete(userId);
    return bot.editMessageText(MSG.cancelled, {
      chat_id: chatId, message_id: message.message_id, parse_mode: 'Markdown',
    }).catch(() => bot.sendMessage(chatId, MSG.cancelled, { parse_mode: 'Markdown' }));
  }

  // ── New download ───────────────────────────────────────────
  if (data === 'new_download') {
    return bot.sendMessage(chatId, '📎 *Send me a new video URL!*', { parse_mode: 'Markdown' });
  }

  // ── Rate the bot ───────────────────────────────────────────
  if (data === 'rate') {
    return bot.sendMessage(chatId, '⭐ *How would you rate this bot?*', {
      parse_mode: 'Markdown', reply_markup: ratingKeyboard(),
    });
  }

  if (data.startsWith('rate:')) {
    const stars  = parseInt(data.split(':')[1]);
    const emojis = ['😕', '😐', '🙂', '😊', '🤩'];
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

  // ── Premium ────────────────────────────────────────────────
  if (['premium', 'upgrade_now', 'buy_pro', 'buy_elite'].includes(data)) {
    await bot.sendChatAction(chatId, 'typing');
    return bot.sendMessage(chatId, MSG.premium, {
      parse_mode: 'Markdown', reply_markup: premiumKeyboard(),
    });
  }

  // ── Back to start ──────────────────────────────────────────
  if (data === 'back_start') {
    return bot.sendMessage(chatId, MSG.welcome(from.first_name), {
      parse_mode: 'Markdown', reply_markup: miniAppKeyboard(),
    });
  }

  // ── Admin: Users ───────────────────────────────────────────
  if (data === 'admin_users' && userId === ADMIN_ID) {
    const list = [...store.users.entries()].slice(0, 15).map(([uid, u]) =>
      `• ${u.firstName} (\`${uid}\`) — ${u.requests} dls — ${u.plan}${u.banned ? ' 🚫' : ''}`
    ).join('\n');
    return bot.sendMessage(chatId, `👥 *Users (top 15):*\n\n${list || 'None'}`, { parse_mode: 'Markdown' });
  }

  // ── Admin: Feedbacks ───────────────────────────────────────
  if (data === 'admin_feedbacks' && userId === ADMIN_ID) {
    const fbs = store.feedback.slice(-8).map((f, i) =>
      f.type === 'rating'
        ? `${i + 1}. ⭐${f.stars} from \`${f.userId}\``
        : `${i + 1}. 💬 \`${f.userId}\`: ${(f.text || '').slice(0, 60)}`
    ).join('\n');
    return bot.sendMessage(chatId, `💬 *Recent Feedbacks:*\n\n${fbs || 'None'}`, { parse_mode: 'Markdown' });
  }

  // ── Admin: Stats ───────────────────────────────────────────
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
  return bot.sendMessage(id, `✅ Broadcast done.\n📤 Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'Markdown' });
}

async function handleBan(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });
  const targetId = parseInt(msg.text.replace('/ban', '').trim());
  if (!targetId) return bot.sendMessage(id, '⚠️ Usage: `/ban <userId>`', { parse_mode: 'Markdown' });
  const user = store.users.get(targetId);
  if (!user) return bot.sendMessage(id, '❌ User not found.');
  user.banned = true;
  log(id, 'BAN', `${targetId}`);
  return bot.sendMessage(id, `✅ User \`${targetId}\` (*${user.firstName}*) banned.`, { parse_mode: 'Markdown' });
}

async function handleUnban(msg) {
  const { id } = msg.from;
  if (id !== ADMIN_ID) return bot.sendMessage(id, '🚫 *Unauthorized.*', { parse_mode: 'Markdown' });
  const targetId = parseInt(msg.text.replace('/unban', '').trim());
  if (!targetId) return bot.sendMessage(id, '⚠️ Usage: `/unban <userId>`', { parse_mode: 'Markdown' });
  const user = store.users.get(targetId);
  if (!user) return bot.sendMessage(id, '❌ User not found.');
  user.banned = false;
  log(id, 'UNBAN', `${targetId}`);
  return bot.sendMessage(id, `✅ User \`${targetId}\` (*${user.firstName}*) unbanned.`, { parse_mode: 'Markdown' });
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
process.on('uncaughtException',  (e) => console.error('[UNCAUGHT]',  e.message));

// ─── Startup ──────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🤖  Premium Video Downloader Bot v3.0 — ONLINE');
console.log(`👑  Admin ID : ${ADMIN_ID || 'NOT SET'}`);
console.log(`🌐  Mini App : ${MINI_APP_URL}`);
console.log(`🔗  Base URL : ${BASE_URL}`);
console.log(`📁  Tmp Dir  : ${TMP_DIR}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
