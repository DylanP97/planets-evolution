    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    // ---------- Planet constants ----------
    const BASE_RADIUS = 12;          // resting radius of the icosphere (sea-level land has h = 0)
    const SEA_LEVEL   = 0.0;         // ocean sphere sits at BASE_RADIUS + SEA_LEVEL
    const OCEAN_RADIUS = BASE_RADIUS + SEA_LEVEL;
    const ICO_DETAIL  = 5;           // ~10242 verts; brush feels smooth at this density

    // Biome height bands (relative to sea level). Below sea level is hidden by the
    // water sphere, so colors there only show if the brush carves below water.
    const SAND_TOP   = 0.25;
    const GRASS_TOP  = 1.2;
    const ROCK_TOP   = 2.4;
    // Above ROCK_TOP we fade into snow over SNOW_FADE units.
    const SNOW_FADE  = 0.4;

    const COL = {
      water:     0x3FA1DC,
      deep:      0x12243a,
      shore:     0x8fb4c8,
      sand:      0xEDDFB8,
      grass:     0x4FAE4F,
      grassDark: 0x2f7a36,
      rock:      0x7d6a5a,
      snow:      0xf0f4f8,
    };

    // ---------- Scene ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02030a);

    const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 600);
    camera.position.set(0, 15, 28);

    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    // Paint mode default ON — right-button is reserved for the brush, not pan.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // Sun is the only light source — night side stays black.
    const SUN_DIRECTION = new THREE.Vector3(1, 0.35, 0.6).normalize();
    const SUN_DISTANCE = 80;
    const sun = new THREE.DirectionalLight(0xfff1d4, 1.50);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -16;
    sun.shadow.camera.near = SUN_DISTANCE - BASE_RADIUS - 4;
    sun.shadow.camera.far  = SUN_DISTANCE + BASE_RADIUS + 8;
    scene.add(sun);

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(6, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false })
    );
    sunMesh.position.copy(SUN_DIRECTION).multiplyScalar(180);
    scene.add(sunMesh);

    // ---------- Planet group (rotates as a whole) ----------
    const planetGroup = new THREE.Group();
    scene.add(planetGroup);

    // Icosphere — every vertex stores its unit direction and a signed height offset.
    // Calling toNonIndexed gives us a flat vertex list with no shared indices, which
    // makes per-vertex coloring trivial (no shared color across faces).
    const planetGeo = new THREE.IcosahedronGeometry(BASE_RADIUS, ICO_DETAIL).toNonIndexed();
    const posAttr = planetGeo.attributes.position;
    const N = posAttr.count;

    const unitDirs = new Float32Array(N * 3);
    const heights  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = posAttr.array[3 * i];
      const y = posAttr.array[3 * i + 1];
      const z = posAttr.array[3 * i + 2];
      const inv = 1 / Math.hypot(x, y, z);
      unitDirs[3 * i]     = x * inv;
      unitDirs[3 * i + 1] = y * inv;
      unitDirs[3 * i + 2] = z * inv;
    }

    const colorArr = new Float32Array(N * 3);
    planetGeo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

    const planetMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: false,
    });
    const planetMesh = new THREE.Mesh(planetGeo, planetMat);
    planetMesh.castShadow = true;
    planetMesh.receiveShadow = true;
    planetGroup.add(planetMesh);

    // Ocean — a smooth sphere just above base radius. Land that pokes above it shows;
    // anything below stays hidden inside the sphere.
    const matWater = new THREE.MeshStandardMaterial({
      color: COL.water,
      roughness: 0.30,
      metalness: 0.05,
      transparent: true,
      opacity: 0.92,
    });
    const oceanMesh = new THREE.Mesh(
      new THREE.SphereGeometry(OCEAN_RADIUS, 96, 64),
      matWater
    );
    oceanMesh.receiveShadow = true;
    planetGroup.add(oceanMesh);

    function smoothstep(a, b, x) {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    // Color every vertex once based on its height.
    function colorVertex(i) {
      const h = heights[i];
      let r, g, b;

      if (h < -0.4) {
        ({ r, g, b } = new THREE.Color(COL.deep));
      } else if (h < SEA_LEVEL) {
        const t = (h + 0.4) / (SEA_LEVEL + 0.4);
        const c = new THREE.Color(COL.deep).lerp(new THREE.Color(COL.shore), t);
        r = c.r; g = c.g; b = c.b;
      } else if (h < SAND_TOP) {
        ({ r, g, b } = new THREE.Color(COL.sand));
      } else if (h < GRASS_TOP) {
        const t = smoothstep(SAND_TOP, SAND_TOP + 0.15, h);
        const c = new THREE.Color(COL.sand).lerp(new THREE.Color(COL.grass), t);
        r = c.r; g = c.g; b = c.b;
      } else if (h < ROCK_TOP) {
        const t = smoothstep(GRASS_TOP, GRASS_TOP + 0.4, h);
        const c = new THREE.Color(COL.grass).lerp(new THREE.Color(COL.rock), t);
        r = c.r; g = c.g; b = c.b;
      } else {
        const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
        const c = new THREE.Color(COL.rock).lerp(new THREE.Color(COL.snow), t);
        r = c.r; g = c.g; b = c.b;
      }

      colorArr[3 * i]     = r;
      colorArr[3 * i + 1] = g;
      colorArr[3 * i + 2] = b;
    }

    function writeVertexPosition(i) {
      const r = BASE_RADIUS + heights[i];
      posAttr.array[3 * i]     = unitDirs[3 * i]     * r;
      posAttr.array[3 * i + 1] = unitDirs[3 * i + 1] * r;
      posAttr.array[3 * i + 2] = unitDirs[3 * i + 2] * r;
    }

    // Initial paint: all sea-floor color. Every vertex starts a bit below sea level
    // so the planet begins as an ocean world the user paints land into.
    for (let i = 0; i < N; i++) {
      heights[i] = -0.5;
      writeVertexPosition(i);
      colorVertex(i);
    }
    posAttr.needsUpdate = true;
    planetGeo.attributes.color.needsUpdate = true;
    planetGeo.computeVertexNormals();

    // ---------- Brush ----------
    let brushRadius   = 0.25; // radians of arc on the unit sphere
    let brushStrength = 1.5;  // height units per second of holding
    let brushRaise    = true; // false = lower
    let paintMode     = true; // when true, right-drag paints; when false, right-drag pans
    let paused        = false;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isPainting = false;
    let lastHitLocal = null; // hit point in planetGroup local space

    // Brush cursor — a thin ring oriented to the surface tangent plane.
    const brushRingGeo = new THREE.RingGeometry(0.95, 1.0, 64);
    const brushRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
    });
    const brushRing = new THREE.Mesh(brushRingGeo, brushRingMat);
    brushRing.renderOrder = 999;
    brushRing.visible = false;
    scene.add(brushRing);

    function updateBrushRing(hitWorld, hitNormalWorld, radiusWorld) {
      brushRing.position.copy(hitWorld);
      brushRing.lookAt(hitWorld.clone().add(hitNormalWorld));
      brushRing.position.addScaledVector(hitNormalWorld, 0.02);
      brushRing.scale.setScalar(radiusWorld);
      brushRing.visible = true;
    }

    // arcLen ≈ angularRadius * R, where R is the radial distance at the hit.
    function brushArcWorldRadius(hitRadius) {
      return brushRadius * hitRadius;
    }

    // Apply the brush to all vertices within the angular footprint.
    function applyBrush(centerLocal, dt) {
      const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
      const invLen = 1 / Math.hypot(cx, cy, cz);
      const ux = cx * invLen, uy = cy * invLen, uz = cz * invLen;

      const cosCut = Math.cos(brushRadius);
      const dir = brushRaise ? 1 : -1;
      const delta = dir * brushStrength * dt;

      let touchedAny = false;

      for (let i = 0; i < N; i++) {
        const dx = unitDirs[3 * i];
        const dy = unitDirs[3 * i + 1];
        const dz = unitDirs[3 * i + 2];
        const dot = dx * ux + dy * uy + dz * uz;
        if (dot <= cosCut) continue;

        const ang = Math.acos(Math.min(1, dot));
        const t = ang / brushRadius;
        const f = 1 - t * t;
        const falloff = f * f; // (1 - t^2)^2

        heights[i] += delta * falloff;
        writeVertexPosition(i);
        colorVertex(i);
        touchedAny = true;
      }

      if (touchedAny) {
        posAttr.needsUpdate = true;
        planetGeo.attributes.color.needsUpdate = true;
        planetGeo.computeVertexNormals();
      }
    }

    // ---------- Pointer handling ----------
    function setPointerFromEvent(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function raycastPlanet() {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(planetMesh, false);
      if (hits.length === 0) return null;
      return hits[0];
    }

    function worldToPlanetLocal(worldPoint) {
      return planetGroup.worldToLocal(worldPoint.clone());
    }

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      if (!paintMode) return;
      e.preventDefault();
      setPointerFromEvent(e);
      const hit = raycastPlanet();
      if (!hit) return;
      isPainting = true;
      lastHitLocal = worldToPlanetLocal(hit.point);
      renderer.domElement.setPointerCapture(e.pointerId);
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      setPointerFromEvent(e);
      if (!paintMode) {
        brushRing.visible = false;
        return;
      }
      const hit = raycastPlanet();
      if (!hit) {
        brushRing.visible = false;
        if (isPainting) lastHitLocal = null;
        return;
      }
      const nWorld = hit.face.normal.clone()
        .transformDirection(planetMesh.matrixWorld)
        .normalize();
      updateBrushRing(hit.point, nWorld, brushArcWorldRadius(hit.point.length()));
      if (isPainting) lastHitLocal = worldToPlanetLocal(hit.point);
    });

    function endPaint(e) {
      if (!isPainting) return;
      isPainting = false;
      lastHitLocal = null;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    renderer.domElement.addEventListener('pointerup', endPaint);
    renderer.domElement.addEventListener('pointercancel', endPaint);

    // Suppress the browser context menu over the canvas while paint mode is on.
    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (paintMode) e.preventDefault();
    });

    // ---------- Moons ----------
    const matMoon = new THREE.MeshStandardMaterial({
      color: 0xb6ada0,
      roughness: 0.95,
      metalness: 0.0,
    });
    const moonGeo = new THREE.SphereGeometry(1, 32, 16);

    const MAX_MOONS = 4;
    const MOON_REF_DISTANCE = 22;
    let moonSpeedScalar = (40 / 3000) * Math.PI * 2;
    const moons = [];
    const moonSlotsInUse = new Set();

    function moonOrbitPlane(slot) {
      return {
        inclination: (slot % 2 === 0 ? 1 : -1) * (0.08 + 0.18 * slot),
        node: slot * 1.1,
        phase: (slot / MAX_MOONS) * Math.PI * 2,
      };
    }

    function allocateMoonSlot() {
      for (let i = 0; i < MAX_MOONS; i++) {
        if (!moonSlotsInUse.has(i)) {
          moonSlotsInUse.add(i);
          return i;
        }
      }
      return -1;
    }

    function updateMoonPosition(m) {
      const x0 = Math.cos(m.angle) * m.distance;
      const z0 = Math.sin(m.angle) * m.distance;
      const ci = Math.cos(m.inclination), si = Math.sin(m.inclination);
      const y1 = -z0 * si;
      const z1 = z0 * ci;
      const cn = Math.cos(m.node), sn = Math.sin(m.node);
      const xf = x0 * cn - z1 * sn;
      const zf = x0 * sn + z1 * cn;
      m.mesh.position.set(xf, y1, zf);
    }

    function addMoon(size, distance) {
      if (moons.length >= MAX_MOONS) return null;
      const slot = allocateMoonSlot();
      if (slot < 0) return null;
      const plane = moonOrbitPlane(slot);
      const mesh = new THREE.Mesh(moonGeo, matMoon);
      mesh.scale.setScalar(size);
      scene.add(mesh);
      const moon = {
        mesh,
        angle: plane.phase,
        inclination: plane.inclination,
        node: plane.node,
        size,
        distance,
        slot,
      };
      moons.push(moon);
      updateMoonPosition(moon);
      return moon;
    }

    function removeMoonAt(index) {
      const moon = moons[index];
      if (!moon) return;
      scene.remove(moon.mesh);
      moonSlotsInUse.delete(moon.slot);
      moons.splice(index, 1);
    }

    function setMoonSize(index, size) {
      const m = moons[index];
      if (!m) return;
      m.size = size;
      m.mesh.scale.setScalar(size);
    }

    function setMoonDistance(index, distance) {
      const m = moons[index];
      if (!m) return;
      m.distance = distance;
      updateMoonPosition(m);
    }

    function updateMoons(dt) {
      for (const m of moons) {
        const omega = moonSpeedScalar * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
        m.angle += omega * dt;
        updateMoonPosition(m);
      }
    }

    // ---------- Stars ----------
    const starCount = 2000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 320;
      starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ---------- Planet rotation ----------
    let rotationSpeed = (30 / 3000) * Math.PI * 2;
    function updatePlanetRotation(dt) {
      planetGroup.rotation.y += rotationSpeed * dt;
    }

    // ---------- UI ----------
    const brushRadiusInput   = document.getElementById('brushRadius');
    const brushRadiusVal     = document.getElementById('brushRadiusVal');
    const brushStrengthInput = document.getElementById('brushStrength');
    const brushStrengthVal   = document.getElementById('brushStrengthVal');
    const brushRaiseInput    = document.getElementById('brushRaise');
    const paintModeInput     = document.getElementById('paintMode');
    const pauseRotInput      = document.getElementById('pauseRot');
    const daySpeedInput      = document.getElementById('daySpeed');
    const daySpeedVal        = document.getElementById('daySpeedVal');
    const moonSpeedInput     = document.getElementById('moonSpeed');
    const moonSpeedVal       = document.getElementById('moonSpeedVal');
    const moonsListEl        = document.getElementById('moonsList');
    const addMoonBtn         = document.getElementById('addMoon');

    // Slider 5..150 → 0.05..1.5 rad. Slider 1..50 → 0.1..5.0 strength.
    function sliderToBrushRadius(v) { return v / 100; }
    function sliderToBrushStrength(v) { return v / 10; }

    brushRadiusInput.oninput = () => {
      brushRadius = sliderToBrushRadius(parseInt(brushRadiusInput.value, 10));
      brushRadiusVal.textContent = brushRadius.toFixed(2);
    };
    brushStrengthInput.oninput = () => {
      brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
      brushStrengthVal.textContent = brushStrength.toFixed(1);
    };
    brushRaiseInput.onchange = () => { brushRaise = brushRaiseInput.checked; };
    paintModeInput.onchange = () => {
      paintMode = paintModeInput.checked;
      controls.mouseButtons.RIGHT = paintMode ? null : THREE.MOUSE.PAN;
      if (!paintMode) brushRing.visible = false;
    };
    pauseRotInput.onchange = () => { paused = pauseRotInput.checked; };
    daySpeedInput.oninput = () => {
      daySpeedVal.textContent = daySpeedInput.value;
      rotationSpeed = (parseInt(daySpeedInput.value, 10) / 3000) * Math.PI * 2;
    };
    moonSpeedInput.oninput = () => {
      moonSpeedVal.textContent = moonSpeedInput.value;
      moonSpeedScalar = (parseInt(moonSpeedInput.value, 10) / 3000) * Math.PI * 2;
    };

    brushRadius = sliderToBrushRadius(parseInt(brushRadiusInput.value, 10));
    brushRadiusVal.textContent = brushRadius.toFixed(2);
    brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
    brushStrengthVal.textContent = brushStrength.toFixed(1);

    function renderMoonsList() {
      moonsListEl.innerHTML = moons.map((m, i) => {
        const sizeSlider = Math.round(m.size * 10);
        const distSlider = Math.round(m.distance);
        return `
          <div class="moon-row" data-index="${i}">
            <div class="moon-row-controls">
              <label>Size <input class="moon-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val moon-size-val">${sizeSlider}</span></label>
              <label>Dist <input class="moon-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val moon-dist-val">${distSlider}</span></label>
            </div>
            <button class="moon-remove" type="button" aria-label="Remove moon">×</button>
          </div>
        `;
      }).join('');

      moonsListEl.querySelectorAll('.moon-row').forEach((row) => {
        const index = parseInt(row.dataset.index, 10);
        const sizeIn = row.querySelector('.moon-size-input');
        const sizeValEl = row.querySelector('.moon-size-val');
        const distIn = row.querySelector('.moon-dist-input');
        const distValEl = row.querySelector('.moon-dist-val');
        const rmBtn = row.querySelector('.moon-remove');
        sizeIn.oninput = () => {
          sizeValEl.textContent = sizeIn.value;
          setMoonSize(index, parseInt(sizeIn.value, 10) / 10);
        };
        distIn.oninput = () => {
          distValEl.textContent = distIn.value;
          setMoonDistance(index, parseInt(distIn.value, 10));
        };
        rmBtn.onclick = () => {
          removeMoonAt(index);
          renderMoonsList();
        };
      });

      addMoonBtn.disabled = moons.length >= MAX_MOONS;
    }

    addMoonBtn.onclick = () => {
      const defaultDistance = 18 + moons.length * 8;
      if (addMoon(1.2, defaultDistance)) renderMoonsList();
    };

    addMoon(1.2, 22);
    renderMoonsList();

    // ---------- Resize ----------
    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ---------- Animate ----------
    const clock = new THREE.Clock();
    (function loop() {
      requestAnimationFrame(loop);
      controls.update();
      const dt = clock.getDelta();
      if (!paused) updatePlanetRotation(dt);
      updateMoons(dt);
      if (isPainting && lastHitLocal) applyBrush(lastHitLocal, dt);
      renderer.render(scene, camera);
    })();
