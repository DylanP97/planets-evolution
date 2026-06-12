/* Verify the Venusian overhaul: dark basaltic biomes from orbit, black rocky
 * ground + gravel/boulder field on the surface, and boot prints left in the
 * soil while walking (visible after turning around to face the trail). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8126;
const OUT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Focus the planet level, then cycle to the venusian world (Venus).
  await page.click('#navDown');
  await page.waitForTimeout(1500);
  let found = false;
  for (let i = 0; i < 10; i++) {
    const sub = await page.$eval('#navFocusSub', el => el.textContent || '');
    if (/venusian/i.test(sub)) { found = true; break; }
    await page.click('#navRight');
    await page.waitForTimeout(1200);
  }
  logs.push(`-- venusFound: ${found}`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'venus-1-orbit.png') });

  // Scan clicks outward from screen centre until one lands on the surface.
  const offsets = [];
  for (let r = 0; r <= 240; r += 40)
    for (let a = 0; a < (r ? 8 : 1); a++)
      offsets.push([Math.round(r * Math.cos(a * Math.PI / 4)), Math.round(r * Math.sin(a * Math.PI / 4))]);
  const tryLand = async () => {
    for (const [dx, dy] of offsets) {
      await page.mouse.click(640 + dx, 400 + dy);
      await page.waitForTimeout(500);
      if (await page.evaluate(() => document.body.classList.contains('surface-mode'))) return true;
    }
    return false;
  };
  // Land, and if we came down on the night side (sunElev ≤ 0), exit, nudge the
  // orbit view, and re-pick — the screenshots are useless in the dark.
  let on = false;
  for (let attempt = 0; attempt < 6 && !on; attempt++) {
    await page.click('#navVisit');
    await page.waitForTimeout(300);
    if (!(await tryLand())) break;
    await page.waitForTimeout(1200);
    const elev = await page.evaluate(() => window.footDiag && window.footDiag().sunElev);
    logs.push(`-- attempt ${attempt}: sunElev=${elev}`);
    if (elev != null && elev > 0.1) { on = true; break; }
    await page.keyboard.press('Escape');           // night side — go around
    await page.waitForTimeout(1200);
    await page.mouse.move(640, 400);               // orbit-drag to swing the view
    await page.mouse.down();
    await page.mouse.move(340, 400, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  logs.push(`-- onSurface(day): ${on}`);

  const diag = async (tag) => {
    const d = await page.evaluate(() => window.footDiag && window.footDiag());
    logs.push(`-- footDiag ${tag}: ${JSON.stringify(d)}`);
  };
  const dragYaw = async (px) => {           // horizontal mouse-look drag
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640 + px, 400, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  };

  if (on) {
    await page.waitForTimeout(2500);
    await diag('landed');
    await page.screenshot({ path: path.join(OUT, 'venus-2-surface.png') });

    // Walk forward ~3.5 s so a trail of prints accumulates behind the avatar.
    // (Headless renders at a few fps, so wall time ages the prints fast — keep
    // everything between here and the trail screenshot tight.)
    await page.keyboard.down('w');
    await page.waitForTimeout(3500);
    await page.keyboard.up('w');
    await diag('walked');

    // Turn ~180° to face the trail (look speed 0.0035 rad/px → ~900 px).
    await dragYaw(450);
    await dragYaw(450);
    // Pitch down a touch so the near ground fills the frame.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640, 250, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'venus-4-trail.png') });

    // Jump: landing should punch a double print.
    await page.keyboard.press('Space');
    await page.waitForTimeout(1800);
    await diag('jumped');
    await page.screenshot({ path: path.join(OUT, 'venus-5-jump-land.png') });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'venus-6-orbit-after.png') });
  }
  fs.writeFileSync(path.join(OUT, 'verify-venus-log.txt'), logs.join('\n'));
  await browser.close();
  server.close();
  console.log(logs.filter(l => /error|--/i.test(l)).join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
