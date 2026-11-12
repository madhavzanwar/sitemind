// Drive the real SiteMind dashboard through every scene of demo/script.yaml and record it.
//
// Usage: node demo/record.mjs [--base http://localhost:8000] [--out demo/build/rec]
//
// Output: <out>/video.webm (1920x1080) and <out>/scenes.json with each scene's start/end (seconds
// from the start of video.webm), the run id, warnings and the final RunSnapshot.
//
// Action DSL (per scene in script.yaml, `actions:`):
//   goto {path}                      navigate
//   wait_selector {testid, timeout}  wait for an element
//   highlight {testid, hold}         glide the fake cursor to it + amber ring, hold seconds
//   highlight_text {text, fallback_testid, hold}
//   click {testid, optional}         glide + click
//   type {testid, text?, delay}      retype a field (default: its current value)
//   scroll {testid, dy}              wheel-scroll over an element
//   launch / kill / resume           click the button (falls back to the REST API)
//   approve                          approve the first pending approval (UI, else API)
//   approve_all {until, timeout}     keep approving pending approvals until `until` holds
//   wait_run {until, timeout, optional}  poll GET /api/runs/{id} until JS expr on `s` is true
//   pause {s}
//   hold_narration {early}         sleep until the scene's narration is (nearly) over
// Every scene lasts at least its narration length (demo/build/narration.json) + scene_tail_s.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const DEMO = path.dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

// Minimal YAML load via python (PyYAML) to avoid a node dependency.
import { execFileSync } from 'node:child_process';
const scriptPath = arg('script', path.join(DEMO, 'script.yaml'));
const SCRIPT = JSON.parse(execFileSync('python3', ['-c',
  'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1])),default=str))', scriptPath]).toString());
const META = SCRIPT.meta || {};
const BASE = arg('base', process.env.SITEMIND_URL || META.base_url || 'http://localhost:8000');
const OUT = arg('out', path.join(DEMO, 'build', 'rec'));
const narrPath = path.join(DEMO, 'build', 'narration.json');
const NARR = fs.existsSync(narrPath) ? JSON.parse(fs.readFileSync(narrPath, 'utf8')) : { scenes: [] };
const narrDur = (id) => (NARR.scenes.find((s) => s.id === id) || {}).duration || 6;
const TAIL = Number(META.scene_tail_s ?? 0.6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[rec ${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ------------------------------------------------------------------ overlay (fake cursor + ring)
const OVERLAY = `(() => {
  if (window.__smOverlay) return; window.__smOverlay = true;
  const css = \`
    #__sm_cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;
      transform:translate(960px,540px);transition:transform .05s linear;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))}
    #__sm_ripple{position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;
      border-radius:50%;border:3px solid #FFB224;opacity:0}
    #__sm_ripple.go{animation:__smr .55s ease-out}
    @keyframes __smr{from{opacity:.95;transform:scale(.3)}to{opacity:0;transform:scale(1.6)}}
    #__sm_ring{position:fixed;z-index:2147483645;pointer-events:none;border-radius:14px;opacity:0;
      border:3px solid #FFB224;box-shadow:0 0 0 6px rgba(255,178,36,.18),0 0 40px rgba(255,178,36,.45);
      transition:all .35s cubic-bezier(.2,.8,.2,1)}\`;
  const add = () => {
    if (document.getElementById('__sm_cursor')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id='__sm_cursor';
    c.innerHTML='<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l16 9.5-7 1.6L9.6 21z" fill="#fff" stroke="#06080C" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const r = document.createElement('div'); r.id='__sm_ripple';
    const g = document.createElement('div'); g.id='__sm_ring';
    document.body.append(g, r, c);
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', add) : add();
  window.addEventListener('mousemove', (e) => { add(); const c=document.getElementById('__sm_cursor');
    c.style.transform='translate('+(e.clientX-4)+'px,'+(e.clientY-2)+'px)'; }, true);
  window.addEventListener('mousedown', (e) => { const r=document.getElementById('__sm_ripple'); if(!r) return;
    r.style.left=e.clientX+'px'; r.style.top=e.clientY+'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); }, true);
  window.__smRing = (b, ms) => { add(); const g=document.getElementById('__sm_ring'); const p=8;
    Object.assign(g.style,{left:(b.x-p)+'px',top:(b.y-p)+'px',width:(b.width+2*p)+'px',height:(b.height+2*p)+'px',opacity:1});
    clearTimeout(window.__smRingT); window.__smRingT=setTimeout(()=>{g.style.opacity=0}, ms); };
})();`;

// ------------------------------------------------------------------ run state helpers
let RUN_ID = null;
let LAST = null;
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${await res.text().catch(() => '')}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}
async function snapshot() {
  if (!RUN_ID) {
    const runs = await api('GET', '/api/runs');
    if (Array.isArray(runs) && runs.length) {
      runs.sort((a, b) => String(a.run_id).localeCompare(String(b.run_id)));
      RUN_ID = runs[runs.length - 1].run_id;
    } else return null;
  }
  LAST = await api('GET', `/api/runs/${RUN_ID}`);
  return LAST;
}
function evalCond(expr, s) {
  try { return !!new Function('s', `return (${expr});`)(s); } catch { return false; }
}
async function waitRun(expr, timeoutS = 120) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    try { const s = await snapshot(); if (s && evalCond(expr, s)) return true; } catch (e) { /* server busy */ }
    await sleep(500);
  }
  return false;
}

// ------------------------------------------------------------------ page helpers
const tid = (page, id) => page.locator(`[data-testid="${id}"]`).first();
let cursor = { x: 960, y: 540 };
async function glide(page, x, y, ms = 700) {
  const steps = Math.max(8, Math.round(ms / 16));
  const sx = cursor.x, sy = cursor.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(ms / steps);
  }
  cursor = { x, y };
}
async function focus(page, loc, holdS = 1.5, { click = false } = {}) {
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await sleep(250);
  const b = await loc.boundingBox();
  if (!b) throw new Error('element not visible');
  const cx = b.x + Math.min(b.width / 2, 260), cy = b.y + Math.min(b.height / 2, 120);
  await glide(page, cx, cy);
  await page.evaluate(([bb, ms]) => window.__smRing && window.__smRing(bb, ms), [b, holdS * 1000 + 300]);
  if (click) { await sleep(200); await loc.click({ timeout: 5000 }); }
  await sleep(holdS * 1000);
}

async function clickOrApi(page, testid, fallback) {
  try {
    const loc = tid(page, testid);
    await loc.waitFor({ state: 'visible', timeout: 6000 });
    await focus(page, loc, 0.4, { click: true });
    return 'ui';
  } catch (e) {
    log(`  ! ${testid} not clickable (${e.message.split('\n')[0]}); using API`);
    await fallback();
    return 'api';
  }
}

async function approveOnce(page) {
  const s = await snapshot();
  const pending = (s?.approvals || []).find((a) => a.status === 'pending');
  if (!pending) return false;
  await tid(page, 'tab-approvals').click({ timeout: 3000 }).catch(() => {});
  await sleep(600);
  await clickOrApi(page, 'approve-button', async () => {
    const option = pending.memo?.recommendation || pending.options?.[0] || null;
    await api('POST', `/api/runs/${RUN_ID}/approvals/${encodeURIComponent(pending.id)}`,
      { decision: 'approve', option_id: option, comment: 'Approved in demo', decided_by: 'project.manager@alpha' });
  });
  // wait until that approval is no longer pending
  await waitRun(`(s.approvals||[]).every(a => a.id !== ${JSON.stringify(pending.id)} || a.status !== 'pending')`, 20);
  return true;
}

async function doAction(page, a, warnings, ctx = {}) {
  const opt = !!a.optional;
  const fail = (msg) => { if (!opt) { warnings.push(msg); log('  WARN', msg); } else log('  (optional)', msg); };
  switch (a.do) {
    case 'goto':
      await page.goto(BASE + (a.path || '/'), { waitUntil: 'load' });
      await sleep(800);
      break;
    case 'wait_selector':
      await tid(page, a.testid).waitFor({ state: 'visible', timeout: (a.timeout || 20) * 1000 }).catch(() => fail(`wait_selector ${a.testid}`));
      break;
    case 'highlight':
      await focus(page, tid(page, a.testid), a.hold ?? 1.5).catch((e) => fail(`highlight ${a.testid}: ${e.message.split('\n')[0]}`));
      break;
    case 'highlight_text': {
      const loc = page.getByText(a.text, { exact: false }).first();
      const ok = await loc.isVisible().catch(() => false);
      await focus(page, ok ? loc : tid(page, a.fallback_testid), a.hold ?? 1.5).catch((e) => fail(`highlight_text ${a.text}: ${e.message}`));
      break;
    }
    case 'click':
      await focus(page, tid(page, a.testid), a.hold ?? 0.4, { click: true }).catch((e) => fail(`click ${a.testid}: ${e.message.split('\n')[0]}`));
      await sleep(500);
      break;
    case 'type': { // retype a field visibly (the value is usually prefilled from /api/demo/defaults)
      const loc = tid(page, a.testid);
      try {
        await focus(page, loc, 0.3, { click: true });
        let text = a.text;
        if (!text) text = await loc.inputValue();
        await loc.fill('');
        await loc.pressSequentially(text, { delay: a.delay ?? 22 });
        await sleep(400);
      } catch (e) { fail(`type ${a.testid}: ${e.message.split('\n')[0]}`); }
      break;
    }
    case 'scroll': {
      const b = await tid(page, a.testid).boundingBox().catch(() => null);
      if (!b) { fail(`scroll ${a.testid}`); break; }
      await glide(page, b.x + Math.min(b.width / 2, 300), Math.min(b.y + 200, 900), 400);
      const dy = a.dy || 300;
      for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, dy / 12); await sleep(40); }
      await sleep(600);
      break;
    }
    case 'launch': {
      const respP = page.waitForResponse((r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
      const how = await clickOrApi(page, 'launch-button', async () => {
        const d = await api('GET', '/api/demo/defaults');
        const r = await api('POST', '/api/runs', d);
        RUN_ID = r.run_id;
        await page.reload({ waitUntil: 'load' });
      });
      if (how === 'ui') {
        const resp = await respP;
        if (resp) { try { RUN_ID = (await resp.json()).run_id; } catch { /* ignore */ } }
      }
      if (!RUN_ID) await snapshot();
      log(`  run id ${RUN_ID} (${how})`);
      await sleep(800);
      break;
    }
    case 'kill':
      await clickOrApi(page, 'kill-button', () => api('POST', `/api/runs/${RUN_ID}/kill`));
      log('  worker killed');
      break;
    case 'resume':
      await clickOrApi(page, 'resume-button', () => api('POST', `/api/runs/${RUN_ID}/resume`));
      log('  worker resumed');
      break;
    case 'approve':
      if (!(await approveOnce(page))) fail('approve: nothing pending');
      break;
    case 'approve_all': {
      const end = Date.now() + (a.timeout || 180) * 1000;
      while (Date.now() < end) {
        const s = await snapshot().catch(() => null);
        if (s && evalCond(a.until, s)) break;
        if (s && (s.approvals || []).some((x) => x.status === 'pending')) await approveOnce(page);
        else if (s && s.status === 'killed') await api('POST', `/api/runs/${RUN_ID}/resume`).catch(() => {});
        await sleep(700);
      }
      if (!evalCond(a.until, LAST || {})) fail(`approve_all: ${a.until}`);
      break;
    }
    case 'wait_run':
      if (!(await waitRun(a.until, a.timeout || 120))) fail(`wait_run timeout: ${a.until}`);
      break;
    case 'pause':
      await sleep((a.s || 1) * 1000);
      break;
    case 'hold_narration': { // wait until the scene has lasted its narration (minus `early` seconds)
      const remain = ctx.minS - (a.early || 0) - ((Date.now() - T0) / 1000 - ctx.start);
      if (remain > 0) await sleep(remain * 1000);
      break;
    }
    default:
      fail(`unknown action ${a.do}`);
  }
}

// ------------------------------------------------------------------ main
let T0 = Date.now();
fs.mkdirSync(OUT, { recursive: true });
const tmpVid = path.join(OUT, 'raw');
fs.rmSync(tmpVid, { recursive: true, force: true });

const health = await api('GET', '/api/health').catch((e) => ({ error: String(e) }));
console.log('[rec] health', JSON.stringify(health));

const launchOpts = {};
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: tmpVid, size: { width: 1920, height: 1080 } },
  colorScheme: 'dark',
});
await context.addInitScript(OVERLAY);
const page = await context.newPage();
page.setDefaultTimeout(4000);
T0 = Date.now(); // video timeline starts with the page
await page.goto(BASE + '/', { waitUntil: 'load' }).catch((e) => log('goto failed', e.message));
await page.mouse.move(cursor.x, cursor.y);
await sleep(1500);

const scenes = [];
for (const sc of SCRIPT.scenes) {
  if (sc.card) { scenes.push({ id: sc.id, title: sc.title, card: sc.card }); continue; }
  const start = (Date.now() - T0) / 1000;
  const minS = Math.max(Number(sc.min_s || 0), narrDur(sc.id) + TAIL);
  const warnings = [];
  log(`scene ${sc.id} "${sc.title}" (min ${minS.toFixed(1)}s)`);
  for (const a of sc.actions || []) {
    try { await doAction(page, a, warnings, { start, minS }); } catch (e) { warnings.push(`${a.do}: ${e.message}`); log('  ERR', a.do, e.message); }
  }
  const remain = minS - ((Date.now() - T0) / 1000 - start);
  if (remain > 0) await sleep(remain * 1000);
  const end = (Date.now() - T0) / 1000;
  const s = await snapshot().catch(() => null);
  scenes.push({ id: sc.id, title: sc.title, start: +start.toFixed(3), end: +end.toFixed(3),
    status: s?.status, sim_now: s?.sim_now, plan_version: s?.plan?.version, warnings });
  log(`scene ${sc.id} done ${(end - start).toFixed(1)}s status=${s?.status} warnings=${warnings.length}`);
}
await sleep(500);
const vidPath = await page.video().path();
await context.close();
await browser.close();
const finalVideo = path.join(OUT, 'video.webm');
fs.renameSync(vidPath, finalVideo);
fs.rmSync(tmpVid, { recursive: true, force: true });
const final = await snapshot().catch(() => LAST);
fs.writeFileSync(path.join(OUT, 'final_snapshot.json'), JSON.stringify(final, null, 2));
fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify({ video: finalVideo, run_id: RUN_ID, base: BASE, scenes }, null, 2));
const nWarn = scenes.reduce((n, s) => n + (s.warnings?.length || 0), 0);
console.log(`[rec] done -> ${finalVideo} (${scenes.length} scenes, ${nWarn} warnings, final status ${final?.status})`);
