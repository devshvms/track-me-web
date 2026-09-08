#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const workspace = resolve(webRoot, '..');
const capturesRoot = resolve(workspace, 'store-assets', 'listing-1.8.7');
const outputRoot = resolve(webRoot, 'public', 'assets', 'showcase');
const chrome = process.env.CHROME_BIN || resolve(
  homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1223',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

const frames = [
  ['offline-tracking', '01-recording-partial.png'],
  ['share-preview', '09-export-preview.png'],
  ['ride-detail', '04-ride-detail.png'],
  ['progress', '07-progress.png'],
];

const asDataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

function page(source) {
  const android = asDataUrl(resolve(capturesRoot, 'android', source));
  const ios = asDataUrl(resolve(capturesRoot, 'ios', source));

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { width: 1120px; height: 625px; margin: 0; overflow: hidden; }
  body {
    background:
      radial-gradient(64% 110% at 50% 118%, rgba(2,119,182,.78), transparent 68%),
      radial-gradient(45% 75% at 50% 4%, rgba(41,182,246,.17), transparent 72%),
      linear-gradient(155deg, #12161c 0%, #181a20 48%, #0a2536 100%);
  }
  body::before {
    content: ''; position: absolute; inset: -18%; opacity: .12;
    background: repeating-radial-gradient(ellipse at center, transparent 0 42px, #29b6f6 43px 44px, transparent 45px 76px);
    transform: rotate(-9deg) scaleY(.62);
  }
  .stage { position: relative; width: 100%; height: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 86px; padding: 42px 80px 0; }
  .device { position: relative; height: 555px; padding: 8px; background: linear-gradient(145deg, #66717c, #20262d 28%, #11161b 72%, #79838d); box-shadow: 0 32px 58px rgba(0,0,0,.65), 0 0 52px rgba(41,182,246,.13); }
  .device.android { width: 266px; border-radius: 35px 35px 0 0; }
  .device.ios { width: 256px; border-radius: 42px 42px 0 0; }
  .screen { width: 100%; height: 100%; overflow: hidden; background: #000; }
  .android .screen { border-radius: 27px 27px 0 0; }
  .ios .screen { border-radius: 34px 34px 0 0; }
  img { display: block; width: 100%; height: 100%; object-fit: fill; }
  .badge { position: absolute; z-index: 2; top: 18px; left: 18px; padding: 7px 12px; border-radius: 999px; background: rgba(12,18,24,.84); border: 1px solid rgba(255,255,255,.13); color: #f8fafc; font: 600 15px system-ui, sans-serif; letter-spacing: .02em; backdrop-filter: blur(12px); }
</style></head><body><main class="stage">
  <div class="device android"><span class="badge">Android</span><div class="screen"><img src="${android}" alt=""></div></div>
  <div class="device ios"><span class="badge">iOS</span><div class="screen"><img src="${ios}" alt=""></div></div>
</main></body></html>`;
}

const temp = mkdtempSync(resolve(tmpdir(), 'trackme-showcase-'));

try {
  for (const [name, source] of frames) {
    const htmlPath = resolve(temp, `${name}.html`);
    const outputPath = resolve(outputRoot, `${name}.png`);
    writeFileSync(htmlPath, page(source));
    execFileSync(chrome, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=3000',
      '--window-size=1120,625',
      `--screenshot=${outputPath}`,
      `file://${htmlPath}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`generated ${outputPath}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
