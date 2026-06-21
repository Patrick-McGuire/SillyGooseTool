#!/usr/bin/env node
// Build the desktop icon from assets/icon-source.png (the original opaque logo).
//
// 1. Flood-fill the *exterior* white background to transparent, starting from the
//    image border. White regions enclosed by the black line art (the goose's
//    body, face, etc.) are NOT border-connected, so they stay white. Black lines
//    block the flood, so they stay black.
// 2. Pad to a square transparent canvas and resize to 256x256.
// 3. Write assets/icon.png (transparent) and assets/icon.ico (electron-builder).

import { Jimp } from 'jimp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(ROOT, 'assets', 'icon-source.png');
const OUT_PNG = resolve(ROOT, 'assets', 'icon.png');
const OUT_ICO = resolve(ROOT, 'assets', 'icon.ico');

// A pixel counts as "background-ish" (floodable) if it's light. The black line
// art is well below this, so it walls off the interior.
const LIGHT_THRESHOLD = 160;

const img = await Jimp.read(SRC);
const { width, height, data } = img.bitmap;

const isLight = (idx) => (data[idx] + data[idx + 1] + data[idx + 2]) / 3 > LIGHT_THRESHOLD;

const visited = new Uint8Array(width * height);
const stack = [];
const seed = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  stack.push(y * width + x);
};

// Seed every border pixel.
for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

// Flood through connected light pixels, clearing their alpha to transparent.
while (stack.length) {
  const p = stack.pop();
  if (visited[p]) continue;
  const idx = p * 4;
  if (!isLight(idx)) continue;
  visited[p] = 1;
  data[idx + 3] = 0; // transparent
  const x = p % width;
  const y = (p - x) / width;
  seed(x - 1, y); seed(x + 1, y); seed(x, y - 1); seed(x, y + 1);
}

// Pad onto a square transparent canvas, then size down to a crisp 256.
const side = Math.max(width, height);
const canvas = new Jimp({ width: side, height: side, color: 0x00000000 });
canvas.composite(img, Math.floor((side - width) / 2), Math.floor((side - height) / 2));
canvas.resize({ w: 256, h: 256 });

const pngBuffer = await canvas.getBuffer('image/png');
writeFileSync(OUT_PNG, pngBuffer);
const icoBuffer = await pngToIco(pngBuffer);
writeFileSync(OUT_ICO, icoBuffer);

console.log(`Wrote ${OUT_PNG} + ${OUT_ICO} (256x256, transparent background)`);
