// Render the title and closing cards (1920x1080 PNG) with headless Chromium.
// Usage: node demo/titlecards.mjs [outDir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const DEMO = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DEMO, 'build', 'cards');

const base = `
<style>
  :root { --ink:#06080C; --ink2:#0E121A; --line:rgba(255,255,255,.07); --text:#F2F5F9; --mute:#8A95A8;
          --amber:#FFB224; --teal:#2DD4BF; --rose:#F43F5E; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { width:1920px; height:1080px; background:var(--ink); color:var(--text);
    font-family:'Inter Variable','Inter',system-ui,sans-serif; -webkit-font-smoothing:antialiased; overflow:hidden; }
  .bg { position:absolute; inset:0;
    background:
      radial-gradient(900px 600px at 82% 18%, rgba(255,178,36,.13), transparent 60%),
      radial-gradient(800px 600px at 10% 95%, rgba(45,212,191,.10), transparent 60%),
      linear-gradient(180deg, #0A0D13, #06080C); }
  .grid { position:absolute; inset:0; opacity:.55;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 64px 64px; mask-image: radial-gradient(1200px 800px at 50% 40%, #000 30%, transparent 85%); }
  .wrap { position:absolute; inset:0; padding:110px 140px 190px; display:flex; flex-direction:column; }
  .logo { display:flex; align-items:center; gap:22px; }
  .mark { width:68px; height:68px; border-radius:18px; background:linear-gradient(135deg,var(--amber),#F59E0B);
    box-shadow:0 0 0 1px rgba(255,178,36,.4), 0 0 48px -6px rgba(255,178,36,.55); display:grid; place-items:center; }
  .mark svg { width:40px; height:40px; }
  .brand { font-size:40px; font-weight:700; letter-spacing:-.02em; }
  .pill { display:inline-flex; gap:12px; align-items:center; font-size:22px; color:var(--mute);
    border:1px solid var(--line); background:rgba(255,255,255,.03); padding:10px 20px; border-radius:999px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--teal); box-shadow:0 0 12px var(--teal); }
  h1 { font-size:112px; line-height:1.0; letter-spacing:-.045em; font-weight:800; }
  h1 em { font-style:normal; color:var(--amber); }
  .sub { font-size:36px; color:#B7C0CF; line-height:1.35; font-weight:400; max-width:1300px; }
  .mono { font-family:'JetBrains Mono','DejaVu Sans Mono',monospace; }
  .tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:28px; }
  .tile { border:1px solid var(--line); background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));
    border-radius:22px; padding:34px 32px; min-height:250px; }
  .tile .k { font-size:50px; font-weight:800; letter-spacing:-.03em; line-height:1.05; }
  .tile .v { margin-top:16px; font-size:24px; color:var(--mute); line-height:1.4; }
  .amber { color:var(--amber); } .teal { color:var(--teal); } .rose { color:var(--rose); }
  .foot { margin-top:auto; display:flex; justify-content:space-between; align-items:flex-end; color:var(--mute); font-size:22px; }
  .risk { display:flex; gap:24px; margin-top:56px; }
  .chip { border:1px solid var(--line); border-radius:16px; padding:18px 26px; font-size:26px; color:#DDE3EC;
    background:rgba(255,255,255,.03); }
  .chip b { color:var(--amber); font-weight:700; }
</style>
<div class="bg"></div><div class="grid"></div>`;

const mark = `<div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#06080C" stroke-width="2.4"
  stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/>
  <path d="M9 21v-6h6v6"/></svg></div>`;

const cards = {
  title: `${base}
  <div class="wrap">
    <div class="logo">${mark}<div class="brand">SiteMind</div>
      <div style="margin-left:auto" class="pill"><span class="dot"></span>Kaya AI Grand Challenge · Ed. 2 · Track 01 AGI</div></div>
    <div style="margin-top:120px">
      <h1>The procurement agent that<br/><em>doesn't forget</em> the job.</h1>
      <p class="sub" style="margin-top:40px">A durable, long-horizon agent that plans, calls specialists, survives crashes
        and asks a human before anything irreversible.</p>
      <div class="risk">
        <div class="chip">Project Alpha · <b>24 MW</b> Tier-III data centre · Pune</div>
        <div class="chip">#1 schedule risk: <b>480 V switchgear</b></div>
      </div>
    </div>
    <div class="foot"><span>Runs offline · local model via Ollama</span><span class="mono">sitemind · demo</span></div>
  </div>`,
  closing: `${base}
  <div class="wrap">
    <div class="logo">${mark}<div class="brand">SiteMind</div></div>
    <h1 style="margin-top:90px; font-size:96px">From weeks of chasing<br/>to <em>minutes</em>.</h1>
    <div class="tiles" style="margin-top:80px">
      <div class="tile"><div class="k amber">Weeks → min</div><div class="v">Plan, RFQs, evaluation, re-plan and PO in one supervised run.</div></div>
      <div class="tile"><div class="k teal">Audited</div><div class="v">Every action, specialist call, LLM call and rupee logged with its source.</div></div>
      <div class="tile"><div class="k">Crash-proof</div><div class="v">Checkpoint after every task; idempotent ledger — never the same action twice.</div></div>
      <div class="tile"><div class="k">Open source</div><div class="v">MIT · runs on a laptop with a local Qwen2.5 model. No data leaves the site.</div></div>
    </div>
    <div class="foot"><span>Human sign-off before anything irreversible · MCP-callable specialists</span>
      <span class="mono">Track 01 · AGI</span></div>
  </div>`,
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const [name, html] of Object.entries(cards)) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('[cards]', file);
}
await browser.close();
