// Renders slides.html to ../SiteMind_pitch.pdf (1920x1080 per page) and png/slide-NN.png.
// Usage: node submission/deck/render.mjs      (Playwright + Chromium must already be installed)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = createRequire(path.resolve('frontend/package.json'))('playwright')); }

const here = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.join(here, 'slides.html')).href;
const pdf = path.resolve(here, '..', 'SiteMind_pitch.pdf');
const pngDir = path.join(here, 'png');
fs.mkdirSync(pngDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(html);
await page.evaluate(() => document.fonts.ready);
await page.emulateMedia({ media: 'print' });

// Report any slide whose content overflows its 1080px frame.
const report = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((s, i) => {
  const foot = s.querySelector('.foot').getBoundingClientRect().top;
  const r = s.getBoundingClientRect();
  let bottom = 0, right = 0;
  s.querySelectorAll(':scope > :not(.foot), :scope > :not(.foot) *').forEach((e) => {
    const b = e.getBoundingClientRect();
    if (b.width && b.height) { bottom = Math.max(bottom, b.bottom); right = Math.max(right, b.right - r.left); }
  });
  return { slide: i + 1, gapToFooter: Math.round(foot - bottom), right: Math.round(right) };
}));
for (const r of report) console.log(`slide ${r.slide}: gap to footer ${r.gapToFooter}px, right edge ${r.right}px${r.gapToFooter < 8 || r.right > 1826 ? '   <-- CHECK' : ''}`);

const slides = await page.$$('.slide');
for (let i = 0; i < slides.length; i++) {
  await slides[i].screenshot({ path: path.join(pngDir, `slide-${String(i + 1).padStart(2, '0')}.png`) });
}
await page.pdf({ path: pdf, width: '1920px', height: '1080px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
console.log(`${slides.length} slides -> ${pdf}`);
