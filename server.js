'use strict';
/**
 * ============================================================
 *  Premium Video Downloader — Express API Server  v3.0
 *  Routes:
 *    GET  /            → Serve index.html (Mini App)
 *    GET  /api/info    → Fetch video metadata via yt-dlp
 *    GET  /api/download → Download & stream file to browser
 *    GET  /api/file/:jobId → Serve pre-downloaded file (for Telegram)
 * ============================================================
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;

// ── yt-dlp Binary Setup ───────────────────────────────────────
const YTDLP_PATH = '/tmp/yt-dlp-bin';
(async () => {
  try {
    const ytDlp = new YTDlpWrap(YTDLP_PATH);
    await ytDlp.getVersion();
    console.log('[SERVER] ✅ yt-dlp ready');
  } catch {
    try {
      console.log('[SERVER] ⏳ Downloading yt-dlp...');
      await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
      console.log('[SERVER] ✅ yt-dlp downloaded!');
    } catch(e) {
      console.error('[SERVER] ❌ yt-dlp failed:', e.message);
    }
  }
})();
const { v4: uuidv4 } = require('uuid');

const app      = express();
const PORT     = process.env.PORT || 3000;
const TMP_DIR  = process.env.TMP_DIR || '/tmp/video-dl';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Ensure temp dir exists ─────────────────────────────────────
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Auto-clean files older than 2 hours ────────────────────────
setInterval(() => {
  try {
    fs.readdirSync(TMP_DIR).forEach(f => {
      const fp   = path.join(TMP_DIR, f);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > 7_200_000) fs.unlinkSync(fp);
    });
  } catch {}
}, 3_600_000);

// ── Quality format map for yt-dlp ─────────────────────────────
const FMT_MAP = {
  '1080' : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720'  : 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480'  : 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
  '4k'   : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
};

// ── Helper: find an output file by jobId prefix ─────────────────
function findJobFile(jobId) {
  try {
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId));
    return files.length > 0 ? path.join(TMP_DIR, files[0]) : null;
  } catch { return null; }
}

// ── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── GET / ── Serve Mini App ────────────────────────────────────
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.status(404).send('index.html not found');
});

// ── GET /api/info?url=... ──────────────────────────────────────
// Returns: { title, thumbnail, duration, uploader, platform }
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });

  const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-playlist', '--no-warnings', url]);
  let out = '', err = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);

  proc.on('close', code => {
    if (code !== 0) {
      const friendly = err.includes('Private video') ? 'Private video — cannot access'
        : err.includes('age')           ? 'Age-restricted video'
        : err.includes('not available') ? 'Video not available in this region'
        : 'Failed to fetch video info';
      return res.status(400).json({ error: friendly, raw: err.slice(0, 300) });
    }
    try {
      const info = JSON.parse(out.trim());
      res.json({
        title      : info.title      || 'Unknown Title',
        thumbnail  : info.thumbnail  || '',
        duration   : info.duration   || 0,
        uploader   : info.uploader   || '',
        view_count : info.view_count || 0,
        platform   : (info.extractor_key || '').toLowerCase(),
        webpage_url: info.webpage_url || url,
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video metadata' });
    }
  });

  proc.on('error', () =>
    res.status(500).json({ error: 'yt-dlp is not installed. Run: pip install yt-dlp' })
  );

  // Timeout after 30s
  setTimeout(() => { try { proc.kill(); } catch {} }, 30_000);
});

// ── GET /api/download?url=...&quality=720&format=mp4 ───────────
// Streams the downloaded file directly to the browser
app.get('/api/download', (req, res) => {
  const { url, quality = '720', format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const jobId  = uuidv4();
  const ext    = format === 'mp3' ? 'mp3' : 'mp4';
  const outTpl = path.join(TMP_DIR, `${jobId}.%(ext)s`);

  // Build yt-dlp args
  let args;
  if (format === 'mp3') {
    args = [
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--no-warnings', '-o', outTpl, url,
    ];
  } else {
    const fmt = FMT_MAP[quality] || FMT_MAP['720'];
    args = [
      '-f', fmt, '--merge-output-format', 'mp4',
      '--no-warnings', '-o', outTpl, url,
    ];
  }

  console.log(`[DOWNLOAD] jobId:${jobId} quality:${quality} format:${format} url:${url.slice(0, 60)}`);

  const proc   = spawn(YTDLP_PATH, args);
  let   stderr = '';
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    if (code !== 0) {
      console.error(`[DOWNLOAD FAIL] ${stderr.slice(-300)}`);
      const friendly = stderr.includes('Private')    ? 'Private video — cannot download'
        : stderr.includes('age')         ? 'Age-restricted video'
        : stderr.includes('not available')? 'Not available in this region'
        : 'Download failed — video may be unavailable';
      if (!res.headersSent) res.status(500).json({ error: friendly });
      return;
    }

    // Find actual output (ext may vary)
    let filePath = path.join(TMP_DIR, `${jobId}.${ext}`);
    if (!fs.existsSync(filePath)) {
      const found = findJobFile(jobId);
      if (!found) {
        if (!res.headersSent) res.status(500).json({ error: 'File missing after download' });
        return;
      }
      filePath = found;
    }

    const stat     = fs.statSync(filePath);
    const filename = `video_${quality}p.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', ()  => fs.unlink(filePath, () => {}));
    res.on('close',   ()   => fs.unlink(filePath, () => {}));
  });

  proc.on('error', err => {
    console.error('[YT-DLP ERROR]', err.message);
    if (!res.headersSent)
      res.status(500).json({ error: 'yt-dlp not found. Run: pip install yt-dlp' });
  });

  // Kill after 10 minutes
  const timeout = setTimeout(() => {
    try { proc.kill(); } catch {}
    if (!res.headersSent) res.status(504).json({ error: 'Download timeout (10 min)' });
  }, 600_000);
  proc.on('close', () => clearTimeout(timeout));
});

// ── GET /api/download/start?url=...&quality=...&format=... ──────
// Starts background download, returns jobId immediately
// Used by Telegram bot for async downloads
app.get('/api/download/start', (req, res) => {
  const { url, quality = '720', format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const jobId  = uuidv4();
  const ext    = format === 'mp3' ? 'mp3' : 'mp4';
  const outTpl = path.join(TMP_DIR, `${jobId}.%(ext)s`);

  let args;
  if (format === 'mp3') {
    args = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-warnings', '-o', outTpl, url];
  } else {
    const fmt = FMT_MAP[quality] || FMT_MAP['720'];
    args = ['-f', fmt, '--merge-output-format', 'mp4', '--no-warnings', '-o', outTpl, url];
  }

  // Store job state in memory
  app.locals.jobs = app.locals.jobs || {};
  app.locals.jobs[jobId] = { status: 'downloading', progress: 0, ext, error: null, startedAt: Date.now() };

  res.json({ jobId, message: 'Download started' });

  // Run in background
  const proc = spawn(YTDLP_PATH, args);
  proc.stderr.on('data', d => {
    const str = d.toString();
    const m = str.match(/(\d{1,3}\.\d)%/);
    if (m && app.locals.jobs[jobId]) {
      app.locals.jobs[jobId].progress = parseFloat(m[1]);
    }
  });
  proc.on('close', code => {
    if (!app.locals.jobs[jobId]) return;
    if (code === 0) {
      app.locals.jobs[jobId].status = 'ready';
      app.locals.jobs[jobId].progress = 100;
    } else {
      app.locals.jobs[jobId].status = 'error';
      app.locals.jobs[jobId].error  = 'Download failed';
    }
  });
  proc.on('error', () => {
    if (app.locals.jobs[jobId]) {
      app.locals.jobs[jobId].status = 'error';
      app.locals.jobs[jobId].error  = 'yt-dlp not found';
    }
  });
});

// ── GET /api/download/status/:jobId ───────────────────────────
app.get('/api/download/status/:jobId', (req, res) => {
  const job = (app.locals.jobs || {})[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── GET /api/file/:jobId ───────────────────────────────────────
// Serve a pre-downloaded file (used by Telegram bot large files)
app.get('/api/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[\w-]+$/.test(jobId)) return res.status(400).end();

  const filePath = findJobFile(jobId);
  if (!filePath) return res.status(404).json({ error: 'File not found or expired (1h)' });

  const ext  = path.extname(filePath).slice(1);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
  res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐  API Server v3.0 — port ${PORT}`);
  console.log(`📁  Temp dir : ${TMP_DIR}`);
  console.log(`🔗  Base URL : ${BASE_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

module.exports = { app, BASE_URL, TMP_DIR, FMT_MAP, findJobFile };
