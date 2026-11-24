// Procedural Web Audio one-shot UI clicks & game chimes (no background loops)
export function createAudioSystem(settings) {
  let ctx = null;

  function ensureContext() {
    if (settings && settings.muted) return null;
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function playTone(freq, duration, type = "sine", gainVal = 0.08, delay = 0) {
    const c = ensureContext();
    if (!c) return;
    try {
      const now = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainVal, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (_) {}
  }

  function playGlide(startFreq, endFreq, duration, type = "sine", gainVal = 0.06, delay = 0) {
    const c = ensureContext();
    if (!c) return;
    try {
      const now = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainVal, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (_) {}
  }

  return {
    playClick() {
      playTone(680, 0.045, "triangle", 0.055);
    },
    playKey() {
      playTone(820, 0.028, "triangle", 0.035);
    },
    playPin() {
      playTone(520, 0.06, "sine", 0.07, 0);
      playTone(780, 0.08, "sine", 0.07, 0.045);
    },
    playZoom(zoomIn = true) {
      playTone(zoomIn ? 760 : 540, 0.04, "sine", 0.045);
    },
    playMenuOpen() {
      playGlide(360, 620, 0.09, "sine", 0.05);
    },
    playMenuClose() {
      playGlide(560, 320, 0.085, "sine", 0.045);
    },
    playFly() {
      playGlide(260, 520, 0.18, "sine", 0.055);
    },
    playEnterSV() {
      playGlide(340, 680, 0.14, "sine", 0.06);
      playTone(880, 0.09, "sine", 0.045, 0.09);
    },
    playExitSV() {
      playGlide(620, 310, 0.14, "sine", 0.055);
    },
    playStep(isBoost = false) {
      playTone(isBoost ? 480 : 320, 0.032, "triangle", isBoost ? 0.032 : 0.025);
    },
    playError() {
      playTone(230, 0.09, "triangle", 0.065, 0);
      playTone(175, 0.13, "triangle", 0.065, 0.08);
    },
    playLockIn() {
      playTone(440, 0.09, "sine", 0.08, 0);
      playTone(660, 0.12, "sine", 0.08, 0.07);
    },
    playReveal(score = 0) {
      if (score >= 4000) {
        playTone(523.25, 0.11, "sine", 0.09, 0);
        playTone(659.25, 0.11, "sine", 0.09, 0.09);
        playTone(783.99, 0.18, "sine", 0.10, 0.18);
      } else if (score >= 2000) {
        playTone(440, 0.11, "sine", 0.08, 0);
        playTone(554.37, 0.15, "sine", 0.08, 0.09);
      } else {
        playTone(330, 0.12, "triangle", 0.07, 0);
        playTone(261.63, 0.16, "triangle", 0.07, 0.10);
      }
    },
    playFanfare(isNewBest = false) {
      playTone(523.25, 0.12, "sine", 0.08, 0);
      playTone(659.25, 0.12, "sine", 0.08, 0.09);
      playTone(783.99, 0.14, "sine", 0.085, 0.18);
      playTone(1046.5, 0.26, "sine", 0.095, 0.27);
      if (isNewBest) {
        playTone(1318.5, 0.30, "sine", 0.085, 0.39);
      }
    },
    playLucky() {
      playTone(587.33, 0.07, "sine", 0.07, 0);
      playTone(880, 0.11, "sine", 0.08, 0.06);
    }
  };
}
