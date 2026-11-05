#!/usr/bin/env node
/**
 * Deterministic Social Preview / OpenGraph Share Card Generator
 * Renders docs/assets/social-preview.png (and docs/assets/banner.png) at exact
 * GitHub 1280x640 (2:1, <1MB PNG) specification from supersampled 2x Chromium HTML/SVG.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'docs', 'assets');
const SOCIAL_PREVIEW_PATH = path.join(ASSETS_DIR, 'social-preview.png');
const BANNER_PATH = path.join(ASSETS_DIR, 'banner.png');

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>krusch-context-mcp Social Preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Outfit:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px;
    height: 640px;
    overflow: hidden;
    background: #060911;
    color: #F4F7FB;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  .canvas {
    position: relative;
    width: 1280px;
    height: 640px;
    padding: 42px 54px 38px 54px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background:
      radial-gradient(680px 360px at 14% 12%, rgba(0, 229, 255, 0.16), transparent 68%),
      radial-gradient(640px 380px at 88% 18%, rgba(139, 110, 255, 0.17), transparent 70%),
      radial-gradient(760px 340px at 50% 96%, rgba(0, 245, 212, 0.10), transparent 72%),
      linear-gradient(180deg, #070B14 0%, #090D18 52%, #060911 100%);
  }

  /* Subtle perspective engineering grid */
  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, rgba(95, 135, 185, 0.075) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(95, 135, 185, 0.075) 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: radial-gradient(ellipse 92% 86% at 50% 48%, #000 55%, transparent 100%);
    pointer-events: none;
  }

  /* Outer subtle HUD frame inside safe zone */
  .hud-frame {
    position: absolute;
    inset: 18px;
    border-radius: 20px;
    border: 1px solid rgba(120, 165, 220, 0.16);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    pointer-events: none;
  }

  .top-bar, .hero-block, .cards-grid, .bottom-bar {
    position: relative;
    z-index: 2;
  }

  /* Top identity bar */
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .brand-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-badge {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    padding: 6px 13px 6px 10px;
    background: rgba(13, 20, 35, 0.88);
    border: 1px solid rgba(55, 225, 255, 0.32);
    border-radius: 999px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }

  .brand-name {
    font-family: 'Outfit', sans-serif;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: 0.08em;
    color: #FFFFFF;
  }

  .brand-name span {
    color: #37E1FF;
  }

  .repo-slug {
    font-family: 'Fira Code', monospace;
    font-size: 13.5px;
    font-weight: 500;
    color: #A8B8D0;
    padding: 5px 12px;
    background: rgba(15, 23, 40, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
  }

  .top-pills {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 13px;
    border-radius: 999px;
    font-family: 'Fira Code', monospace;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .pill-green {
    background: rgba(0, 230, 118, 0.11);
    border: 1px solid rgba(0, 230, 118, 0.42);
    color: #4DFF9E;
  }

  .dot-live {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #00E676;
    box-shadow: 0 0 10px #00E676;
  }

  .pill-slate {
    background: rgba(17, 25, 44, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.25);
    color: #D4DFEE;
  }

  /* Hero Title */
  .hero-block {
    margin-top: 2px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 20px;
  }

  .title-wrap {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .hero-title {
    font-family: 'Outfit', sans-serif;
    font-weight: 900;
    font-size: 46px;
    line-height: 1.03;
    letter-spacing: -0.02em;
    color: #FFFFFF;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .hero-title .accent-word {
    background: linear-gradient(92deg, #52F3FF 0%, #25D9FF 48%, #9D7BFF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .version-chip {
    font-family: 'Fira Code', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #6FF1FE;
    background: rgba(55, 225, 255, 0.11);
    border: 1px solid rgba(55, 225, 255, 0.34);
    padding: 4px 10px;
    border-radius: 7px;
    letter-spacing: 0;
    transform: translateY(-3px);
  }

  .hero-sub {
    font-size: 16.5px;
    font-weight: 500;
    color: #B6C5DC;
    letter-spacing: -0.005em;
  }

  .hero-sub strong {
    color: #ECF4FF;
    font-weight: 600;
  }

  /* 3 Benchmark Scorecards */
  .cards-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
    margin-top: 4px;
  }

  .bcard {
    position: relative;
    border-radius: 16px;
    padding: 20px 21px 18px 21px;
    background: linear-gradient(165deg, rgba(16, 24, 42, 0.93) 0%, rgba(9, 14, 26, 0.96) 100%);
    box-shadow:
      0 14px 34px rgba(0, 0, 0, 0.48),
      inset 0 1px 0 rgba(255, 255, 255, 0.07);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 294px;
    overflow: hidden;
  }

  .bcard::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
  }

  .bcard-gold {
    border: 1px solid rgba(249, 181, 32, 0.38);
  }
  .bcard-gold::before {
    background: linear-gradient(90deg, #F9B520 0%, #FFE07D 50%, #00E5FF 100%);
  }

  .bcard-cyan {
    border: 1px solid rgba(0, 229, 255, 0.42);
  }
  .bcard-cyan::before {
    background: linear-gradient(90deg, #00F5D4 0%, #00E5FF 55%, #6EA8FE 100%);
  }

  .bcard-violet {
    border: 1px solid rgba(157, 123, 255, 0.40);
  }
  .bcard-violet::before {
    background: linear-gradient(90deg, #8B6EFF 0%, #C084FC 55%, #37E1FF 100%);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .bench-name {
    font-family: 'Outfit', sans-serif;
    font-weight: 800;
    font-size: 15px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #E6EFFA;
  }

  .rank-tag {
    font-family: 'Fira Code', monospace;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .tag-gold {
    background: rgba(249, 181, 32, 0.16);
    border: 1px solid rgba(249, 181, 32, 0.48);
    color: #FFD15C;
  }

  .tag-cyan {
    background: rgba(0, 229, 255, 0.14);
    border: 1px solid rgba(0, 229, 255, 0.44);
    color: #5CEEFF;
  }

  .tag-violet {
    background: rgba(157, 123, 255, 0.16);
    border: 1px solid rgba(157, 123, 255, 0.45);
    color: #D2BAFF;
  }

  .bench-scope {
    font-family: 'Fira Code', monospace;
    font-size: 11.5px;
    color: #8A9CB8;
    margin-top: 4px;
    white-space: nowrap;
  }

  .score-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin: 14px 0 12px 0;
  }

  .score-big {
    font-family: 'Outfit', sans-serif;
    font-weight: 900;
    font-size: 56px;
    line-height: 0.98;
    letter-spacing: -0.03em;
  }

  .score-gold { color: #FFF8E7; text-shadow: 0 0 28px rgba(249, 181, 32, 0.24); }
  .score-cyan { color: #ECFEFF; text-shadow: 0 0 28px rgba(0, 229, 255, 0.25); }
  .score-violet { color: #F5F0FF; text-shadow: 0 0 28px rgba(139, 110, 255, 0.28); }

  .score-unit {
    display: flex;
    flex-direction: column;
    gap: 3px;
    white-space: nowrap;
  }

  .score-fraction {
    font-family: 'Fira Code', monospace;
    font-size: 13.5px;
    font-weight: 700;
    color: #E2ECFA;
  }

  .score-label {
    font-size: 12px;
    font-weight: 600;
    color: #93A7C4;
    white-space: nowrap;
  }

  .meter-track {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.14);
    overflow: hidden;
    margin-top: 6px;
  }

  .meter-fill {
    height: 100%;
    border-radius: 999px;
  }

  .fill-gold {
    width: 91.17%;
    background: linear-gradient(90deg, #F9B520 0%, #FFE07D 65%, #00E5FF 100%);
    box-shadow: 0 0 12px rgba(249, 181, 32, 0.45);
  }

  .fill-cyan {
    width: 90.26%;
    background: linear-gradient(90deg, #00F5D4 0%, #00E5FF 70%, #6EA8FE 100%);
    box-shadow: 0 0 12px rgba(0, 229, 255, 0.45);
  }

  .fill-violet {
    width: 93.00%;
    background: linear-gradient(90deg, #8B6EFF 0%, #C084FC 70%, #37E1FF 100%);
    box-shadow: 0 0 12px rgba(139, 110, 255, 0.45);
  }

  .metrics-list {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding-top: 13px;
    border-top: 1px solid rgba(148, 163, 184, 0.16);
  }

  .metric-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
    line-height: 1.25;
    color: #B4C3D8;
    white-space: nowrap;
  }

  .metric-key {
    font-weight: 500;
  }

  .metric-val {
    font-family: 'Fira Code', monospace;
    font-weight: 600;
    font-size: 12px;
    color: #F1F6FD;
  }

  .val-gold { color: #FFD66B; }
  .val-green { color: #52FFA3; }
  .val-cyan { color: #5CEEFF; }
  .val-violet { color: #D4BDFF; }

  /* Bottom architecture bar */
  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-radius: 12px;
    background: rgba(12, 18, 32, 0.86);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }

  .verbs-group {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: 'Fira Code', monospace;
    font-size: 12.5px;
    color: #9FB1CA;
  }

  .verb-chip {
    padding: 3px 8px;
    border-radius: 5px;
    background: rgba(55, 225, 255, 0.09);
    border: 1px solid rgba(55, 225, 255, 0.22);
    color: #7CEEFF;
    font-weight: 600;
  }

  .install-cmd {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 600;
    color: #FFFFFF;
    background: rgba(139, 110, 255, 0.15);
    border: 1px solid rgba(139, 110, 255, 0.38);
    padding: 5px 13px;
    border-radius: 8px;
  }

  .install-cmd .prompt {
    color: #00F5D4;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="grid-overlay"></div>
    <div class="hud-frame"></div>

    <!-- Top Identity Row -->
    <div class="top-bar">
      <div class="brand-left">
        <div class="brand-badge">
          <svg viewBox="0 -2 132 218" width="13" height="21" aria-hidden="true">
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
        <span class="repo-slug">kruschdev/krusch-context-mcp</span>
      </div>

      <div class="top-pills">
        <div class="pill pill-green">
          <span class="dot-live"></span>
          <span>$0.00 ZERO-LLM INGEST</span>
        </div>
        <div class="pill pill-slate">node:sqlite · Zero Docker · &lt;350 Schema Tok</div>
      </div>
    </div>

    <!-- Title Block -->
    <div class="hero-block">
      <div class="title-wrap">
        <div class="hero-title">
          <span>krusch-<span class="accent-word">context</span>-mcp</span>
          <span class="version-chip">v2.0 · MIT</span>
        </div>
        <div class="hero-sub">
          <strong>Persistent Working Memory &amp; Invariant Steering for Coding Agents</strong> — 256/32 Raw-RAG + Porter FTS5 + 1024d 4-Way RRF
        </div>
      </div>
    </div>

    <!-- 3 Verified Benchmark Scorecards -->
    <div class="cards-grid">

      <!-- Card 1: Official DolphinBench -->
      <div class="bcard bcard-gold">
        <div>
          <div class="card-head">
            <span class="bench-name">DolphinBench</span>
            <span class="rank-tag tag-gold">#1 OVERALL</span>
          </div>
          <div class="bench-scope">600 Tasks · 13,539 Sessions · 1.50M Tokens</div>
          <div class="score-row">
            <div class="score-big score-gold">91.17%</div>
            <div class="score-unit">
              <span class="score-fraction">547 / 600</span>
              <span class="score-label">Argon Low ($24.54)</span>
            </div>
          </div>
          <div class="meter-track"><div class="meter-fill fill-gold"></div></div>
        </div>
        <div class="metrics-list">
          <div class="metric-item">
            <span class="metric-key">vs #1 Cloud Mem0</span>
            <span class="metric-val val-gold">+20.5 pp · 3.9× cheaper</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">GPT-5.6 Luna Matched</span>
            <span class="metric-val">81.33% @ $1.35 (71× less)</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">#1 Open-Weights</span>
            <span class="metric-val val-green">57.33% / 54.17% @ $0.00</span>
          </div>
        </div>
      </div>

      <!-- Card 2: Snap LoCoMo -->
      <div class="bcard bcard-cyan">
        <div>
          <div class="card-head">
            <span class="bench-name">LoCoMo · ACL 24</span>
            <span class="rank-tag tag-cyan">ZERO-LLM SOTA</span>
          </div>
          <div class="bench-scope">1,540 QA Probes · 10 Multi-Month Convs</div>
          <div class="score-row">
            <div class="score-big score-cyan">90.26%</div>
            <div class="score-unit">
              <span class="score-fraction">1,390 / 1,540</span>
              <span class="score-label">92.66% Oracle@2</span>
            </div>
          </div>
          <div class="meter-track"><div class="meter-fill fill-cyan"></div></div>
        </div>
        <div class="metrics-list">
          <div class="metric-item">
            <span class="metric-key">Evidence Recall (dia_id)</span>
            <span class="metric-val val-cyan">95.77% (98.9% 1-Hop)</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">Tight Budget (4.5K Tok)</span>
            <span class="metric-val">89.68% (&lt;0.5× peer ctx)</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">Local Retrieval · Ingest</span>
            <span class="metric-val val-green">182 ms · $0.00 (+19.9 pp)</span>
          </div>
        </div>
      </div>

      <!-- Card 3: ICLR 2026 BEAM -->
      <div class="bcard bcard-violet">
        <div>
          <div class="card-head">
            <span class="bench-name">ICLR 2026 BEAM</span>
            <span class="rank-tag tag-violet">10M-TOK SCALE</span>
          </div>
          <div class="bench-scope">2,000 Probes · 100K–10M Splits · 178.3M Tok</div>
          <div class="score-row">
            <div class="score-big score-violet">93.00%</div>
            <div class="score-unit">
              <span class="score-fraction">10M IE Recall</span>
              <span class="score-label">92.58% @ 100K (~8K ctx)</span>
            </div>
          </div>
          <div class="meter-track"><div class="meter-fill fill-violet"></div></div>
        </div>
        <div class="metrics-list">
          <div class="metric-item">
            <span class="metric-key">100K to 1M QA Drift</span>
            <span class="metric-val val-violet">0.0 pp (70.6% to 72.9%)</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">Contradiction Splits</span>
            <span class="metric-val">4 / 4 Beat Cloud past.dev</span>
          </div>
          <div class="metric-item">
            <span class="metric-key">Clean-Room Audit Gates</span>
            <span class="metric-val val-green">10 / 10 Zero-Leakage</span>
          </div>
        </div>
      </div>

    </div>

    <!-- Bottom 5-Verb & Quickstart Bar -->
    <div class="bottom-bar">
      <div class="verbs-group">
        <span style="color:#E2ECF9;font-weight:600;margin-right:2px;">5 MCP Verbs:</span>
        <span class="verb-chip">retrieve</span>
        <span class="verb-chip">remember</span>
        <span class="verb-chip">revise</span>
        <span class="verb-chip">nudge</span>
        <span class="verb-chip">health</span>
      </div>
      <div class="install-cmd">
        <span class="prompt">$</span>
        <span>npx krusch-context-mcp init</span>
      </div>
    </div>

  </div>
</body>
</html>
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-social-card-'));
const htmlPath = path.join(tmpDir, 'card.html');
const rawPngPath = path.join(tmpDir, 'raw_2x.png');

try {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(htmlPath, HTML, 'utf8');

  execFileSync(
    '/usr/bin/google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,640',
      '--force-device-scale-factor=2',
      '--virtual-time-budget=4500',
      `--screenshot=${rawPngPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'pipe' }
  );

  // Downsample 2560x1280 -> exact 1280x640 with Lanczos via ffmpeg (<1 MB GitHub limit)
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      rawPngPath,
      '-vf',
      'scale=1280:640:flags=lanczos',
      '-frames:v',
      '1',
      SOCIAL_PREVIEW_PATH,
    ],
    { stdio: 'inherit' }
  );
  fs.copyFileSync(SOCIAL_PREVIEW_PATH, BANNER_PATH);

  const stat = fs.statSync(SOCIAL_PREVIEW_PATH);
  console.log(
    `OK: ${SOCIAL_PREVIEW_PATH} (${(stat.size / 1024).toFixed(1)} KB, <1024 KB GitHub limit)`
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
