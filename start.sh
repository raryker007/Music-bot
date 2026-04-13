#!/bin/bash
# ============================================================
#  Premium Video Downloader — Start Script v3.0
#  Runs: Express API Server + Telegram Bot + Cloudflare Tunnel
# ============================================================

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀  Premium Video Downloader v3.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd ~/video-miniapp

# ── Check .env ────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "⚠️  .env file not found! Creating from .env.example..."
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "📝  Edit .env and fill in BOT_TOKEN, ADMIN_ID, BASE_URL"
    exit 1
  else
    echo "❌  .env.example not found either. Create .env manually."
    exit 1
  fi
fi

# ── Check yt-dlp ──────────────────────────────────────────────
if ! command -v yt-dlp &>/dev/null; then
  echo "📦  yt-dlp not found. Installing..."
  pip install yt-dlp --break-system-packages 2>/dev/null || pip3 install yt-dlp 2>/dev/null || {
    echo "❌  Failed to install yt-dlp. Run: pip install yt-dlp"
    exit 1
  }
  echo "✅  yt-dlp installed!"
else
  echo "✅  yt-dlp: $(yt-dlp --version)"
fi

# ── Check ffmpeg (needed for merging video+audio) ─────────────
if ! command -v ffmpeg &>/dev/null; then
  echo "⚠️  ffmpeg not found. Some quality options may not work."
  echo "   Install: sudo apt install ffmpeg"
else
  echo "✅  ffmpeg: $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"
fi

# ── Install Node deps ─────────────────────────────────────────
echo "📦  Checking Node.js dependencies..."
npm install --silent 2>/dev/null || npm install
echo "✅  Node deps ready!"

# ── Kill old processes ────────────────────────────────────────
echo "🔴  Stopping old processes..."
pkill -f "node server.js" 2>/dev/null || true
pkill -f "node bot.js"    2>/dev/null || true
pkill -f "cloudflared"    2>/dev/null || true
pkill -f "http-server"    2>/dev/null || true
sleep 2

# ── Create tmp dir ────────────────────────────────────────────
mkdir -p /tmp/video-dl
echo "✅  Temp directory: /tmp/video-dl"

# ── Start Express API server ──────────────────────────────────
echo ""
echo "✅  Starting Express API server on port 3000..."
node server.js &
SERVER_PID=$!
sleep 3

if curl -s http://localhost:3000 > /dev/null 2>&1; then
  echo "✅  Express server running! (PID: $SERVER_PID)"
else
  echo "❌  Express server failed to start. Check server.js logs."
  exit 1
fi

# ── Start Telegram bot ────────────────────────────────────────
echo ""
echo "✅  Starting Telegram Bot..."
node bot.js &
BOT_PID=$!
sleep 2
echo "✅  Bot running! (PID: $BOT_PID)"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Express Server PID : $SERVER_PID"
echo "✅  Bot PID            : $BOT_PID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐  Starting Cloudflare Tunnel..."
echo "⚠️  Copy the HTTPS URL below and:"
echo "    1. Set it as BASE_URL in your .env file"
echo "    2. Set it as MINI_APP_URL in your .env file"
echo "    3. Update it in BotFather → Edit Bot → Edit Mini App URL"
echo ""

# Start Cloudflare tunnel (foreground so URL is visible)
cloudflared tunnel --url http://localhost:3000
