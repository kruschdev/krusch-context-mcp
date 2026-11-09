#!/usr/bin/env node
/**
 * Deterministic 1080p Narrated Product & Terminal Walkthrough Video Generator
 * for krusch-context-mcp v2.0.
 *
 * Pipeline:
 *  1. Synthesizes (or reuses cached) per-scene neural voiceover WAVs (Gemini TTS primary
 *     with automatic neural edge-tts fallback), resampled to 44.1 kHz PCM16.
 *  2. Parses exact WAV headers & PCM samples via @krusch/toolkit/audio (`parseWavHeader`)
 *     to lock scene durations to frame-exact boundaries (0.000 ms cumulative drift) and
 *     extract a 30fps audio-reactive voiceover equalizer envelope.
 *  3. Synthesizes a stereo low-passed dark-cyber ambient pad + scene transition harmonic
 *     chimes with sample-accurate vocal sidechain ducking via @krusch/toolkit/audio
 *     (`encodeWavPcm16`).
 *  4. Renders every 1920x1080 @ 30fps frame deterministically in a persistent headless
 *     Chromium page via @krusch/toolkit/browser (`launchBrowser`) and streams frames
 *     with backpressure into FFmpeg (`libx264` yuv420p + `aac` 192k + `+faststart`),
 *     plus sidecar `.srt` subtitles and 6 QA keyframe PNGs.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWavPcm16, parseWavHeader } from '../../../lib/audio.js';
import { launchBrowser } from '../../../lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'docs', 'assets');

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_RATE = 44_100;

/**
 * Canonical 6-Scene Storyboard (~68s total).
 * `spoken` is tuned for natural English TTS prosody ("Crush Context MCP").
 * `srt` and `captionHtml` preserve exact package/code orthography (`krusch-context-mcp`).
 */
const SCENES = [
  {
    id: 'problem',
    chapter: '01 · THE PROBLEM',
    leadIn: 0.45,
    tailOut: 0.65,
    spoken:
      'AI coding agents excel inside a single prompt, yet lose architectural context across sessions. Naive memory servers dump raw notes into flat vector bags and bloat prompts with dozens of tools.',
    srt: 'AI coding agents excel inside a single prompt, yet lose architectural context across sessions. Naive memory servers dump raw notes into flat vector bags and bloat prompts with dozens of tools.',
    captionHtml:
      'AI coding agents lose architectural context across sessions — while naive memory servers dump raw notes into flat vector bags and bloat prompts with <strong>dozens of tools</strong>.',
  },
  {
    id: 'quickstart',
    chapter: '02 · 30s LOCAL INIT',
    leadIn: 0.40,
    tailOut: 0.70,
    spoken:
      'Crush Context MCP solves this locally in one command. Run npx crush-context-mcp init to initialize a zero-Docker SQLite engine on Node twenty-two and wire your IDE in seconds.',
    srt: 'krusch-context-mcp solves this locally in one command. Run npx krusch-context-mcp init to initialize a zero-Docker SQLite engine on Node 22 and wire your IDE in seconds.',
    captionHtml:
      '<code>krusch-context-mcp</code> solves this locally in one command: run <code>npx krusch-context-mcp init</code> for a zero-Docker <code>node:sqlite</code> engine on Node 22.',
  },
  {
    id: 'verbs',
    chapter: '03 · 5-VERB LOOP',
    leadIn: 0.40,
    tailOut: 0.70,
    spoken:
      'Instead of tool soup, agents operate through strictly five canonical verbs: retrieve within a token budget, remember in a closed five-type taxonomy, revise with lineage, nudge before commits, and health.',
    srt: 'Instead of tool soup, agents operate through strictly 5 canonical verbs: retrieve within a token budget, remember in a closed 5-type taxonomy, revise with lineage, nudge before commits, and health.',
    captionHtml:
      'Strictly <strong>5 canonical verbs</strong> (~350 schema tokens): <code>retrieve</code>, <code>remember</code>, <code>revise</code>, <code>nudge</code>, and <code>health</code>.',
  },
  {
    id: 'provenance',
    chapter: '04 · PROVENANCE & NUDGE',
    leadIn: 0.40,
    tailOut: 0.70,
    spoken:
      'Every rule anchors to exact code spans via SHA-256 provenance, automatically healing shifted line numbers or flagging drift, while pre-commit nudge blocks invariant regressions before git commit.',
    srt: 'Every rule anchors to exact code spans via SHA-256 provenance, automatically healing shifted line numbers or flagging drift, while pre-commit nudge blocks invariant regressions before git commit.',
    captionHtml:
      '<strong>SHA-256 span provenance</strong> auto-heals shifted line numbers or flags <code>[DRIFTED]</code> code, while <code>nudge</code> blocks regressions before <code>git commit</code>.',
  },
  {
    id: 'benchmarks',
    chapter: '05 · SOTA BENCHMARKS',
    leadIn: 0.40,
    tailOut: 0.80,
    spoken:
      'Backed by zero-dollar Raw-RAG, Porter FTS-5, and Arctic Embed Two four-way RRF, it reaches ninety-one point one seven percent on DolphinBench, ninety point two six percent on LoCoMo, and ninety-three percent ten-million-token recall on BEAM.',
    srt: 'Backed by $0.00 Raw-RAG, Porter FTS5, and snowflake-arctic-embed2 4-Way RRF, it reaches 91.17% on DolphinBench, 90.26% on LoCoMo, and 93.00% 10M-token IE recall on BEAM.',
    captionHtml:
      '<code>$0.00</code> Raw-RAG + 4-Way RRF: <strong>91.17%</strong> DolphinBench, <strong>90.26%</strong> Snap LoCoMo, and <strong>93.00%</strong> 10M-token IE recall on ICLR 2026 BEAM.',
  },
  {
    id: 'outro',
    chapter: '06 · OPEN SOURCE MIT',
    leadIn: 0.40,
    tailOut: 1.15,
    spoken:
      'Give Cursor, Claude Code, Windsurf, and Antigravity persistent, verifiable working memory today. Open source under MIT — get started with npx crush-context-mcp init.',
    srt: 'Give Cursor, Claude Code, Windsurf, and Antigravity persistent, verifiable working memory today. Open source under MIT — get started with npx krusch-context-mcp init.',
    captionHtml:
      'Give Cursor, Claude Code, Windsurf &amp; Antigravity verifiable memory today — MIT open source: <code>npx krusch-context-mcp init</code>',
  },
];

function parseCliArgs(argv) {
  const opts = {
    outMp4: path.join(ASSETS_DIR, 'krusch-context-mcp-demo.mp4'),
    outSrt: path.join(ASSETS_DIR, 'krusch-context-mcp-demo.srt'),
    cacheDir: path.join(os.tmpdir(), 'krusch-context-mcp-video-cache'),
    keyframesDir: null,
    edgeTtsBin: null,
    voice: 'en-US-AndrewMultilingualNeural',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      opts.outMp4 = path.resolve(argv[++i]);
      opts.outSrt = opts.outMp4.replace(/\.mp4$/i, '.srt');
    } else if (arg === '--cache-dir' && argv[i + 1]) {
      opts.cacheDir = path.resolve(argv[++i]);
    } else if (arg === '--keyframes-dir' && argv[i + 1]) {
      opts.keyframesDir = path.resolve(argv[++i]);
    } else if (arg === '--edge-tts-bin' && argv[i + 1]) {
      opts.edgeTtsBin = path.resolve(argv[++i]);
    } else if (arg === '--voice' && argv[i + 1]) {
      opts.voice = argv[++i];
    }
  }
  return opts;
}

/**
 * Synthesize or load cached 44.1 kHz mono PCM16 WAV for a scene.
 */
function ensureSceneVoiceWav(scene, index, opts) {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const hash = crypto
    .createHash('sha256')
    .update(`${opts.voice}::${scene.spoken}`)
    .digest('hex')
    .slice(0, 12);
  const wav44Path = path.join(
    opts.cacheDir,
    `scene_${String(index + 1).padStart(2, '0')}_${hash}_44k.wav`
  );

  if (fs.existsSync(wav44Path) && fs.statSync(wav44Path).size > 1024) {
    return wav44Path;
  }

  const rawMediaPath = path.join(opts.cacheDir, `raw_${index + 1}_${hash}.mp3`);
  const rawGeminiWav = path.join(opts.cacheDir, `raw_${index + 1}_${hash}_gem.wav`);
  let synthesizedSource = null;

  // Try Gemini TTS first if explicitly requested with a Gemini voice name
  if (/^(Charon|Fenrir|Kore|Puck|Zephyr|Aoede)$/i.test(opts.voice)) {
    try {
      execFileSync(
        'gemini-api',
        ['tts', scene.spoken, '--voice', opts.voice, '--language', 'en-US', '--out', rawGeminiWav],
        { stdio: 'pipe' }
      );
      if (fs.existsSync(rawGeminiWav) && fs.statSync(rawGeminiWav).size > 1024) {
        synthesizedSource = rawGeminiWav;
      }
    } catch {
      // Fallback to neural edge-tts below when Gemini prepayment quota is unavailable
    }
  }

  if (!synthesizedSource) {
    const edgeBin = opts.edgeTtsBin || 'edge-tts';
    const edgeVoice = /^(Charon|Fenrir|Kore|Puck|Zephyr|Aoede)$/i.test(opts.voice)
      ? 'en-US-AndrewMultilingualNeural'
      : opts.voice;
    execFileSync(
      edgeBin,
      [
        '--voice',
        edgeVoice,
        '--rate=+3%',
        '--pitch=-2Hz',
        '--text',
        scene.spoken,
        '--write-media',
        rawMediaPath,
      ],
      { stdio: 'inherit' }
    );
    synthesizedSource = rawMediaPath;
  }

  // Convert to canonical 44.1 kHz mono PCM16 WAV and trim leading/trailing digital silence gently
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      synthesizedSource,
      '-af',
      'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_silence=0.08:start_threshold=-48dB,areverse',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav44Path,
    ],
    { stdio: 'inherit' }
  );

  return wav44Path;
}

/**
 * Extract normalized mono float samples (`[-1, 1]`) from a 16-bit PCM WAV file
 * validated by @krusch/toolkit/audio `parseWavHeader`.
 */
function readMonoFloatSamples(wavPath) {
  const bytes = new Uint8Array(fs.readFileSync(wavPath));
  const parsed = parseWavHeader(bytes, { tool: 'promo.wav' });
  if (!parsed.ok) {
    throw new Error(`Failed to parse WAV ${wavPath}: ${parsed.error.message}`);
  }
  const { sampleRate, channels, bitsPerSample, dataOffset, dataBytes } = parsed.data;
  if (sampleRate !== SAMPLE_RATE || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `Unexpected WAV format in ${wavPath}: ${sampleRate}Hz ch=${channels} bits=${bitsPerSample}`
    );
  }
  const sampleCount = Math.floor(dataBytes / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  let peak = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const v = view.getInt16(i * 2, true) / 32768;
    out[i] = v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  // Normalize each voice clip consistently to -1.3 dBFS (~0.86)
  if (peak > 0.01) {
    const scale = 0.86 / peak;
    for (let i = 0; i < sampleCount; i += 1) {
      out[i] = Math.max(-0.98, Math.min(0.98, out[i] * scale));
    }
  }
  return out;
}

/**
 * Build timeline, master stereo WAV (voiceover + sidechain-ducked cyber-ambient synth bed),
 * 30fps voice visualizer envelope, and `.srt` subtitle file.
 */
function buildTimelineAndMasterAudio(scenesWithSamples, masterWavPath, srtPath) {
  let cursorFrames = 0;
  const timeline = [];

  for (let i = 0; i < scenesWithSamples.length; i += 1) {
    const s = scenesWithSamples[i];
    const speechSeconds = s.samples.length / SAMPLE_RATE;
    const rawTotalSeconds = s.leadIn + speechSeconds + s.tailOut;
    const sceneFrames = Math.ceil(rawTotalSeconds * FPS);
    const startFrame = cursorFrames;
    const endFrame = startFrame + sceneFrames;
    const startSec = startFrame / FPS;
    const endSec = endFrame / FPS;
    const speechStartSec = startSec + s.leadIn;
    const speechEndSec = speechStartSec + speechSeconds;

    timeline.push({
      index: i,
      id: s.id,
      chapter: s.chapter,
      srt: s.srt,
      captionHtml: s.captionHtml,
      startFrame,
      endFrame,
      sceneFrames,
      startSec,
      endSec,
      durationSec: sceneFrames / FPS,
      speechStartSec,
      speechEndSec,
      samples: s.samples,
    });
    cursorFrames = endFrame;
  }

  const totalFrames = cursorFrames;
  const totalSeconds = totalFrames / FPS;
  const totalSamples = Math.ceil(totalSeconds * SAMPLE_RATE);

  // 1. Place voice samples at exact sample offsets
  const voiceTrack = new Float32Array(totalSamples);
  for (const item of timeline) {
    const offset = Math.round(item.speechStartSec * SAMPLE_RATE);
    const maxCopy = Math.min(item.samples.length, totalSamples - offset);
    for (let j = 0; j < maxCopy; j += 1) {
      voiceTrack[offset + j] += item.samples[j];
    }
  }

  // 2. Compute smooth sidechain envelope for ducking + 30fps HUD equalizer bars
  const voiceEnv = new Float32Array(totalSamples);
  let env = 0;
  const attack = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.015));
  const release = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.22));
  for (let i = 0; i < totalSamples; i += 1) {
    const absV = Math.abs(voiceTrack[i]);
    env += (absV - env) * (absV > env ? attack : release);
    voiceEnv[i] = env;
  }

  const frameVoiceLevels = new Array(totalFrames).fill(0);
  const samplesPerFrame = SAMPLE_RATE / FPS;
  for (let f = 0; f < totalFrames; f += 1) {
    const s0 = Math.floor(f * samplesPerFrame);
    const s1 = Math.min(totalSamples, Math.floor((f + 1) * samplesPerFrame));
    let sumSq = 0;
    for (let k = s0; k < s1; k += 1) {
      sumSq += voiceTrack[k] * voiceTrack[k];
    }
    const rms = s1 > s0 ? Math.sqrt(sumSq / (s1 - s0)) : 0;
    frameVoiceLevels[f] = Number(Math.min(1, rms * 3.8).toFixed(4));
  }

  // 3. Synthesize warm low-passed dark-cyber stereo ambient pad (D2-A2-D3-E3-F3-A3)
  //    + soft harmonic shimmer chime on each scene transition
  const stereo = new Float32Array(totalSamples * 2);
  const padVoices = [
    { freq: 73.416, amp: 0.30, pan: 0.0, lfoHz: 0.07, phase: 0.1 }, // D2 sub
    { freq: 110.0, amp: 0.22, pan: -0.35, lfoHz: 0.11, phase: 1.2 }, // A2
    { freq: 110.28, amp: 0.22, pan: 0.35, lfoHz: 0.09, phase: 2.4 }, // A2 detuned
    { freq: 146.832, amp: 0.18, pan: -0.5, lfoHz: 0.13, phase: 0.7 }, // D3
    { freq: 164.814, amp: 0.14, pan: 0.48, lfoHz: 0.08, phase: 3.1 }, // E3 (9th)
    { freq: 220.0, amp: 0.11, pan: -0.25, lfoHz: 0.06, phase: 4.0 }, // A3
    { freq: 261.626, amp: 0.07, pan: 0.28, lfoHz: 0.05, phase: 5.1 }, // C4 subtle minor7
  ];

  const transitionTimes = timeline.map((t) => t.startSec);
  let lpL = 0;
  let lpR = 0;
  const lpAlpha = 0.085; // ~650 Hz warm low-pass filter so vocals stay crystal clear

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    let rawL = 0;
    let rawR = 0;

    for (let v = 0; v < padVoices.length; v += 1) {
      const pv = padVoices[v];
      const mod = 1 + 0.22 * Math.sin(2 * Math.PI * pv.lfoHz * t + pv.phase);
      // Warm sine + soft 2nd harmonic
      const sig =
        (Math.sin(2 * Math.PI * pv.freq * t + pv.phase) +
          0.18 * Math.sin(4 * Math.PI * pv.freq * t)) *
        pv.amp *
        mod;
      const gainL = Math.sqrt(0.5 * (1 - pv.pan));
      const gainR = Math.sqrt(0.5 * (1 + pv.pan));
      rawL += sig * gainL;
      rawR += sig * gainR;
    }

    lpL += lpAlpha * (rawL - lpL);
    lpR += lpAlpha * (rawR - lpR);

    // Subtle glassy harmonic pulse at scene boundaries (inside speech gap)
    let chimeL = 0;
    let chimeR = 0;
    for (let c = 0; c < transitionTimes.length; c += 1) {
      const dt = t - transitionTimes[c];
      if (dt >= 0 && dt < 1.35) {
        const envChime = Math.sin(Math.min(1, dt / 0.03) * (Math.PI / 2)) * Math.exp(-dt * 3.4);
        const fBase = c % 2 === 0 ? 587.33 : 659.25; // D5 / E5 gentle glass pulse
        chimeL += Math.sin(2 * Math.PI * fBase * dt) * 0.042 * envChime;
        chimeR += Math.sin(2 * Math.PI * (fBase * 1.5) * dt) * 0.032 * envChime;
      }
    }

    // Master fade-in (0.9s) and fade-out (1.5s)
    const fadeIn = Math.min(1, t / 0.9);
    const fadeOut = Math.min(1, (totalSeconds - t) / 1.5);
    const masterFade = Math.max(0, fadeIn * fadeOut);

    // Sidechain ducking: ambient pad sits at ~0.105 during silence and ducks to ~0.048 under voice
    const duck = 1 - Math.min(0.56, voiceEnv[i] * 2.4);
    const ambGain = 0.115 * duck * masterFade;

    const vSample = voiceTrack[i] * 0.92;
    const mixL = Math.max(-0.99, Math.min(0.99, vSample + lpL * ambGain + chimeL * masterFade));
    const mixR = Math.max(-0.99, Math.min(0.99, vSample + lpR * ambGain + chimeR * masterFade));

    stereo[i * 2] = mixL;
    stereo[i * 2 + 1] = mixR;
  }

  const wavBytes = encodeWavPcm16(stereo, { sampleRate: SAMPLE_RATE, channels: 2 });
  fs.writeFileSync(masterWavPath, wavBytes);

  // 4. Emit standard SubRip (.srt) file
  const formatSrtTime = (sec) => {
    const msTotal = Math.max(0, Math.round(sec * 1000));
    const hrs = Math.floor(msTotal / 3_600_000);
    const mins = Math.floor((msTotal % 3_600_000) / 60_000);
    const secs = Math.floor((msTotal % 60_000) / 1000);
    const ms = msTotal % 1000;
    return (
      `${String(hrs).padStart(2, '0')}:` +
      `${String(mins).padStart(2, '0')}:` +
      `${String(secs).padStart(2, '0')},` +
      `${String(ms).padStart(3, '0')}`
    );
  };

  const srtBlocks = timeline.map(
    (item, idx) =>
      `${idx + 1}\n${formatSrtTime(item.speechStartSec)} --> ${formatSrtTime(item.speechEndSec + 0.2)}\n${item.srt}\n`
  );
  fs.writeFileSync(srtPath, srtBlocks.join('\n'), 'utf8');

  return { timeline, totalFrames, totalSeconds, frameVoiceLevels };
}

/**
 * Self-contained 1920x1080 deterministic HTML5 renderer driven by `window.renderFrame(frameIdx)`.
 */
function buildStageHtml(timelineMeta, totalFrames, frameVoiceLevels) {
  const payloadJson = JSON.stringify({
    fps: FPS,
    totalFrames,
    scenes: timelineMeta.map((s) => ({
      index: s.index,
      id: s.id,
      chapter: s.chapter,
      captionHtml: s.captionHtml,
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      sceneFrames: s.sceneFrames,
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: s.durationSec,
    })),
    voiceLevels: frameVoiceLevels,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>krusch-context-mcp Launch Walkthrough</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=Outfit:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #050810;
    color: #F4F7FB;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  .viewport {
    position: relative;
    width: 1920px;
    height: 1080px;
    padding: 34px 56px 28px 56px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background:
      radial-gradient(960px 520px at var(--orb1-x, 16%) var(--orb1-y, 14%), rgba(0, 229, 255, 0.15), transparent 68%),
      radial-gradient(920px 540px at var(--orb2-x, 86%) var(--orb2-y, 20%), rgba(139, 110, 255, 0.16), transparent 70%),
      radial-gradient(1080px 460px at 50% 96%, rgba(0, 245, 212, 0.095), transparent 72%),
      linear-gradient(180deg, #070B14 0%, #090D18 54%, #050810 100%);
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, rgba(95, 135, 185, 0.07) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(95, 135, 185, 0.07) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse 92% 86% at 50% 48%, #000 58%, transparent 100%);
    pointer-events: none;
  }

  .hud-frame {
    position: absolute;
    inset: 18px;
    border-radius: 24px;
    border: 1px solid rgba(120, 165, 220, 0.16);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    pointer-events: none;
  }

  /* Top HUD Bar */
  .top-hud {
    position: relative;
    z-index: 10;
    height: 54px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }

  .brand-cluster {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px 8px 12px;
    background: rgba(13, 20, 35, 0.90);
    border: 1px solid rgba(55, 225, 255, 0.34);
    border-radius: 999px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }

  .brand-name {
    font-family: 'Outfit', sans-serif;
    font-weight: 800;
    font-size: 16px;
    letter-spacing: 0.08em;
    color: #FFFFFF;
  }
  .brand-name span { color: #37E1FF; }

  .repo-pill {
    font-family: 'Fira Code', monospace;
    font-size: 14px;
    font-weight: 500;
    color: #B4C5DD;
    padding: 7px 14px;
    background: rgba(15, 23, 40, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.20);
    border-radius: 9px;
  }

  .chapter-rail {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(11, 17, 30, 0.84);
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 999px;
  }

  .chap-pill {
    font-family: 'Fira Code', monospace;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 999px;
    color: #6E819D;
    transition: none;
  }

  .chap-pill.active {
    color: #06101C;
    background: linear-gradient(90deg, #52F3FF 0%, #37E1FF 60%, #8CE7FF 100%);
    box-shadow: 0 0 16px rgba(55, 225, 255, 0.35);
    font-weight: 700;
  }

  .chap-pill.done {
    color: #98ECFF;
    background: rgba(55, 225, 255, 0.10);
  }

  .telemetry-cluster {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .live-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-radius: 999px;
    background: rgba(0, 230, 118, 0.11);
    border: 1px solid rgba(0, 230, 118, 0.42);
    color: #52FFA3;
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 600;
  }

  .dot-live {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #00E676;
    box-shadow: 0 0 10px #00E676;
  }

  .eq-box {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(13, 20, 35, 0.88);
    border: 1px solid rgba(139, 110, 255, 0.32);
  }

  .eq-bar {
    width: 3px;
    height: 6px;
    border-radius: 2px;
    background: linear-gradient(180deg, #52F3FF 0%, #8B6EFF 100%);
  }

  /* Main Stage Area */
  .stage {
    position: relative;
    z-index: 5;
    width: 100%;
    height: 816px;
    margin: 14px 0 12px 0;
  }

  .scene {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
  }

  .scene-eyebrow {
    font-family: 'Fira Code', monospace;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: #52F3FF;
    margin-bottom: 10px;
  }

  .scene-h1 {
    font-family: 'Outfit', sans-serif;
    font-weight: 900;
    font-size: 56px;
    line-height: 1.06;
    letter-spacing: -0.025em;
    color: #FFFFFF;
    margin-bottom: 14px;
  }

  .grad-text {
    background: linear-gradient(92deg, #52F3FF 0%, #25D9FF 48%, #A585FF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .scene-lead {
    font-size: 22px;
    color: #B6C5DC;
    font-weight: 500;
    margin-bottom: 30px;
    max-width: 1460px;
  }

  .scene-lead strong { color: #FFFFFF; font-weight: 600; }

  /* Scene 1: Problem vs Solution Split */
  .vs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    height: 530px;
  }

  .panel-card {
    position: relative;
    border-radius: 22px;
    padding: 34px 38px;
    background: linear-gradient(165deg, rgba(16, 24, 42, 0.94) 0%, rgba(9, 14, 26, 0.97) 100%);
    box-shadow: 0 22px 50px rgba(0, 0, 0, 0.50), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }

  .panel-bad {
    border: 1px solid rgba(255, 82, 119, 0.40);
  }
  .panel-bad::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, #FF5277 0%, #FF8A65 100%);
  }

  .panel-good {
    border: 1px solid rgba(0, 229, 255, 0.48);
  }
  .panel-good::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, #00F5D4 0%, #37E1FF 52%, #8B6EFF 100%);
  }

  .panel-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
  }

  .panel-title {
    font-family: 'Outfit', sans-serif;
    font-size: 30px;
    font-weight: 800;
    color: #FFFFFF;
  }

  .badge-red {
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
    border-radius: 8px;
    background: rgba(255, 82, 119, 0.16);
    border: 1px solid rgba(255, 82, 119, 0.45);
    color: #FF859E;
  }

  .badge-cyan {
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
    border-radius: 8px;
    background: rgba(0, 245, 212, 0.14);
    border: 1px solid rgba(0, 245, 212, 0.45);
    color: #52FFD8;
  }

  .feature-rows {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .f-row {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 15px 18px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.028);
    border: 1px solid rgba(148, 163, 184, 0.12);
  }

  .f-icon {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Fira Code', monospace;
    font-weight: 700;
    font-size: 16px;
    flex-shrink: 0;
  }

  .f-icon-bad { background: rgba(255, 82, 119, 0.18); color: #FF6E8E; }
  .f-icon-good { background: rgba(0, 245, 212, 0.18); color: #4DFFBE; }

  .f-text-title {
    font-size: 19px;
    font-weight: 700;
    color: #F2F7FF;
    margin-bottom: 3px;
  }

  .f-text-sub {
    font-size: 15.5px;
    color: #9EB0C9;
  }

  /* Scene 2: Quickstart Terminal + IDE Config */
  .init-grid {
    display: grid;
    grid-template-columns: 1.32fr 0.95fr;
    gap: 28px;
    height: 556px;
  }

  .term-window {
    border-radius: 20px;
    background: #070B13;
    border: 1px solid rgba(55, 225, 255, 0.34);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.07);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .term-bar {
    height: 48px;
    padding: 0 20px;
    background: rgba(18, 27, 46, 0.92);
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .term-dots { display: flex; gap: 8px; }
  .tdot { width: 12px; height: 12px; border-radius: 50%; }
  .td-r { background: #FF5F56; }
  .td-y { background: #FFBD2E; }
  .td-g { background: #27C93F; }

  .term-title {
    font-family: 'Fira Code', monospace;
    font-size: 13.5px;
    color: #93A8C6;
  }

  .term-body {
    padding: 28px 32px;
    font-family: 'Fira Code', monospace;
    font-size: 18px;
    line-height: 1.72;
    color: #E2ECF9;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .cmd-line {
    font-size: 23px;
    font-weight: 700;
    color: #FFFFFF;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .prompt-sym { color: #00F5D4; }
  .cursor-block {
    display: inline-block;
    width: 12px;
    height: 25px;
    background: #37E1FF;
    vertical-align: middle;
    margin-left: 2px;
  }

  .step-line {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 17px;
    color: #C7D6EC;
    padding: 7px 12px;
    border-radius: 9px;
    background: rgba(55, 225, 255, 0.045);
  }
  .ok-check { color: #4DFF9E; font-weight: 700; }
  .hi-cyan { color: #67F0FF; font-weight: 600; }
  .hi-violet { color: #C5ADFF; font-weight: 600; }

  .ide-stack {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .code-card {
    flex: 1;
    border-radius: 20px;
    padding: 24px 28px;
    background: linear-gradient(165deg, rgba(15, 23, 41, 0.94) 0%, rgba(9, 14, 26, 0.98) 100%);
    border: 1px solid rgba(139, 110, 255, 0.38);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .code-pre {
    font-family: 'Fira Code', monospace;
    font-size: 16.5px;
    line-height: 1.58;
    color: #DCE7F7;
    background: rgba(5, 8, 16, 0.72);
    padding: 18px 20px;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.14);
  }

  .ide-badges-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .ide-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-radius: 12px;
    background: rgba(16, 25, 44, 0.90);
    border: 1px solid rgba(0, 245, 212, 0.30);
    font-weight: 700;
    font-size: 16.5px;
    color: #F4F8FF;
  }
  .ide-status {
    font-family: 'Fira Code', monospace;
    font-size: 12px;
    color: #4DFF9E;
  }

  /* Scene 3: 5 Canonical Verbs */
  .verbs-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 18px;
    height: 520px;
  }

  .verb-card {
    position: relative;
    border-radius: 20px;
    padding: 26px 22px;
    background: linear-gradient(170deg, rgba(15, 23, 40, 0.92) 0%, rgba(8, 13, 24, 0.96) 100%);
    border: 1px solid rgba(148, 163, 184, 0.22);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }

  .verb-card.lit {
    border-color: rgba(55, 225, 255, 0.72);
    box-shadow: 0 18px 44px rgba(0, 229, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.12);
    background: linear-gradient(170deg, rgba(19, 33, 58, 0.96) 0%, rgba(10, 17, 32, 0.98) 100%);
  }

  .verb-card.lit::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, #00F5D4 0%, #37E1FF 50%, #8B6EFF 100%);
  }

  .verb-num {
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #67F0FF;
    letter-spacing: 0.06em;
  }

  .verb-name {
    font-family: 'Outfit', sans-serif;
    font-size: 34px;
    font-weight: 900;
    color: #FFFFFF;
    margin: 10px 0 6px 0;
  }

  .verb-full {
    font-family: 'Fira Code', monospace;
    font-size: 12.5px;
    color: #8BA0BE;
    margin-bottom: 16px;
  }

  .verb-desc {
    font-size: 16.5px;
    line-height: 1.48;
    color: #C4D3E8;
  }

  .verb-spec {
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    line-height: 1.5;
    padding: 12px 13px;
    border-radius: 11px;
    background: rgba(5, 9, 17, 0.78);
    border: 1px solid rgba(55, 225, 255, 0.20);
    color: #8CEEFF;
  }

  /* Scene 4: Span-Grounded Provenance & Pre-Commit Nudge */
  .prov-grid {
    display: grid;
    grid-template-columns: 1.05fr 0.95fr;
    gap: 28px;
    height: 540px;
  }

  .editor-card {
    border-radius: 20px;
    padding: 26px 30px;
    background: linear-gradient(165deg, rgba(14, 21, 38, 0.95) 0%, rgba(8, 12, 22, 0.98) 100%);
    border: 1px solid rgba(55, 225, 255, 0.36);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .code-lines {
    font-family: 'Fira Code', monospace;
    font-size: 15.5px;
    line-height: 1.68;
    background: #050811;
    border-radius: 14px;
    padding: 18px 20px;
    border: 1px solid rgba(148, 163, 184, 0.16);
  }

  .cl-row {
    display: flex;
    gap: 16px;
    padding: 3px 10px;
    border-radius: 6px;
  }
  .cl-num { color: #5B6F8E; width: 38px; text-align: right; user-select: none; }
  .cl-anchored {
    background: rgba(0, 245, 212, 0.11);
    border-left: 3px solid #00F5D4;
  }
  .cl-drifted {
    background: rgba(249, 181, 32, 0.13);
    border-left: 3px solid #F9B520;
  }

  .anchor-status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-radius: 12px;
    font-family: 'Fira Code', monospace;
    font-size: 14px;
    font-weight: 600;
  }

  .status-healed {
    background: rgba(0, 230, 118, 0.12);
    border: 1px solid rgba(0, 230, 118, 0.45);
    color: #52FFA3;
  }

  .status-drift {
    background: rgba(249, 181, 32, 0.14);
    border: 1px solid rgba(249, 181, 32, 0.50);
    color: #FFD466;
  }

  .nudge-box {
    padding: 20px 22px;
    border-radius: 14px;
    background: rgba(255, 82, 119, 0.09);
    border: 1px solid rgba(255, 82, 119, 0.42);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Scene 5: 3 Benchmark Scorecards (1080p Hero Upgrade) */
  .bench-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 26px;
    height: 540px;
  }

  .bcard {
    position: relative;
    border-radius: 22px;
    padding: 30px 32px 26px 32px;
    background: linear-gradient(165deg, rgba(16, 24, 42, 0.94) 0%, rgba(9, 14, 26, 0.98) 100%);
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.52), inset 0 1px 0 rgba(255, 255, 255, 0.07);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .bcard::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 4px;
  }
  .bcard-gold { border: 1px solid rgba(249, 181, 32, 0.44); }
  .bcard-gold::before { background: linear-gradient(90deg, #F9B520 0%, #FFE07D 50%, #00E5FF 100%); }
  .bcard-cyan { border: 1px solid rgba(0, 229, 255, 0.46); }
  .bcard-cyan::before { background: linear-gradient(90deg, #00F5D4 0%, #00E5FF 55%, #6EA8FE 100%); }
  .bcard-violet { border: 1px solid rgba(157, 123, 255, 0.46); }
  .bcard-violet::before { background: linear-gradient(90deg, #8B6EFF 0%, #C084FC 55%, #37E1FF 100%); }

  .b-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .b-name {
    font-family: 'Outfit', sans-serif;
    font-weight: 800;
    font-size: 22px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #ECF3FC;
  }
  .b-tag {
    font-family: 'Fira Code', monospace;
    font-size: 12.5px;
    font-weight: 700;
    padding: 5px 10px;
    border-radius: 7px;
  }
  .b-tag-gold { background: rgba(249, 181, 32, 0.16); border: 1px solid rgba(249, 181, 32, 0.5); color: #FFD15C; }
  .b-tag-cyan { background: rgba(0, 229, 255, 0.14); border: 1px solid rgba(0, 229, 255, 0.46); color: #5CEEFF; }
  .b-tag-violet { background: rgba(157, 123, 255, 0.16); border: 1px solid rgba(157, 123, 255, 0.48); color: #D2BAFF; }

  .b-scope {
    font-family: 'Fira Code', monospace;
    font-size: 14px;
    color: #8CA0BE;
    margin-top: 6px;
  }

  .b-score-row {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin: 22px 0 16px 0;
  }

  .b-big {
    font-family: 'Outfit', sans-serif;
    font-weight: 900;
    font-size: 78px;
    line-height: 0.96;
    letter-spacing: -0.03em;
  }
  .c-gold { color: #FFF8E7; text-shadow: 0 0 34px rgba(249, 181, 32, 0.28); }
  .c-cyan { color: #ECFEFF; text-shadow: 0 0 34px rgba(0, 229, 255, 0.28); }
  .c-violet { color: #F5F0FF; text-shadow: 0 0 34px rgba(139, 110, 255, 0.30); }

  .b-unit { display: flex; flex-direction: column; gap: 4px; }
  .b-frac { font-family: 'Fira Code', monospace; font-size: 16px; font-weight: 700; color: #E5EEF9; }
  .b-sub { font-size: 14px; font-weight: 600; color: #96AAC7; }

  .b-meter {
    width: 100%;
    height: 9px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.15);
    overflow: hidden;
  }
  .b-fill { height: 100%; border-radius: 999px; width: 0%; }
  .bf-gold { background: linear-gradient(90deg, #F9B520 0%, #FFE07D 65%, #00E5FF 100%); }
  .bf-cyan { background: linear-gradient(90deg, #00F5D4 0%, #00E5FF 70%, #6EA8FE 100%); }
  .bf-violet { background: linear-gradient(90deg, #8B6EFF 0%, #C084FC 70%, #37E1FF 100%); }

  .b-metrics {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 20px;
    border-top: 1px solid rgba(148, 163, 184, 0.18);
  }
  .bm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 15.5px;
    color: #B8C7DC;
  }
  .bm-val {
    font-family: 'Fira Code', monospace;
    font-weight: 600;
    font-size: 15px;
    color: #F4F8FF;
  }

  /* Scene 6: Outro CTA */
  .outro-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 24px;
    height: 100%;
  }

  .emblem-ring {
    width: 118px;
    height: 118px;
    border-radius: 30px;
    background: radial-gradient(circle at 30% 25%, rgba(55, 225, 255, 0.24), rgba(13, 20, 36, 0.95));
    border: 1px solid rgba(55, 225, 255, 0.48);
    box-shadow: 0 0 60px rgba(55, 225, 255, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.14);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .outro-title {
    font-family: 'Outfit', sans-serif;
    font-weight: 900;
    font-size: 76px;
    letter-spacing: -0.025em;
    color: #FFFFFF;
  }

  .cta-command-box {
    display: inline-flex;
    align-items: center;
    gap: 20px;
    padding: 22px 42px;
    border-radius: 18px;
    background: linear-gradient(90deg, rgba(16, 28, 52, 0.96) 0%, rgba(24, 21, 52, 0.96) 100%);
    border: 2px solid rgba(55, 225, 255, 0.58);
    box-shadow: 0 20px 60px rgba(0, 229, 255, 0.22);
    font-family: 'Fira Code', monospace;
    font-size: 32px;
    font-weight: 700;
    color: #FFFFFF;
    margin-top: 8px;
  }

  .outro-links {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-top: 12px;
  }

  .outro-pill {
    font-family: 'Fira Code', monospace;
    font-size: 16px;
    font-weight: 600;
    padding: 10px 20px;
    border-radius: 999px;
    background: rgba(15, 23, 40, 0.88);
    border: 1px solid rgba(148, 163, 184, 0.28);
    color: #D6E3F6;
  }

  /* Bottom Subtitle & Master Timeline Bar */
  .bottom-hud {
    position: relative;
    z-index: 10;
    height: 86px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
  }

  .subtitle-pill {
    max-width: 1660px;
    padding: 13px 30px;
    border-radius: 14px;
    background: rgba(7, 11, 21, 0.92);
    border: 1px solid rgba(82, 243, 255, 0.26);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    font-size: 21.5px;
    font-weight: 500;
    line-height: 1.35;
    color: #EEF5FF;
    text-align: center;
  }

  .subtitle-pill strong { color: #52F3FF; font-weight: 700; }
  .subtitle-pill code {
    font-family: 'Fira Code', monospace;
    font-size: 19.5px;
    font-weight: 600;
    color: #7CF5FF;
    background: rgba(55, 225, 255, 0.12);
    padding: 2px 8px;
    border-radius: 6px;
  }

  .timeline-track {
    width: 100%;
    height: 5px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.16);
    overflow: hidden;
  }

  .timeline-fill {
    height: 100%;
    width: 0%;
    border-radius: 999px;
    background: linear-gradient(90deg, #00F5D4 0%, #37E1FF 50%, #8B6EFF 100%);
  }
</style>
</head>
<body>
<div class="viewport" id="viewport">
  <div class="grid-overlay"></div>
  <div class="hud-frame"></div>

  <!-- Persistent Top HUD -->
  <div class="top-hud">
    <div class="brand-cluster">
      <div class="brand-badge">
        <svg viewBox="0 -2 132 218" width="14" height="23" aria-hidden="true">
          <defs>
            <linearGradient id="boltGrad" x1="78%" y1="4%" x2="18%" y2="96%">
              <stop offset="0%" stop-color="#6ff1fe"/>
              <stop offset="35%" stop-color="#37e1ff"/>
              <stop offset="75%" stop-color="#8b6eff"/>
              <stop offset="100%" stop-color="#d946ef"/>
            </linearGradient>
          </defs>
          <polygon points="121,2 79,25 93,28 48,50 78,53 19,89 58,85 5,128 44,124 5,158 34,155 4,212 47,191 35,186 70,171 52,168 105,139 66,140 123,103 74,105 128,69 86,69 126,35 102,36"
            fill="url(#boltGrad)" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" />
        </svg>
        <span class="brand-name">KRUSCH<span>.DEV</span></span>
      </div>
      <span class="repo-pill">github.com/kruschdev/krusch-context-mcp · v2.0</span>
    </div>

    <div class="chapter-rail" id="chapterRail">
      <span class="chap-pill">01 PROBLEM</span>
      <span class="chap-pill">02 INIT</span>
      <span class="chap-pill">03 5 VERBS</span>
      <span class="chap-pill">04 PROVENANCE</span>
      <span class="chap-pill">05 BENCHMARKS</span>
      <span class="chap-pill">06 INSTALL</span>
    </div>

    <div class="telemetry-cluster">
      <div class="live-pill">
        <span class="dot-live"></span>
        <span>$0.00 ZERO-LLM INGEST</span>
      </div>
      <div class="eq-box" id="eqBox">
        ${Array.from({ length: 14 })
          .map(() => '<div class="eq-bar"></div>')
          .join('')}
      </div>
    </div>
  </div>

  <!-- 6-Scene Stage -->
  <div class="stage">

    <!-- SCENE 0: THE PROBLEM -->
    <div class="scene" id="scene-0">
      <div class="scene-eyebrow">CROSS-SESSION AMNESIA &amp; PROMPT POLLUTION</div>
      <h1 class="scene-h1">Stop Feeding Coding Agents a <span class="grad-text">Flat Bag of Notes</span></h1>
      <p class="scene-lead">Most memory servers dump unconstrained strings into vector stores and expose dozens of overlapping tools.</p>

      <div class="vs-grid">
        <div class="panel-card panel-bad" id="s0-bad">
          <div>
            <div class="panel-title-row">
              <span class="panel-title">Naive Memory MCP Servers</span>
              <span class="badge-red">MEMORY ROT</span>
            </div>
            <div class="feature-rows">
              <div class="f-row">
                <div class="f-icon f-icon-bad">✕</div>
                <div>
                  <div class="f-text-title">Tool Soup (15–60+ Exposed Tools)</div>
                  <div class="f-text-sub">Burns 3,500+ schema tokens every turn &amp; triggers parameter hallucinations</div>
                </div>
              </div>
              <div class="f-row">
                <div class="f-icon f-icon-bad">✕</div>
                <div>
                  <div class="f-text-title">Unstructured Vector Note Dumps</div>
                  <div class="f-text-sub">Stale two-month-old notes contradict current production architecture</div>
                </div>
              </div>
              <div class="f-row">
                <div class="f-icon f-icon-bad">✕</div>
                <div>
                  <div class="f-text-title">Zero Code Provenance or Diff Guards</div>
                  <div class="f-text-sub">Diagnosed bugs silently return as zombie regressions three sessions later</div>
                </div>
              </div>
            </div>
          </div>
          <div style="font-family:'Fira Code',monospace;font-size:14px;color:#FF859E;">Requires Docker / External Cloud Vector DB</div>
        </div>

        <div class="panel-card panel-good" id="s0-good">
          <div>
            <div class="panel-title-row">
              <span class="panel-title">krusch-context-mcp v2.0</span>
              <span class="badge-cyan">GOVERNED LIFECYCLE</span>
            </div>
            <div class="feature-rows">
              <div class="f-row">
                <div class="f-icon f-icon-good">✓</div>
                <div>
                  <div class="f-text-title">Strictly 5 Canonical Verbs (~350 Schema Tokens)</div>
                  <div class="f-text-sub">10× smaller prompt footprint with near-100% agent tool-selection precision</div>
                </div>
              </div>
              <div class="f-row">
                <div class="f-icon f-icon-good">✓</div>
                <div>
                  <div class="f-text-title">Closed Taxonomy + Temporal Lineage</div>
                  <div class="f-text-sub">Near-duplicate detection (cos ≥ 0.85), supersede chains &amp; mandatory invalidation reasons</div>
                </div>
              </div>
              <div class="f-row">
                <div class="f-icon f-icon-good">✓</div>
                <div>
                  <div class="f-text-title">SHA-256 Span Self-Healing &amp; Pre-Commit Nudge</div>
                  <div class="f-text-sub">Built-in Node 22 node:sqlite + Porter FTS5 + 1024d Float32Array blobs</div>
                </div>
              </div>
            </div>
          </div>
          <div style="font-family:'Fira Code',monospace;font-size:14px;color:#52FFD8;">100% Local · Zero Docker · Zero Native Compilation</div>
        </div>
      </div>
    </div>

    <!-- SCENE 1: 30-SECOND LOCAL QUICKSTART -->
    <div class="scene" id="scene-1">
      <div class="scene-eyebrow">ZERO DOCKER · BUILT-IN NODE 22 SQLITE</div>
      <h1 class="scene-h1">One Command to <span class="grad-text">Persistent Working Memory</span></h1>
      <p class="scene-lead">Initializes <strong>.agent/context.db</strong>, seeds steering rules, and outputs ready-to-use IDE configs in under 5 seconds.</p>

      <div class="init-grid">
        <div class="term-window">
          <div class="term-bar">
            <div class="term-dots">
              <span class="tdot td-r"></span><span class="tdot td-y"></span><span class="tdot td-g"></span>
            </div>
            <span class="term-title">zsh — ~/workspace/my-service</span>
            <span style="font-family:'Fira Code',monospace;font-size:12px;color:#52FFA3;">NODE ≥ 22.0.0</span>
          </div>
          <div class="term-body">
            <div class="cmd-line">
              <span class="prompt-sym">$</span>
              <span id="typedCmd"></span><span class="cursor-block" id="termCursor"></span>
            </div>
            <div class="step-line" id="init-step-0">
              <span class="ok-check">✔</span>
              <span>Validated <span class="hi-cyan">Node.js v22.23+</span> built-in <span class="hi-violet">node:sqlite</span> WAL engine</span>
            </div>
            <div class="step-line" id="init-step-1">
              <span class="ok-check">✔</span>
              <span>Initialized <span class="hi-cyan">.agent/context.db</span> (4 KB Float32Array + Porter FTS5)</span>
            </div>
            <div class="step-line" id="init-step-2">
              <span class="ok-check">✔</span>
              <span>Cleared stale IDE MCP tool schema caches</span>
            </div>
            <div class="step-line" id="init-step-3">
              <span class="ok-check">✔</span>
              <span>Installed <span class="hi-cyan">AGENTS.md</span> Turn-1 hydration &amp; pre-commit protocol</span>
            </div>
            <div class="step-line" id="init-step-4" style="border:1px solid rgba(77,255,158,0.35);background:rgba(0,230,118,0.09);">
              <span class="ok-check">⚡</span>
              <span style="color:#FFFFFF;font-weight:600;">Ready in 1.4s — Offline FTS5 + Optional Ollama Arctic-Embed2 (1024d)</span>
            </div>
          </div>
        </div>

        <div class="ide-stack">
          <div class="code-card" id="ideConfigCard">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <span style="font-family:'Outfit',sans-serif;font-weight:800;font-size:22px;">MCP Host Configuration</span>
              <span class="badge-cyan">.cursor/mcp.json</span>
            </div>
            <pre class="code-pre">{
  <span style="color:#7CF5FF;">"mcpServers"</span>: {
    <span style="color:#7CF5FF;">"krusch-context"</span>: {
      <span style="color:#C5ADFF;">"command"</span>: <span style="color:#52FFA3;">"npx"</span>,
      <span style="color:#C5ADFF;">"args"</span>: [<span style="color:#52FFA3;">"-y"</span>, <span style="color:#52FFA3;">"krusch-context-mcp"</span>]
    }
  }
}</pre>
            <div style="font-family:'Fira Code',monospace;font-size:14px;color:#A8BBE0;margin-top:12px;">
              <span style="color:#00F5D4;">$</span> claude mcp add krusch-context -- npx -y krusch-context-mcp
            </div>
          </div>

          <div class="ide-badges-grid" id="ideBadges">
            <div class="ide-chip"><span>Cursor</span><span class="ide-status">● READY</span></div>
            <div class="ide-chip"><span>Claude Code</span><span class="ide-status">● READY</span></div>
            <div class="ide-chip"><span>Windsurf</span><span class="ide-status">● READY</span></div>
            <div class="ide-chip"><span>Antigravity</span><span class="ide-status">● READY</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- SCENE 2: THE 5-VERB LOOP -->
    <div class="scene" id="scene-2">
      <div class="scene-eyebrow">RADICAL ERGONOMIC SURFACE · ~350 SCHEMA TOKENS</div>
      <h1 class="scene-h1">The <span class="grad-text">5-Verb Governed Memory Loop</span></h1>
      <p class="scene-lead">Every coding session follows deterministic lifecycle boundaries — eliminating parameter guesswork and memory pollution.</p>

      <div class="verbs-row" id="verbsRow">
        <div class="verb-card">
          <div>
            <div class="verb-num">VERB 01 · HYDRATE</div>
            <div class="verb-name">retrieve</div>
            <div class="verb-full">krusch_context_retrieve</div>
            <div class="verb-desc">Packs active invariants, blockers, decisions &amp; ranked RRF hits inside a strict token budget.</div>
          </div>
          <div class="verb-spec">query: "*"<br>include_state: true<br>limit_tokens: 4000</div>
        </div>

        <div class="verb-card">
          <div>
            <div class="verb-num">VERB 02 · PERSIST</div>
            <div class="verb-name">remember</div>
            <div class="verb-full">krusch_context_remember</div>
            <div class="verb-desc">Enforces a closed 5-type taxonomy and flags near-duplicates (cos ≥ 0.85) without blocking contrasts.</div>
          </div>
          <div class="verb-spec">decision | invariant<br>bug | lesson | blocker<br>+ span provenance</div>
        </div>

        <div class="verb-card">
          <div>
            <div class="verb-num">VERB 03 · EVOLVE</div>
            <div class="verb-name">revise</div>
            <div class="verb-full">krusch_context_revise</div>
            <div class="verb-desc">Supersedes evolving architecture with full temporal lineage or invalidates rules with mandatory reason.</div>
          </div>
          <div class="verb-spec">action: "supersede"<br>supersedes_id: #14<br>reason: required</div>
        </div>

        <div class="verb-card">
          <div>
            <div class="verb-num">VERB 04 · AUDIT</div>
            <div class="verb-name">nudge</div>
            <div class="verb-full">krusch_context_nudge</div>
            <div class="verb-desc">Audits staged diffs against active project invariants before commit (capped at 3 concrete findings).</div>
          </div>
          <div class="verb-spec">trigger: "pre_commit"<br>max_findings: 3<br>rejects "every_turn"</div>
        </div>

        <div class="verb-card">
          <div>
            <div class="verb-num">VERB 05 · HYGIENE</div>
            <div class="verb-name">health</div>
            <div class="verb-full">krusch_context_health</div>
            <div class="verb-desc">Reports SQLite / PostgreSQL storage mode, taxonomy counts, and 30-day TTL decay candidates.</div>
          </div>
          <div class="verb-spec">mode: node:sqlite<br>vectors: Float32 4KB<br>ttl_review: 30 days</div>
        </div>
      </div>
    </div>

    <!-- SCENE 3: SPAN-GROUNDED PROVENANCE & PRE-COMMIT NUDGE -->
    <div class="scene" id="scene-3">
      <div class="scene-eyebrow">INV-12 SPAN PROVENANCE &amp; PRE-COMMIT INVARIANT GATE</div>
      <h1 class="scene-h1">Self-Healing Anchors &amp; <span class="grad-text">Zero Zombie Regressions</span></h1>
      <p class="scene-lead">Memories bind to normalized SHA-256 code spans — healing shifted line numbers automatically and auditing diffs before commit.</p>

      <div class="prov-grid">
        <div class="editor-card">
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <span style="font-family:'Outfit',sans-serif;font-weight:800;font-size:24px;">Span-Grounded Provenance</span>
              <span style="font-family:'Fira Code',monospace;font-size:13px;color:#7CF5FF;">src/sqlite-engine.js</span>
            </div>
            <div class="code-lines">
              <div class="cl-row"><span class="cl-num" id="ln1">40</span><span style="color:#7C8EA8;">// 14 new helper lines inserted above...</span></div>
              <div class="cl-row"><span class="cl-num" id="ln2">41</span><span style="color:#C5ADFF;">import</span> { DatabaseSync } <span style="color:#C5ADFF;">from</span> <span style="color:#52FFA3;">'node:sqlite'</span>;</div>
              <div class="cl-row cl-anchored" id="anchoredRow">
                <span class="cl-num" id="ln3">42</span>
                <span id="anchoredCode" style="color:#FFFFFF;font-weight:600;">const db = new DatabaseSync(dbPath, { open: true });</span>
              </div>
              <div class="cl-row"><span class="cl-num" id="ln4">43</span><span>db.exec(<span style="color:#52FFA3;">'PRAGMA journal_mode = WAL;'</span>);</span></div>
              <div class="cl-row"><span class="cl-num" id="ln5">44</span><span>db.exec(<span style="color:#52FFA3;">'PRAGMA busy_timeout = 5000;'</span>);</span></div>
            </div>
          </div>

          <div class="anchor-status-bar status-healed" id="anchorBadge">
            <span id="anchorBadgeLeft">✔ SHA-256 a94f2c8e MATCH · Auto-Healed L42 → L56</span>
            <span id="anchorBadgeRight">[VALID ANCHOR]</span>
          </div>
        </div>

        <div class="editor-card" id="nudgePanel">
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <span style="font-family:'Outfit',sans-serif;font-weight:800;font-size:24px;">Pre-Commit Invariant Nudge</span>
              <span class="badge-red">trigger: "pre_commit"</span>
            </div>

            <div class="code-lines" style="margin-bottom:18px;">
              <div class="cl-row"><span class="cl-num" style="color:#FF6E8E;">-</span><span style="color:#8CA0BE;">import { DatabaseSync } from 'node:sqlite';</span></div>
              <div class="cl-row" style="background:rgba(255,82,119,0.14);"><span class="cl-num" style="color:#FF6E8E;">+</span><span style="color:#FF9EB5;font-weight:600;">import Database from 'better-sqlite3';</span></div>
            </div>

            <div class="nudge-box" id="nudgeVerdict">
              <div style="display:flex;justify-content:space-between;font-family:'Fira Code',monospace;font-size:13.5px;font-weight:700;color:#FF859E;">
                <span>⚠ INVARIANT VIOLATION (Finding 1 of 3 max)</span>
                <span>Memory #104</span>
              </div>
              <div style="font-size:17px;font-weight:600;color:#FFFFFF;line-height:1.45;">
                "Use Node 22 built-in node:sqlite; zero native C++ addons (better-sqlite3 is prohibited)."
              </div>
              <div style="font-family:'Fira Code',monospace;font-size:13.5px;color:#52FFA3;">
                → Action: Revert native addon import before git commit
              </div>
            </div>
          </div>

          <div style="font-family:'Fira Code',monospace;font-size:13.5px;color:#93A7C4;">
            Zero every-turn nagware · High-signal pre-commit gate
          </div>
        </div>
      </div>
    </div>

    <!-- SCENE 4: SOTA EMPIRICAL BENCHMARKS -->
    <div class="scene" id="scene-4">
      <div class="scene-eyebrow">335,000+ GRADED TRACES · SHA-256 CLEAN-ROOM AUDIT LOGS</div>
      <h1 class="scene-h1">SOTA Retrieval Accuracy at <span class="grad-text">$0.00 Ingestion Cost</span></h1>
      <p class="scene-lead">256/32-token Raw-RAG + Porter FTS5 BM25 + <strong>snowflake-arctic-embed2</strong> (1024d) 4-Way Reciprocal Rank Fusion.</p>

      <div class="bench-grid">
        <!-- Card 1: DolphinBench -->
        <div class="bcard bcard-gold" id="bcard-0">
          <div>
            <div class="b-head">
              <span class="b-name">DolphinBench</span>
              <span class="b-tag b-tag-gold">QUEUED #1</span>
            </div>
            <div class="b-scope">600 Tasks · 13,539 Sessions · 28 Official Runs</div>
            <div class="b-score-row">
              <div class="b-big c-gold" id="score-dolphin">0.00%</div>
              <div class="b-unit">
                <span class="b-frac">547 / 600</span>
                <span class="b-sub">Argon Low ($24.54)</span>
              </div>
            </div>
            <div class="b-meter"><div class="b-fill bf-gold" id="fill-dolphin"></div></div>
          </div>
          <div class="b-metrics">
            <div class="bm-row"><span>vs Published Mem0 (70.67%)</span><span class="bm-val" style="color:#FFD66B;">+20.5 pp · 3.9× cheaper</span></div>
            <div class="bm-row"><span>GPT-5.6 Luna Matched</span><span class="bm-val">81.50% @ $1.35 (71× less)</span></div>
            <div class="bm-row"><span>#1 Open-Weights (Gemma 4 31B)</span><span class="bm-val" style="color:#52FFA3;">57.33% @ $0.00</span></div>
          </div>
        </div>

        <!-- Card 2: Snap LoCoMo -->
        <div class="bcard bcard-cyan" id="bcard-1">
          <div>
            <div class="b-head">
              <span class="b-name">LoCoMo · ACL 24</span>
              <span class="b-tag b-tag-cyan">ZERO-LLM SOTA</span>
            </div>
            <div class="b-scope">1,540 QA Probes · 10 Multi-Month Convs</div>
            <div class="b-score-row">
              <div class="b-big c-cyan" id="score-locomo">0.00%</div>
              <div class="b-unit">
                <span class="b-frac">1,390 / 1,540</span>
                <span class="b-sub">92.66% Oracle@2</span>
              </div>
            </div>
            <div class="b-meter"><div class="b-fill bf-cyan" id="fill-locomo"></div></div>
          </div>
          <div class="b-metrics">
            <div class="bm-row"><span>Evidence Recall (dia_id)</span><span class="bm-val" style="color:#5CEEFF;">95.77% (98.9% 1-Hop)</span></div>
            <div class="bm-row"><span>Tight Budget (4.5K Tok)</span><span class="bm-val">89.68% (&lt;0.5× peer ctx)</span></div>
            <div class="bm-row"><span>Median Local Retrieval</span><span class="bm-val" style="color:#52FFA3;">182 ms · $0.00 Ingest</span></div>
          </div>
        </div>

        <!-- Card 3: ICLR 2026 BEAM -->
        <div class="bcard bcard-violet" id="bcard-2">
          <div>
            <div class="b-head">
              <span class="b-name">ICLR 2026 BEAM</span>
              <span class="b-tag b-tag-violet">10M-TOK SCALE</span>
            </div>
            <div class="b-scope">2,000 Probes · 100K–10M Splits · 178.3M Tok</div>
            <div class="b-score-row">
              <div class="b-big c-violet" id="score-beam">0.00%</div>
              <div class="b-unit">
                <span class="b-frac">10M IE Recall</span>
                <span class="b-sub">92.58% @ 100K (~8K ctx)</span>
              </div>
            </div>
            <div class="b-meter"><div class="b-fill bf-violet" id="fill-beam"></div></div>
          </div>
          <div class="b-metrics">
            <div class="bm-row"><span>100K → 1M QA Degradation</span><span class="bm-val" style="color:#D4BDFF;">0.0 pp (70.6% → 72.9%)</span></div>
            <div class="bm-row"><span>Contradiction Resolution</span><span class="bm-val">4 / 4 Splits Beat Cloud</span></div>
            <div class="bm-row"><span>Zero-Leakage Canary Gates</span><span class="bm-val" style="color:#52FFA3;">10 / 10 Verified</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- SCENE 5: OUTRO CTA -->
    <div class="scene" id="scene-5">
      <div class="outro-center" id="outroCenter">
        <div class="emblem-ring">
          <svg viewBox="0 -2 132 218" width="52" height="84" aria-hidden="true">
            <polygon points="121,2 79,25 93,28 48,50 78,53 19,89 58,85 5,128 44,124 5,158 34,155 4,212 47,191 35,186 70,171 52,168 105,139 66,140 123,103 74,105 128,69 86,69 126,35 102,36"
              fill="url(#boltGrad)" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" />
          </svg>
        </div>

        <div>
          <div class="scene-eyebrow" style="margin-bottom:8px;">SOVEREIGN LOCAL MEMORY · OPEN SOURCE MIT</div>
          <div class="outro-title">krusch-<span class="grad-text">context</span>-mcp</div>
          <p style="font-size:24px;color:#B8C7DE;margin-top:10px;">
            Persistent Working Memory &amp; Invariant Steering for AI Coding Agents
          </p>
        </div>

        <div class="cta-command-box">
          <span style="color:#00F5D4;">$</span>
          <span>npx krusch-context-mcp init</span>
          <span style="font-size:15px;padding:6px 12px;border-radius:8px;background:rgba(0,245,212,0.16);color:#52FFA3;">NODE ≥ 22</span>
        </div>

        <div class="outro-links">
          <span class="outro-pill">github.com/kruschdev/krusch-context-mcp</span>
          <span class="outro-pill" style="border-color:rgba(55,225,255,0.4);color:#7CF5FF;">krusch.dev</span>
          <span class="outro-pill">Cursor · Claude Code · Windsurf · Antigravity</span>
        </div>
      </div>
    </div>

  </div>

  <!-- Persistent Bottom Subtitle & Timeline -->
  <div class="bottom-hud">
    <div class="subtitle-pill" id="subtitlePill"></div>
    <div class="timeline-track"><div class="timeline-fill" id="timelineFill"></div></div>
  </div>
</div>

<script>
  const DATA = ${payloadJson};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const easeOutCubic = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const easeInOutQuad = (x) => {
    const t = clamp(x, 0, 1);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  };

  const viewport = document.getElementById('viewport');
  const chapPills = Array.from(document.querySelectorAll('#chapterRail .chap-pill'));
  const eqBars = Array.from(document.querySelectorAll('#eqBox .eq-bar'));
  const sceneEls = DATA.scenes.map((_, idx) => document.getElementById('scene-' + idx));
  const subtitlePill = document.getElementById('subtitlePill');
  const timelineFill = document.getElementById('timelineFill');

  // Scene-specific DOM refs
  const s0Bad = document.getElementById('s0-bad');
  const s0Good = document.getElementById('s0-good');
  const typedCmd = document.getElementById('typedCmd');
  const termCursor = document.getElementById('termCursor');
  const initSteps = [0, 1, 2, 3, 4].map((i) => document.getElementById('init-step-' + i));
  const ideConfigCard = document.getElementById('ideConfigCard');
  const ideBadges = document.getElementById('ideBadges');
  const verbCards = Array.from(document.querySelectorAll('#verbsRow .verb-card'));

  const ln1 = document.getElementById('ln1');
  const ln2 = document.getElementById('ln2');
  const ln3 = document.getElementById('ln3');
  const ln4 = document.getElementById('ln4');
  const ln5 = document.getElementById('ln5');
  const anchoredRow = document.getElementById('anchoredRow');
  const anchoredCode = document.getElementById('anchoredCode');
  const anchorBadge = document.getElementById('anchorBadge');
  const anchorBadgeLeft = document.getElementById('anchorBadgeLeft');
  const anchorBadgeRight = document.getElementById('anchorBadgeRight');
  const nudgeVerdict = document.getElementById('nudgeVerdict');

  const bcards = [0, 1, 2].map((i) => document.getElementById('bcard-' + i));
  const scoreDolphin = document.getElementById('score-dolphin');
  const scoreLocomo = document.getElementById('score-locomo');
  const scoreBeam = document.getElementById('score-beam');
  const fillDolphin = document.getElementById('fill-dolphin');
  const fillLocomo = document.getElementById('fill-locomo');
  const fillBeam = document.getElementById('fill-beam');
  const outroCenter = document.getElementById('outroCenter');

  const FULL_CMD = 'npx krusch-context-mcp init';

  window.renderFrame = function renderFrame(frameIdx) {
    const f = clamp(frameIdx, 0, DATA.totalFrames - 1);
    const globalProgress = f / Math.max(1, DATA.totalFrames - 1);
    const tGlobal = f / DATA.fps;

    // Subtle background nebula drift
    const orb1x = 16 + Math.sin(tGlobal * 0.35) * 4;
    const orb1y = 14 + Math.cos(tGlobal * 0.28) * 3;
    const orb2x = 85 + Math.cos(tGlobal * 0.31) * 4;
    const orb2y = 20 + Math.sin(tGlobal * 0.25) * 4;
    viewport.style.setProperty('--orb1-x', orb1x.toFixed(2) + '%');
    viewport.style.setProperty('--orb1-y', orb1y.toFixed(2) + '%');
    viewport.style.setProperty('--orb2-x', orb2x.toFixed(2) + '%');
    viewport.style.setProperty('--orb2-y', orb2y.toFixed(2) + '%');

    // Timeline & Voice Equalizer
    timelineFill.style.width = (globalProgress * 100).toFixed(3) + '%';
    const vLevel = DATA.voiceLevels[f] || 0;
    for (let i = 0; i < eqBars.length; i += 1) {
      const wave = 0.45 + 0.55 * Math.abs(Math.sin(tGlobal * 9.5 + i * 0.72));
      const h = 5 + Math.round(23 * vLevel * wave);
      eqBars[i].style.height = h + 'px';
      eqBars[i].style.opacity = (0.38 + 0.62 * vLevel).toFixed(2);
    }

    // Active Scene Lookup
    let activeScene = DATA.scenes[DATA.scenes.length - 1];
    for (let i = 0; i < DATA.scenes.length; i += 1) {
      if (f >= DATA.scenes[i].startFrame && f < DATA.scenes[i].endFrame) {
        activeScene = DATA.scenes[i];
        break;
      }
    }

    // Chapter Rail state
    for (let i = 0; i < chapPills.length; i += 1) {
      chapPills[i].className =
        'chap-pill' + (i === activeScene.index ? ' active' : i < activeScene.index ? ' done' : '');
    }

    // Scene Envelope (smooth 10-frame fade-in & fade-out)
    const localFrame = f - activeScene.startFrame;
    const localProgress = localFrame / Math.max(1, activeScene.sceneFrames - 1);
    const fadeIn = easeOutCubic(localFrame / 10);
    const fadeOut =
      activeScene.index === DATA.scenes.length - 1
        ? 1
        : easeOutCubic((activeScene.sceneFrames - 1 - localFrame) / 9);
    const env = Math.min(fadeIn, fadeOut);

    for (let i = 0; i < sceneEls.length; i += 1) {
      if (i === activeScene.index) {
        sceneEls[i].style.opacity = env.toFixed(3);
        const yShift = (1 - fadeIn) * 18;
        sceneEls[i].style.transform = 'translateY(' + yShift.toFixed(1) + 'px)';
      } else {
        sceneEls[i].style.opacity = '0';
      }
    }

    // Subtitle update + gentle fade
    subtitlePill.innerHTML = activeScene.captionHtml;
    subtitlePill.style.opacity = clamp(env * 1.15, 0, 1).toFixed(3);

    // Scene 0 choreo: Bad panel then Good panel entrance
    if (activeScene.index === 0) {
      const pBad = easeOutCubic(localProgress / 0.18);
      const pGood = easeOutCubic((localProgress - 0.24) / 0.22);
      s0Bad.style.opacity = pBad.toFixed(3);
      s0Bad.style.transform = 'translateY(' + ((1 - pBad) * 24).toFixed(1) + 'px)';
      s0Good.style.opacity = pGood.toFixed(3);
      s0Good.style.transform = 'translateY(' + ((1 - pGood) * 28).toFixed(1) + 'px)';
    }

    // Scene 1 choreo: Typewriter npx krusch-context-mcp init + streaming checks
    if (activeScene.index === 1) {
      const typeFrac = clamp((localProgress - 0.03) / 0.22, 0, 1);
      const chars = Math.floor(typeFrac * FULL_CMD.length);
      typedCmd.textContent = FULL_CMD.slice(0, chars);
      termCursor.style.opacity = Math.floor(tGlobal * 2.5) % 2 === 0 ? '1' : '0.15';

      for (let s = 0; s < initSteps.length; s += 1) {
        const stepP = easeOutCubic((localProgress - (0.27 + s * 0.10)) / 0.08);
        initSteps[s].style.opacity = stepP.toFixed(3);
        initSteps[s].style.transform = 'translateX(' + ((1 - stepP) * -16).toFixed(1) + 'px)';
      }

      const ideP = easeOutCubic((localProgress - 0.36) / 0.20);
      ideConfigCard.style.opacity = ideP.toFixed(3);
      ideConfigCard.style.transform = 'translateY(' + ((1 - ideP) * 20).toFixed(1) + 'px)';
      const badgeP = easeOutCubic((localProgress - 0.56) / 0.18);
      ideBadges.style.opacity = badgeP.toFixed(3);
    }

    // Scene 2 choreo: Sequential spotlight across the 5 canonical verbs
    if (activeScene.index === 2) {
      const activeVerbIdx = clamp(Math.floor(((localProgress - 0.08) / 0.84) * 5), 0, 4);
      for (let v = 0; v < verbCards.length; v += 1) {
        const enterP = easeOutCubic((localProgress - v * 0.06) / 0.14);
        const isLit = localProgress >= 0.08 && v <= activeVerbIdx;
        verbCards[v].className = 'verb-card' + (isLit ? ' lit' : '');
        const lift = v === activeVerbIdx && localProgress >= 0.08 ? -8 : 0;
        verbCards[v].style.opacity = enterP.toFixed(3);
        verbCards[v].style.transform = 'translateY(' + ((1 - enterP) * 24 + lift).toFixed(1) + 'px)';
      }
    }

    // Scene 3 choreo: Span shift self-healing -> Drift detection -> Pre-commit nudge
    if (activeScene.index === 3) {
      const shiftPhase = easeInOutQuad((localProgress - 0.08) / 0.22);
      const offsetLines = Math.round(shiftPhase * 14);
      ln1.textContent = String(40 + offsetLines);
      ln2.textContent = String(41 + offsetLines);
      ln3.textContent = String(42 + offsetLines);
      ln4.textContent = String(43 + offsetLines);
      ln5.textContent = String(44 + offsetLines);

      const isDrifted = localProgress > 0.46;
      if (!isDrifted) {
        anchoredRow.className = 'cl-row cl-anchored';
        anchoredCode.textContent = 'const db = new DatabaseSync(dbPath, { open: true });';
        anchorBadge.className = 'anchor-status-bar status-healed';
        anchorBadgeLeft.textContent =
          '✔ SHA-256 a94f2c8e MATCH · Auto-Healed L42 → L' + (42 + offsetLines);
        anchorBadgeRight.textContent = '[VALID ANCHOR]';
      } else {
        anchoredRow.className = 'cl-row cl-drifted';
        anchoredCode.textContent = 'const db = new BetterSqlite(dbPath); // span mutated';
        anchorBadge.className = 'anchor-status-bar status-drift';
        anchorBadgeLeft.textContent = '⚠ SHA-256 MISMATCH at L56 · Underlying code changed';
        anchorBadgeRight.textContent = '[DRIFTED]';
      }

      const nudgeP = easeOutCubic((localProgress - 0.50) / 0.18);
      nudgeVerdict.style.opacity = (0.25 + 0.75 * nudgeP).toFixed(3);
      nudgeVerdict.style.transform = 'scale(' + (0.96 + 0.04 * nudgeP).toFixed(3) + ')';
    }

    // Scene 4 choreo: Rolling benchmark counters & progress meters
    if (activeScene.index === 4) {
      const targets = [91.17, 90.26, 93.0];
      const scoreEls = [scoreDolphin, scoreLocomo, scoreBeam];
      const fillEls = [fillDolphin, fillLocomo, fillBeam];
      for (let b = 0; b < 3; b += 1) {
        const cardP = easeOutCubic((localProgress - b * 0.11) / 0.20);
        const countP = easeOutCubic((localProgress - (0.08 + b * 0.14)) / 0.34);
        bcards[b].style.opacity = cardP.toFixed(3);
        bcards[b].style.transform = 'translateY(' + ((1 - cardP) * 28).toFixed(1) + 'px)';
        const val = targets[b] * countP;
        scoreEls[b].textContent = val.toFixed(2) + '%';
        fillEls[b].style.width = val.toFixed(2) + '%';
      }
    }

    // Scene 5 choreo: Hero outro scale-in
    if (activeScene.index === 5) {
      const pOut = easeOutCubic(localProgress / 0.28);
      outroCenter.style.opacity = pOut.toFixed(3);
      outroCenter.style.transform = 'scale(' + (0.94 + 0.06 * pOut).toFixed(3) + ')';
    }
  };
</script>
</body>
</html>`;
}

async function main() {
  const opts = parseCliArgs(process.argv);
  fs.mkdirSync(path.dirname(opts.outMp4), { recursive: true });
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  if (opts.keyframesDir) {
    fs.mkdirSync(opts.keyframesDir, { recursive: true });
  }

  console.log('[1/4] Synthesizing / verifying 6 neural narration tracks...');
  const scenesWithSamples = SCENES.map((scene, idx) => {
    const wavPath = ensureSceneVoiceWav(scene, idx, opts);
    const samples = readMonoFloatSamples(wavPath);
    console.log(
      `  • Scene ${idx + 1} (${scene.id}): ${(samples.length / SAMPLE_RATE).toFixed(2)}s speech`
    );
    return { ...scene, samples };
  });

  console.log('[2/4] Building frame-locked master stereo WAV + ducked ambient synth bed + SRT...');
  const masterWavPath = path.join(opts.cacheDir, 'master_mix_44k_stereo.wav');
  const { timeline, totalFrames, totalSeconds, frameVoiceLevels } = buildTimelineAndMasterAudio(
    scenesWithSamples,
    masterWavPath,
    opts.outSrt
  );
  console.log(
    `  • Total video length: ${totalSeconds.toFixed(2)}s (${totalFrames} frames @ ${FPS}fps)`
  );

  const stageHtmlPath = path.join(opts.cacheDir, 'stage_1080p.html');
  fs.writeFileSync(
    stageHtmlPath,
    buildStageHtml(timeline, totalFrames, frameVoiceLevels),
    'utf8'
  );

  console.log('[3/4] Launching headless Chromium & streaming 1920x1080 frames to FFmpeg...');
  const browser = await launchBrowser({
    executablePath: '/usr/bin/google-chrome',
    viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  });

  const ffmpegArgs = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-framerate',
    String(FPS),
    '-i',
    '-',
    '-i',
    masterWavPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    opts.outMp4,
  ];

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  const keyframeSet = new Map();
  for (const s of timeline) {
    const midFrame = s.startFrame + Math.floor(s.sceneFrames * 0.72);
    keyframeSet.set(midFrame, s);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    await page.goto(`file://${stageHtmlPath}`, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);

    const t0 = Date.now();
    for (let f = 0; f < totalFrames; f += 1) {
      await page.evaluate((frameIdx) => window.renderFrame(frameIdx), f);
      const jpgBuffer = await page.screenshot({ type: 'jpeg', quality: 95 });

      if (!ffmpegProc.stdin.write(jpgBuffer)) {
        await once(ffmpegProc.stdin, 'drain');
      }

      if (opts.keyframesDir && keyframeSet.has(f)) {
        const sceneInfo = keyframeSet.get(f);
        const kfPath = path.join(
          opts.keyframesDir,
          `scene_0${sceneInfo.index + 1}_${sceneInfo.id}.png`
        );
        await page.screenshot({ path: kfPath, type: 'png' });
      }

      if ((f + 1) % 300 === 0 || f === totalFrames - 1) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `  • Rendered ${f + 1}/${totalFrames} frames (${(((f + 1) / totalFrames) * 100).toFixed(0)}%) in ${elapsed}s`
        );
      }
    }

    ffmpegProc.stdin.end();
    const [exitCode] = await once(ffmpegProc, 'close');
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with non-zero code ${exitCode}`);
    }
  } finally {
    await browser.close();
  }

  const stat = fs.statSync(opts.outMp4);
  console.log(
    `[4/4] OK: ${opts.outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB, ${totalSeconds.toFixed(1)}s, 1920x1080 @ ${FPS}fps)`
  );
  console.log(`      SRT: ${opts.outSrt}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
