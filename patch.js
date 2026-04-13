/**
 * ============================================================
 *  Premium Video Hub — Download Patch v3.0
 *  Fixes: Real download via /api/download/start + status poll
 *  Add: <script src="patch.js"></script> before </body> in index.html
 * ============================================================
 */

(function () {
  'use strict';

  // Wait for page to fully load before patching
  document.addEventListener('DOMContentLoaded', () => {
    // Poll until Download object is ready
    const waitForDownload = setInterval(() => {
      if (typeof Download === 'undefined') return;
      clearInterval(waitForDownload);
      applyPatch();
    }, 100);
  });

  function applyPatch() {
    console.info('[Patch v3] Applying real download engine...');

    // ── Quality map ────────────────────────────────────────────
    const QUALITY_MAP = {
      '480p'        : { num: '480',  fmt: 'mp4' },
      '720p HD'     : { num: '720',  fmt: 'mp4' },
      '1080p HD'    : { num: '1080', fmt: 'mp4' },
      'MP3 Audio'   : { num: 'mp3',  fmt: 'mp3' },
      '4K Ultra HD' : { num: '4k',   fmt: 'mp4' },
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ── Helper: update progress bar ────────────────────────────
    function setProgress(pct, msg = '') {
      const bar   = document.getElementById('dl-progress-bar');
      const label = document.getElementById('dl-progress-label');
      const eta   = document.getElementById('dl-eta');
      if (bar)   bar.style.width      = `${Math.min(pct, 100)}%`;
      if (label) label.textContent    = `${Math.round(pct)}%`;
      if (eta)   eta.textContent      = msg || `${Math.round(pct)}%`;
    }

    function setStep(id, state /* 'active' | 'done' | '' */) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('active', 'done');
      if (state) el.classList.add(state);
    }

    // ── Patched startDownload ──────────────────────────────────
    Download.startDownload = async function () {
      if (!this.currentUrl || !this.selectedQuality) return;

      const url      = this.currentUrl.trim();
      const quality  = this.selectedQuality;
      const platform = this.detectedPlatform;
      const plat     = platform && typeof PLATFORMS !== 'undefined' ? PLATFORMS[platform] : null;
      const qinfo    = QUALITY_MAP[quality] || { num: '720', fmt: 'mp4' };

      // ── UI: Hide form, show progress ───────────────────────
      document.getElementById('platform-card')?.classList.remove('visible');
      document.getElementById('start-download-btn').disabled = true;
      document.getElementById('download-progress-wrap').style.display = 'block';
      document.getElementById('download-result-wrap').style.display   = 'none';
      document.getElementById('dl-progress-title').textContent =
        `${plat ? plat.icon + ' ' : ''}${quality}…`;

      const steps = ['tl-dl-fetch', 'tl-dl-process', 'tl-dl-ready'];
      steps.forEach(id => setStep(id, ''));
      setProgress(3, 'Connecting...');
      setStep('tl-dl-fetch', 'active');

      try {
        // ── Step 1: Start background download job ─────────────
        const startRes = await fetch(
          `/api/download/start?url=${encodeURIComponent(url)}&quality=${qinfo.num}&format=${qinfo.fmt}`
        );

        if (!startRes.ok) {
          const err = await startRes.json().catch(() => ({}));
          throw new Error(err.error || 'Server error');
        }

        const { jobId } = await startRes.json();
        setProgress(10, 'Download started...');

        // ── Step 2: Poll progress ─────────────────────────────
        setStep('tl-dl-fetch', 'done');
        setStep('tl-dl-process', 'active');
        setProgress(15, 'Downloading...');

        let done = false;
        let polls = 0;
        const MAX_POLLS = 300; // 10 min max (2s × 300)

        while (!done && polls < MAX_POLLS) {
          await sleep(2000);
          polls++;

          let status;
          try {
            const sr = await fetch(`/api/download/status/${jobId}`);
            status   = await sr.json();
          } catch {
            continue; // network hiccup, retry
          }

          if (status.status === 'ready') {
            done = true;
            setProgress(97, 'Almost ready...');
          } else if (status.status === 'error') {
            throw new Error(status.error || 'Download failed on server');
          } else {
            // Real progress from yt-dlp
            const pct = Math.max(15, Math.min(95, status.progress || 15));
            setProgress(pct, `Downloading... ${Math.round(pct)}%`);
          }
        }

        if (!done) throw new Error('Download timeout — try a lower quality or shorter video');

        // ── Step 3: Ready ─────────────────────────────────────
        setStep('tl-dl-process', 'done');
        setStep('tl-dl-ready', 'active');
        setProgress(100, 'Ready!');
        await sleep(300);
        setStep('tl-dl-ready', 'done');

        // Save to history
        if (typeof State !== 'undefined') {
          State.dlHistory.unshift({ url, platform, quality, date: new Date().toISOString() });
          if (State.dlHistory.length > 50) State.dlHistory.pop();
          if (typeof _saveDlHistory === 'function') _saveDlHistory();
        }

        // ── Show result with real download button ─────────────
        document.getElementById('download-progress-wrap').style.display = 'none';
        document.getElementById('download-result-wrap').style.display   = 'block';
        document.getElementById('dl-result-info').textContent =
          `${plat ? plat.name + ' · ' : ''}${quality} · Ready to save`;

        const saveBtn = document.getElementById('dl-result-btn');
        saveBtn.textContent = '⬇️ Save File';
        saveBtn.onclick = () => {
          window.location.href = `/api/file/${jobId}`;
          if (typeof Toast !== 'undefined') Toast.show('Saving file...', 'success');
          if (typeof TG !== 'undefined')    TG.haptic('notification', 'success');
        };

        if (typeof TG   !== 'undefined') TG.haptic('notification', 'success');
        if (typeof Toast !== 'undefined') Toast.show('✅ Download ready! Tap "Save File"', 'success');
        if (typeof UI   !== 'undefined') UI.refreshDlHistory();

      } catch (err) {
        console.error('[Download Error]', err.message);

        // Friendly error messages
        const msg =
          err.message.includes('Private')       ? 'Private video — cannot download'
          : err.message.includes('age')          ? 'Age-restricted video — unavailable'
          : err.message.includes('not available')? 'Video not available in this region'
          : err.message.includes('timeout')      ? 'Download timed out — try lower quality'
          : err.message.includes('yt-dlp')       ? 'Server not configured. Contact admin.'
          : `Download failed: ${err.message}`;

        // Reset UI on error
        document.getElementById('download-progress-wrap').style.display = 'none';
        document.getElementById('platform-card')?.classList.add('visible');
        document.getElementById('start-download-btn').disabled = false;
        document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));

        if (typeof Toast !== 'undefined') Toast.show(`❌ ${msg}`, 'error', 5000);
        if (typeof TG   !== 'undefined')  TG.haptic('notification', 'error');

        // Reset download state
        Download.selectedQuality = null;
      }
    };

    // ── Also fix "Reset" to clear properly ────────────────────
    const origReset = Download.reset?.bind(Download);
    Download.reset = function () {
      if (origReset) origReset();
      // Clear result button state
      const saveBtn = document.getElementById('dl-result-btn');
      if (saveBtn) {
        saveBtn.textContent = '⬇️ Download File';
        saveBtn.onclick     = null;
      }
    };

    console.info('[Patch v3] ✅ Download engine patched successfully!');
  }
})();
