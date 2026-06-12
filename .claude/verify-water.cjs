/* Verify the water enhancements: surface water look (fresnel/ripples/foam),
 * underwater murk + overlay when the camera dips below the sea, wave-riding
 * buoyancy while swimming, and a clean return to orbit. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8125;
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

  await page.click('#navDown');
  await page.waitForTimeout(1500);
  for (let i = 0; i < 9; i++) {
    const sub = await page.$eval('#navFocusSub', el => el.textContent || '');
    if (/terrestrial/i.test(sub)) break;
    await page.click('#navRight');
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(1000);
  await page.click('#navVisit');
  await page.waitForTimeout(300);

  const offsets = [];
  for (let r = 0; r <= 240; r += 40)
    for (let a = 0; a < (r ? 8 : 1); a++)
      offsets.push([Math.round(r * Math.cos(a * Math.PI / 4)), Math.round(r * Math.sin(a * Math.PI / 4))]);
  let on = false;
  for (const [dx, dy] of offsets) {
    await page.mouse.click(640 + dx, 400 + dy);
    await page.waitForTimeout(500);
    on = await page.evaluate(() => document.body.classList.contains('surface-mode'));
    if (on) break;
  }
  logs.push(`-- onSurface: ${on}`);
  const shot = async (name) => {
    const op = await page.$eval('#underwaterOverlay', el => getComputedStyle(el).opacity);
    logs.push(`-- shot ${name}: overlayOpacity=${op}`);
    await page.screenshot({ path: path.join(OUT, name) });
  };
  if (on) {
    await page.waitForTimeout(2500);
    await shot('water-1-shore.png');

    // March seaward; grab a wade shot the moment the seabed drops below the
    // waterline (the trailing camera is usually submerged here). If the depth
    // stalls (sandbar / shoal), drag-yaw ~60° and keep marching.
    await page.keyboard.down('w');
    let depthH = 9, waded = false, lastH = 9, turn = 1;
    for (let t = 0; t < 24; t++) {
      await page.waitForTimeout(1500);
      depthH = await page.evaluate(() => {
        const d = window.grassDiag && window.grassDiag();
        return d && d.probe && d.probe.heightAvg ? parseFloat(d.probe.heightAvg) : 9;
      });
      logs.push(`-- t=${(t + 1) * 1.5}s heightAvg=${depthH}`);
      if (!waded && depthH < -0.05) {
        await shot('water-2-wade.png');
        waded = true;
      }
      if (depthH < -0.3) break;
      if (depthH >= lastH - 0.005) {     // not getting deeper — steer
        await page.mouse.move(640, 400);
        await page.mouse.down();
        await page.mouse.move(640 + 170 * turn, 400, { steps: 8 });
        await page.mouse.up();
        turn = -turn;
        logs.push('-- steered');
      }
      lastH = depthH;
    }
    await page.keyboard.up('w');
    await page.waitForTimeout(2000);     // settle into tread (buoyancy bob)
    await shot('water-3-tread.png');
    await page.waitForTimeout(900);      // ~1 swell later: bob should move us
    await shot('water-4-tread-bob.png');

    // Drag-pitch the view so the third-person camera plunges below the surface
    // — this is the "completely transparent underwater" repro. Try both drag
    // directions and keep shots of each.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640, 700, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    await shot('water-5-pitchA.png');
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640, 100, { steps: 24 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    await shot('water-6-pitchB.png');

    await page.keyboard.press('Escape'); // back to orbit
    await page.waitForTimeout(1500);
    await shot('water-7-orbit.png');
  }
  fs.writeFileSync(path.join(OUT, 'verify-water-log.txt'), logs.join('\n'));
  await browser.close();
  server.close();
  console.log(logs.filter(l => /error|--/i.test(l)).join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
