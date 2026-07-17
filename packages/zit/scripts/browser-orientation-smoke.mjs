#!/usr/bin/env node
/**
 * Real-browser pixel verification for EXIF orientation baking (issue #52).
 *
 * `bakeOrientation` (src/browser/prepare-upload.ts) delegates the actual
 * rotate/flip math to `createImageBitmap(blob, { imageOrientation:
 * 'from-image' })` rather than hand-rolling it — jsdom does not implement
 * Canvas/ImageBitmap, so `prepare-upload.test.ts` can only ever assert that
 * function was *called*, never that the browser's own orientation semantics
 * are actually correct. This script drives a REAL browser to close that gap.
 *
 * Approach (no new npm dependencies, per the package's frozen dependency
 * set):
 *   1. Generate a small asymmetric-grid JPEG fixture per EXIF orientation
 *      (1-8) using `sharp`, an existing runtime dependency — solid color
 *      blocks + `chromaSubsampling: '4:4:4'` + `quality: 100` avoid JPEG
 *      chroma-subsampling bleed corrupting the tiny test pattern.
 *   2. Launch the Chrome binary preinstalled on GitHub Actions ubuntu-latest
 *      runners (`google-chrome`) headless, and drive it over the Chrome
 *      DevTools Protocol using Node's own built-in `WebSocket` global (stable
 *      since Node 22) — no `puppeteer`/`playwright` dependency needed.
 *   3. In-page, run exactly what `bakeOrientation` runs:
 *      `createImageBitmap(blob, { imageOrientation: 'from-image' })` then
 *      draw to a canvas, and sample each grid cell's center pixel back out.
 *   4. Compare against `applyExifOrientationToGrid` from
 *      `src/browser/orientation-semantics.ts` — duplicated here in plain JS
 *      (see EXPECTED_TRANSFORM below) because this script runs under plain
 *      `node`, not through the TypeScript/vitest toolchain, so it cannot
 *      import a `.ts` file directly. Keep the two in sync; both are covered
 *      by `orientation-semantics.test.ts`, which independently verifies the
 *      same transform table.
 *
 * Usage: node scripts/browser-orientation-smoke.mjs
 * Requires `pnpm build` to have run first is NOT needed — this only needs
 * `sharp` (a runtime dependency) and a system Chrome/Chromium binary.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const COLORS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
];
const COLS = 3;
const ROWS = 2;
const BLOCK = 8; // pixels per grid cell in the generated fixture

const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const CDP_TIMEOUT_MS = 15_000;

// --- Duplicated pure transform (see doc comment above for why) ---
function cloneGrid(grid) {
  return grid.map((row) => [...row]);
}
function flipHorizontal(grid) {
  return grid.map((row) => [...row].reverse());
}
function flipVertical(grid) {
  return [...grid].reverse().map((row) => [...row]);
}
function rotate180(grid) {
  return flipHorizontal(flipVertical(grid));
}
function transpose(grid) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const result = Array.from({ length: cols }, () => new Array(rows));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) result[x][y] = grid[y][x];
  }
  return result;
}
function rotate90Cw(grid) {
  return transpose(grid).map((row) => row.reverse());
}
function rotate90Ccw(grid) {
  return transpose(grid).reverse();
}
function transverse(grid) {
  return rotate180(transpose(grid));
}
function applyExifOrientationToGrid(grid, orientation) {
  switch (orientation) {
    case 1: return cloneGrid(grid);
    case 2: return flipHorizontal(grid);
    case 3: return rotate180(grid);
    case 4: return flipVertical(grid);
    case 5: return transpose(grid);
    case 6: return rotate90Cw(grid);
    case 7: return transverse(grid);
    case 8: return rotate90Ccw(grid);
    default: throw new Error(`Invalid EXIF orientation value: ${orientation}`);
  }
}
// --- end duplicated pure transform ---

function findChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      execFileSync('which', [candidate], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `No Chrome/Chromium binary found (tried: ${CHROME_CANDIDATES.join(', ')}). ` +
      'This smoke test requires a system browser; GitHub Actions ubuntu-latest runners ship one preinstalled.',
  );
}

async function makeFixtureBase64(orientation) {
  const width = COLS * BLOCK;
  const height = ROWS * BLOCK;
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / BLOCK);
      const cy = Math.floor(y / BLOCK);
      const [r, g, b] = COLORS[cy * COLS + cx];
      const idx = (y * width + x) * 3;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
    }
  }
  const jpeg = await sharp(buf, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return jpeg.toString('base64');
}

/** Minimal CDP client: launches headless Chrome, exposes a `send(method, params, sessionId)` RPC. */
async function launchCdpSession() {
  const chromeBinary = findChromeBinary();
  const userDataDir = mkdtempSync(join(tmpdir(), 'zit-orientation-smoke-'));
  const chrome = spawn(
    chromeBinary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for Chrome DevTools listener. Output so far: ${buf}`)),
      CDP_TIMEOUT_MS,
    );
    chrome.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chrome.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited early (code ${code}) before DevTools was ready. Output: ${buf}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (err) => reject(new Error(`CDP WebSocket error: ${err.message ?? err}`));
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error for id ${msg.id}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  };

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP command "${method}" timed out after ${CDP_TIMEOUT_MS}ms`));
        }
      }, CDP_TIMEOUT_MS);
    });
  }

  async function close() {
    try {
      ws.close();
    } catch {
      // already closed
    }
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    // Wait for the process to actually release its user-data-dir before
    // removing it — Chrome writes lock/singleton files on shutdown, and
    // rmSync can otherwise race it (ENOTEMPTY).
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  return { send, close };
}

async function evaluateFixtureInBrowser(send, sessionId, base64Jpeg) {
  const expression = `
    (async () => {
      const bin = atob(${JSON.stringify(base64Jpeg)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      // Same call bakeOrientation() makes in src/browser/prepare-upload.ts.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const cols = canvas.width / ${BLOCK};
      const rows = canvas.height / ${BLOCK};
      const grid = [];
      for (let cy = 0; cy < rows; cy++) {
        const row = [];
        for (let cx = 0; cx < cols; cx++) {
          const px = ctx.getImageData(cx * ${BLOCK} + ${BLOCK} / 2, cy * ${BLOCK} + ${BLOCK} / 2, 1, 1).data;
          row.push([px[0], px[1], px[2]]);
        }
        grid.push(row);
      }
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      return JSON.stringify({ width, height, grid });
    })()
  `;
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`In-page evaluation threw: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return JSON.parse(result.result.value);
}

/** Allow small (±tolerance) per-channel drift from JPEG encoding, even at quality 100. */
function colorsMatch(actual, expected, tolerance = 6) {
  return actual.every((channel, i) => Math.abs(channel - expected[i]) <= tolerance);
}

async function main() {
  const baseGrid = [];
  for (let cy = 0; cy < ROWS; cy++) {
    const row = [];
    for (let cx = 0; cx < COLS; cx++) row.push(COLORS[cy * COLS + cx]);
    baseGrid.push(row);
  }

  const { send, close } = await launchCdpSession();
  const failures = [];
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);

    for (let orientation = 1; orientation <= 8; orientation++) {
      const base64Jpeg = await makeFixtureBase64(orientation);
      const actual = await evaluateFixtureInBrowser(send, sessionId, base64Jpeg);
      const expectedGrid = applyExifOrientationToGrid(baseGrid, orientation);
      const expectedWidth = expectedGrid[0].length * BLOCK;
      const expectedHeight = expectedGrid.length * BLOCK;

      if (actual.width !== expectedWidth || actual.height !== expectedHeight) {
        failures.push(
          `orientation ${orientation}: expected canvas ${expectedWidth}x${expectedHeight}, got ${actual.width}x${actual.height}`,
        );
        continue;
      }

      for (let y = 0; y < expectedGrid.length; y++) {
        for (let x = 0; x < expectedGrid[0].length; x++) {
          const actualColor = actual.grid[y][x];
          const expectedColor = expectedGrid[y][x];
          if (!colorsMatch(actualColor, expectedColor)) {
            failures.push(
              `orientation ${orientation}, cell (row ${y}, col ${x}): expected rgb(${expectedColor}), got rgb(${actualColor})`,
            );
          }
        }
      }
    }
  } finally {
    await close();
  }

  if (failures.length > 0) {
    console.error('Browser orientation smoke test FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('Browser orientation smoke test passed: all 8 EXIF orientations verified against real Chrome pixels.');
}

main().catch((err) => {
  console.error('Browser orientation smoke test errored:', err);
  process.exitCode = 1;
});
