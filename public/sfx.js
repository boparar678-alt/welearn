(function (global) {
  'use strict';

  const MUTE_KEY = 'welearn_sfx_muted';
  let ctx = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';

  function getCtx() {
    if (muted) return null;
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function unlock() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) {
        ctx = new AC();
      }
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    global.addEventListener(evt, unlock, { passive: true, once: false });
  });

  function tone(c, freq, startOffset, dur, type, gainPeak, endFreq) {
    const now = c.currentTime + startOffset;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + dur);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak || 0.16, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function playTap() {
    const c = getCtx();
    if (!c) return;
    tone(c, 520, 0, 0.07, 'sine', 0.09, 680);
  }

  function playCorrect() {
    const c = getCtx();
    if (!c) return;
    // Bright ascending major chime
    tone(c, 523.25, 0.0, 0.14, 'triangle', 0.18);   // C5
    tone(c, 659.25, 0.08, 0.14, 'triangle', 0.18);  // E5
    tone(c, 783.99, 0.16, 0.16, 'triangle', 0.19);  // G5
    tone(c, 1046.5, 0.25, 0.34, 'sine', 0.22);      // C6
  }

  function playWrong() {
    const c = getCtx();
    if (!c) return;
    // Distinct low descending buzz
    tone(c, 220, 0.0, 0.18, 'sawtooth', 0.11, 175);
    tone(c, 165, 0.16, 0.28, 'sawtooth', 0.12, 115);
    tone(c, 165, 0.16, 0.28, 'triangle', 0.12, 115);
  }

  function playLeaderboardChange() {
    const c = getCtx();
    if (!c) return;
    // Crisp shimmering update ping
    tone(c, 880, 0.0, 0.09, 'sine', 0.11);    // A5
    tone(c, 1174.66, 0.07, 0.16, 'sine', 0.12); // D6
  }

  function playFanfare() {
    const c = getCtx();
    if (!c) return;
    // Victory celebration fanfare
    tone(c, 523.25, 0.0, 0.14, 'triangle', 0.18);   // C5
    tone(c, 659.25, 0.11, 0.14, 'triangle', 0.18);  // E5
    tone(c, 783.99, 0.22, 0.14, 'triangle', 0.19);  // G5
    tone(c, 1046.5, 0.34, 0.22, 'triangle', 0.22);  // C6
    tone(c, 783.99, 0.52, 0.14, 'triangle', 0.17);  // G5
    tone(c, 1046.5, 0.65, 0.65, 'triangle', 0.24);  // C6 hold
    tone(c, 523.25, 0.65, 0.65, 'sine', 0.14);      // C5 harmony
  }

  function isMuted() {
    return muted;
  }

  function setMuted(next) {
    muted = !!next;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (!muted) unlock();
    return muted;
  }

  function bindMuteButton(btn) {
    if (!btn) return;
    const renderBtn = () => {
      btn.textContent = muted ? '🔇 Sound Off' : '🔊 Sound On';
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    };
    renderBtn();
    btn.addEventListener('click', () => {
      setMuted(!muted);
      renderBtn();
      if (!muted) playTap();
    });
  }

  function launchCelebration() {
    const existing = document.getElementById('welearn-confetti');
    if (existing) existing.remove();

    const canvas = document.createElement('canvas');
    canvas.id = 'welearn-confetti';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);

    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    let w = (canvas.width = global.innerWidth * dpr);
    let h = (canvas.height = global.innerHeight * dpr);
    const context = canvas.getContext('2d');
    const palette = ['#e71d2e', '#2e3890', '#ffffff', '#ffcc33', '#29c76f', '#c9cdea'];

    const pieces = Array.from({ length: 130 }, (_, i) => {
      const fromLeft = i % 2 === 0;
      const angle = fromLeft ? (-Math.PI / 3 + (Math.random() - 0.5) * 0.8) : (-2 * Math.PI / 3 + (Math.random() - 0.5) * 0.8);
      const speed = (10 + Math.random() * 14) * dpr;
      return {
        x: fromLeft ? w * 0.15 : w * 0.85,
        y: h * 0.72,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4 * dpr,
        size: (5 + Math.random() * 6) * dpr,
        color: palette[i % palette.length],
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.25,
        alpha: 1,
      };
    });

    const start = performance.now();
    function frame(now) {
      const elapsed = now - start;
      context.clearRect(0, 0, w, h);
      let alive = 0;

      for (const p of pieces) {
        p.vy += 0.34 * dpr;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vRot;
        if (elapsed > 2400) {
          p.alpha = Math.max(0, 1 - (elapsed - 2400) / 1200);
        }
        if (p.alpha > 0 && p.y < h + 40 * dpr) {
          alive++;
          context.save();
          context.globalAlpha = p.alpha;
          context.translate(p.x, p.y);
          context.rotate(p.rot);
          context.fillStyle = p.color;
          context.fillRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.7);
          context.restore();
        }
      }

      if (alive > 0 && elapsed < 3800) {
        global.requestAnimationFrame(frame);
      } else {
        canvas.remove();
      }
    }
    global.requestAnimationFrame(frame);
  }

  function formatWhatsAppLeaderboard(title, list) {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const lines = [
      `🏆 *WeLearn Quiz Results*`,
      title ? `*${title}*` : '',
      list && list.length > 0 ? `_Participants attempted: ${list.length}_` : '',
      '',
    ];
    if (!list || list.length === 0) {
      lines.push('_No attempted players recorded yet._');
    } else {
      list.forEach((row) => {
        const prefix = medals[row.rank] || `${row.rank}.`;
        const avatar = row.avatar ? `${row.avatar} ` : '';
        const scoreStr = Number(row.score || 0).toLocaleString();
        const extra = typeof row.correct === 'number'
          ? (typeof row.answered === 'number' ? ` (${row.correct}/${row.answered} correct)` : ` (${row.correct} correct)`)
          : '';
        lines.push(`${prefix} ${avatar}*${row.name}* — ${scoreStr} pts${extra}`);
      });
    }
    lines.push('', '_Shared from WeLearn by ASPIRA_');
    return lines.filter((l, idx) => !(l === '' && lines[idx - 1] === '')).join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  global.WeLearnFX = {
    playTap,
    playCorrect,
    playWrong,
    playLeaderboardChange,
    playFanfare,
    isMuted,
    setMuted,
    bindMuteButton,
    launchCelebration,
    formatWhatsAppLeaderboard,
    copyText,
  };
})(window);
