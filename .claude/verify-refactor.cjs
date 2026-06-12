/* Smoke-verify the src/ module refactor: app boots with zero console errors,
 * orbit view renders, surface walk works (grass/water/props update loop),
 * star map opens, exit returns to orbit. Screenshots into .claude/. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8127;
const OUT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(req.url); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => errors.push(`[REQFAIL] ${r.url()}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'refactor-1-boot.png') });
  logs.push(`boot errors: ${errors.length}`);

  // Down to planet level (Earth is default home focus).
  await page.click('#navDown');
  await page.waitForTimeout(1500);
  const focusName = await page.$eval('#navFocusName', el => el.textContent || '').catch(() => 'n/a');
  logs.push(`planet focus: ${focusName}`);
  await page.screenshot({ path: path.join(OUT, 'refactor-2-planet.png') });

  // Visit surface: click outward from center until we land.
  await page.click('#navVisit');
  await page.waitForTimeout(400);
  const offsets = [];
  for (let r = 0; r <= 240; r += 40)
    for (let a = 0; a < (r ? 8 : 1); a++)
      offsets.push([Math.round(r * Math.cos(a * Math.PI / 4)), Math.round(r * Math.sin(a * Math.PI / 4))]);
  let landed = false;
  for (const [dx, dy] of offsets) {
    await page.mouse.click(640 + dx, 400 + dy);
    await page.waitForTimeout(500);
    if (await page.evaluate(() => document.body.classList.contains('surface-mode'))) { landed = true; break; }
  }
  logs.push(`landed: ${landed}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'refactor-3-surface.png') });

  if (landed) {
    // Walk forward a few seconds, then jump — exercises walk/ground/footprints.
    await page.keyboard.down('w');
    await page.waitForTimeout(2500);
    await page.keyboard.up('w');
    await page.keyboard.press('Space');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'refactor-4-walked.png') });
    const diag = await page.evaluate(() => window.grassDiag && window.grassDiag());
    logs.push('grassDiag: ' + JSON.stringify(diag));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    const back = await page.evaluate(() => !document.body.classList.contains('surface-mode'));
    logs.push(`exited to orbit: ${back}`);
  }

  // Star map: navUp twice (system → constellation → shows map overlay).
  await page.click('#navUp');
  await page.waitForTimeout(1200);
  await page.click('#navUp');
  await page.waitForTimeout(1200);
  const mapVisible = await page.evaluate(() => {
    const el = document.getElementById('mapOverlay');
    return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  });
  logs.push(`map overlay visible: ${mapVisible}`);
  await page.screenshot({ path: path.join(OUT, 'refactor-5-starmap.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'refactor-6-back.png') });

  console.log('=== LOGS ===');
  logs.forEach(l => console.log(l));
  console.log('=== ERRORS (' + errors.length + ') ===');
  errors.slice(0, 40).forEach(e => console.log(e));
  await browser.close();
  server.close();
  process.exit(0);
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
