#!/usr/bin/env node
// Prepare the Windows desktop icon from assets/icon.png.
//
// The source logo is not square, but .ico images must be. This pads the logo
// onto a square transparent canvas, resizes to 256x256, and writes
// assets/icon.ico (used by electron-builder for the installer + shortcut).

import { Jimp } from 'jimp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(ROOT, 'assets', 'icon.png');
const OUT = resolve(ROOT, 'assets', 'icon.ico');

const logo = await Jimp.read(SRC);
const side = Math.max(logo.width, logo.height);

const canvas = new Jimp({ width: side, height: side, color: 0x00000000 });
canvas.composite(logo, Math.floor((side - logo.width) / 2), Math.floor((side - logo.height) / 2));
canvas.resize({ w: 256, h: 256 });

const pngBuffer = await canvas.getBuffer('image/png');
const icoBuffer = await pngToIco(pngBuffer);
writeFileSync(OUT, icoBuffer);

console.log(`Wrote ${OUT} (${icoBuffer.length.toLocaleString()} bytes, 256x256)`);
