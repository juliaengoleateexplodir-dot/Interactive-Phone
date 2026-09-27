import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =========================================================
   1 · CONFIGURAÇÃO PADRÃO — edite aqui se quiser
   ========================================================= */
const DEFAULTS = {
  baseColor:       '#8ec9ff',  // cor do "resto" do celular
  touchColor:      '#ff2f3d',  // cor da parte tocada
  touchRadius:     0.45,       // tamanho da mancha vermelha
  decay:           0.90,       // permanência (maior = some devagar)
  zWeight:         2.6,        // evita vazar cor para a face oposta
  autoRotate:      true,
  autoRotateSpeed: 0.8,
  metalness:       0.18,
  roughness:       0.42,
};

const CONFIG = { ...DEFAULTS };
const STORAGE_KEY = 'phone3d:config:v1';

try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) Object.assign(CONFIG, JSON.parse(raw));
} catch (_) { /* localStorage indisponível — ignora */ }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG)); } catch (_) {}
  }, 250);
}

/* =========================================================
   2 · DIMENSÕES DO CELULAR
   ========================================================= */
const PHONE = { w: 1.62, h: 3.30, d: 0.22 };
const SEG   = { w: 22,   h: 44,   d: 4 };   // segmentos da malha

/* =========================================================
   3 · RENDERER / CENA / CÂMERA
   ========================================================= */
const canvas = document.getElementById('scene');
const stage  = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#070b16');

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0.6, 0.9, 7);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping    = true;
controls.dampingFactor    = 0.075;
controls.rotateSpeed      = 0.85;
controls.enablePan        = false;
controls.minDistance      = 3.2;
controls.maxDistance      = 15;
controls.minPolarAngle    = 0.15;
controls.maxPolarAngle    = Math.PI - 0.15;
controls.target.set(0, 0, 0);
controls.autoRotate       = CONFIG.autoRotate;
controls.autoRotateSpeed  = CONFIG.autoRotateSpeed;

/* ---- Iluminação ---- */
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x0b1220, 1.15));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(4, 7, 9);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x7fb2ff, 1.15);
fillLight.position.set(-7, -3, 5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff4d6d, 0.85);
rimLight.position.set(0, -6, -9);
scene.add(rimLight);

/* =========================================================
   4 · MODELO DO CELULAR
   ========================================================= */
const phone = new THREE.Group();
scene.add(phone);

/* --- Corpo (malha que recebe as cores) --- */
const bodyGeo = new THREE.BoxGeometry(
  PHONE.w, PHONE.h, PHONE.d,
  SEG.w, SEG.h, SEG.d
);

const vCount   = bodyGeo.attributes.position.count;
const localPos = new Float32Array(bodyGeo.attributes.position.array); // cópia estática p/ performance

const colorAttr = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
colorAttr.setUsage(THREE.DynamicDrawUsage);
bodyGeo.setAttribute('color', colorAttr);

const heat = new Float32Array(vCount); // 0 = azul claro · 1 = vermelho

const bodyMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness:    CONFIG.metalness,
  roughness:    CONFIG.roughness,
});

const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
phone.add(bodyMesh);

/* --- Contorno das arestas --- */
const edges = new THREE.LineSegments(
  new THREE.EdgesGeometry(bodyGeo, 30),
  new THREE.LineBasicMaterial({ color: 0x2b3f66, transparent: true, opacity: 0.85 })
);
phone.add(edges);

/* --- Módulo de câmera (traseira) --- */
const bumpMat = new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.7, roughness: 0.3 });
const bump = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.05), bumpMat);
bump.position.set(-PHONE.w / 2 + 0.44, PHONE.h / 2 - 0.48, -PHONE.d / 2 - 0.025);
phone.add(bump);

/* --- Lentes --- */
const lensMat = new THREE.MeshStandardMaterial({ color: 0x05070d, metalness: 0.9, roughness: 0.15 });
const lensGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.04, 20);
[
  [-0.14,  0.14],
  [ 0.14,  0.14],
  [-0.14, -0.14],
].forEach(([ox, oy]) => {
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(bump.position.x + ox, bump.position.y + oy, -PHONE.d / 2 - 0.055);
  phone.add(lens);
});

phone.updateMatrixWorld(true);

/* =========================================================
   5 · CORES
   ========================================================= */
const baseColor  = new THREE.Color(CONFIG.baseColor);
const touchColor = new THREE.Color(CONFIG.touchColor);

/* =========================================================
   6 · SISTEMA DE TOQUE
   ========================================================= */
const raycaster = new THREE.Raycaster();
const ndc       = new THREE.Vector2();
const pointers  = new Map();   // pointerId -> { x, y }

let totalTouches = 0;
let activeCount  = 0;
let litPercent   = 0;
let lastRegion   = '—';
let lastLocal    = null;

canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  totalTouches++;
  hideHint();
}, { passive: true });

canvas.addEventListener('pointermove', (e) => {
  // mouse = hover livre · toque = só quando pressionado
  if (e.pointerType === 'mouse' || pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
}, { passive: true });

const release = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', release, { passive: true });
canvas.addEventListener('pointercancel', release, { passive: true });
canvas.addEventListener('pointerleave', release, { passive: true });

/* Aplica calor em torno de um ponto local da malha */
function applyHeatPoint(p) {
  const r    = CONFIG.touchRadius;
  const r2   = r * r;
  const invR = 1 / r;
  const zw   = CONFIG.zWeight;

  for (let i = 0; i < vCount; i++) {
    const i3 = i * 3;
    const dx =  localPos[i3]     - p.x;
    const dy =  localPos[i3 + 1] - p.y;
    const dz = (localPos[i3 + 2] - p.z) * zw;

    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 < r2) {
      const t = 1 - Math.sqrt(d2) * invR;   // 1 no centro, 0 na borda
      const v = t * t * (3 - 2 * t);        // smoothstep
      if (v > heat[i]) heat[i] = v;
    }
  }
}

/* Atualiza calor + cores a cada frame */
function updateTouchState(dt) {
  // 1) decaimento independente de FPS
  const factor = Math.pow(CONFIG.decay, dt * 60);
  for (let i = 0; i < vCount; i++) heat[i] *= factor;

  // 2) raycast de cada ponteiro ativo
  const rect = canvas.getBoundingClientRect();
  let maxHeat = 0;

  for (const p of pointers.values()) {
    ndc.x =  ((p.x - rect.left) / rect.width)  * 2 - 1;
    ndc.y = -((p.y - rect.top)  / rect.height) * 2 + 1;

    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(bodyMesh, false)[0];

    if (hit) {
      const lp = bodyMesh.worldToLocal(hit.point.clone());
      applyHeatPoint(lp);
      lastLocal = lp;
    }
  }

  // 3) escreve as cores + mede área acesa
  const arr = colorAttr.array;
  const br = baseColor.r,  bg = baseColor.g,  bb = baseColor.b;
  const tr = touchColor.r, tg = touchColor.g, tb = touchColor.b;

  let lit = 0;

  for (let i = 0; i < vCount; i++) {
    const h  = heat[i];
    const i3 = i * 3;

    if (h > 0.5) lit++;
    if (h > maxHeat) maxHeat = h;

    arr[i3]     = br + (tr - br) * h;
    arr[i3 + 1] = bg + (tg - bg) * h;
    arr[i3 + 2] = bb + (tb - bb) * h;
  }

  colorAttr.needsUpdate = true;

  litPercent  = (lit / vCount) * 100;
  activeCount = pointers.size;

  // economia de bateria: nada aceso e nenhum dedo na tela
  if (pointers.size === 0 && maxHeat < 0.005) {
    lastRegion = '—';
  } else if (lastLocal) {
    lastRegion = regionName(lastLocal);
  }
}

/* Nome amigável da região tocada */
function regionName(p) {
  const yTop = (PHONE.h / 2 - p.y) / PHONE.h;   // 0 = topo · 1 = base
  const parte =
    p.z >  PHONE.d / 4 ? 'Frente'  :
    p.z < -PHONE.d / 4 ? 'Traseira': 'Lateral';
  const faixa = yTop < 0.33 ? 'topo' : yTop < 0.66 ? 'meio' : 'base';
  return `${parte} · ${faixa}`;
}

/* =========================================================
   7 · CÂMERA — enquadramento responsivo
   ========================================================= */
function fitCamera() {
  const aspect = camera.aspect;
  const vFov   = (camera.fov * Math.PI) / 180;

  const targetH = PHONE.h * 1.45;
  const targetW = PHONE.w * 2.10;

  const distH = (targetH / 2) / Math.tan(vFov / 2);
  const hFov  = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (targetW / 2) / Math.tan(hFov / 2);

  const dist = Math.max(distH, distW);

  const dir = camera.position.clone();
  if (dir.lengthSq() < 1e-4) dir.set(0.15, 0.18, 1);
  dir.normalize();

  camera.position.copy(dir.multiplyScalar(dist));
  camera.lookAt(0, 0, 0);
  controls.update();
}

let hasFitted = false;

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w === 0 || h === 0) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  if (!hasFitted) {
    fitCamera();
    hasFitted = true;
  }
}

if ('ResizeObserver' in window) {
  new ResizeObserver(resize).observe(stage);
} else {
  window.addEventListener('resize', resize);
}
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

/* =========================================================
   8 · LOOP DE RENDERIZAÇÃO
   ========================================================= */
const clock = new THREE.Clock();

let frames = 0, fpsAccum = 0, fps = 0;
let statsAccum = 0;

const elTouches = document.getElementById('stat-touches');
const elFps     = document.getElementById('stat-fps');
const elArea    = document.getElementById('stat-area');
const elRegion  = document.getElementById('stat-region');
const elBar     = document.getElementById('stat-bar');

function updateStatsDOM(dt) {
  statsAccum += dt;
  if (statsAccum < 0.2) return;
  statsAccum = 0;

  elTouches.textContent = `${activeCount} / ${totalTouches}`;
  elFps.textContent     = fps || '—';
  elArea.textContent    = litPercent.toFixed(1) + '%';
  elRegion.textContent  = lastRegion;
  elBar.style.width     = Math.min(litPercent * 4, 100) + '%';
}

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.1);

  updateTouchState(dt);
  controls.update();
  renderer.render(scene, camera);

  // FPS
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }

  updateStatsDOM(dt);
}

/* =========================================================
   9 · INTERFACE / PAINEL
   ========================================================= */
const panel      = document.getElementById('panel');
const btnOpen    = document.getElementById('btn-settings');
const btnClose   = document.getElementById('btn-close');
const hintEl     = document.getElementById('hint');

const ui = {
  base:       document.getElementById('cfg-base'),
  touch:      document.getElementById('cfg-touch'),
  radius:     document.getElementById('cfg-radius'),
  decay:      document.getElementById('cfg-decay'),
  zw:         document.getElementById('cfg-zw'),
  autoRotate: document.getElementById('cfg-autorotate'),
  speed:      document.getElementById('cfg-speed'),
  metal:      document.getElementById('cfg-metal'),
  rough:      document.getElementById('cfg-rough'),
  reset:      document.getElementById('cfg-reset'),
  cam:        document.getElementById('cfg-cam'),
};

const out = {
  radius: document.getElementById('val-radius'),
  decay:  document.getElementById('val-decay'),
  zw:     document.getElementById('val-zw'),
  speed:  document.getElementById('val-speed'),
  metal:  document.getElementById('val-metal'),
  rough:  document.getElementById('val-rough'),
};

function syncUI() {
  ui.base.value       = CONFIG.baseColor;
  ui.touch.value      = CONFIG.touchColor;
  ui.radius.value     = CONFIG.touchRadius;
  ui.decay.value      = CONFIG.decay;
  ui.zw.value         = CONFIG.zWeight;
  ui.autoRotate.checked = CONFIG.autoRotate;
  ui.speed.value      = CONFIG.autoRotateSpeed;
  ui.metal.value      = CONFIG.metalness;
  ui.rough.value      = CONFIG.roughness;

  out.radius.textContent = Number(CONFIG.touchRadius).toFixed(2);
  out.decay.textContent  = Number(CONFIG.decay).toFixed(2);
  out.zw.textContent     = Number(CONFIG.zWeight).toFixed(1);
  out.speed.textContent  = Number(CONFIG.autoRotateSpeed).toFixed(1);
  out.metal.textContent  = Number(CONFIG.metalness).toFixed(2);
  out.rough.textContent  = Number(CONFIG.roughness).toFixed(2);
}

function applyConfig() {
  baseColor.set(CONFIG.baseColor);
  touchColor.set(CONFIG.touchColor);

  bodyMat.metalness = CONFIG.metalness;
  bodyMat.roughness = CONFIG.roughness;

  controls.autoRotate      = CONFIG.autoRotate;
  controls.autoRotateSpeed = CONFIG.autoRotateSpeed;
}

/* --- Eventos dos controles --- */
ui.base.addEventListener('input', () => { CONFIG.baseColor = ui.base.value; applyConfig(); persist(); });
ui.touch.addEventListener('input', () => { CONFIG.touchColor = ui.touch.value; applyConfig(); persist(); });

ui.radius.addEventListener('input', () => {
  CONFIG.touchRadius = parseFloat(ui.radius.value);
  out.radius.textContent = CONFIG.touchRadius.toFixed(2);
  persist();
});

ui.decay.addEventListener('input', () => {
  CONFIG.decay = parseFloat(ui.decay.value);
  out.decay.textContent = CONFIG.decay.toFixed(2);
  persist();
});

ui.zw.addEventListener('input', () => {
  CONFIG.zWeight = parseFloat(ui.zw.value);
  out.zw.textContent = CONFIG.zWeight.toFixed(1);
  persist();
});

ui.autoRotate.addEventListener('change', () => {
  CONFIG.autoRotate = ui.autoRotate.checked;
  controls.autoRotate = CONFIG.autoRotate;
  persist();
});

ui.speed.addEventListener('input', () => {
  CONFIG.autoRotateSpeed = parseFloat(ui.speed.value);
  controls.autoRotateSpeed = CONFIG.autoRotateSpeed;
  out.speed.textContent = CONFIG.autoRotateSpeed.toFixed(1);
  persist();
});

ui.metal.addEventListener('input', () => {
  CONFIG.metalness = parseFloat(ui.metal.value);
  bodyMat.metalness = CONFIG.metalness;
  out.metal.textContent = CONFIG.metalness.toFixed(2);
  persist();
});

ui.rough.addEventListener('input', () => {
  CONFIG.roughness = parseFloat(ui.rough.value);
  bodyMat.roughness = CONFIG.roughness;
  out.rough.textContent = CONFIG.roughness.toFixed(2);
  persist();
});

ui.reset.addEventListener('click', () => {
  Object.assign(CONFIG, DEFAULTS);
  applyConfig();
  syncUI();
  persist();
});

ui.cam.addEventListener('click', () => {
  camera.position.set(0.6, 0.9, 7);
  controls.target.set(0, 0, 0);
  fitCamera();
});

/* --- Abrir / fechar painel --- */
function openPanel() {
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  btnOpen.setAttribute('aria-expanded', 'true');
}

function closePanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  btnOpen.setAttribute('aria-expanded', 'false');
}

btnOpen.addEventListener('click', () => {
  panel.classList.contains('open') ? closePanel() : openPanel();
});
btnClose.addEventListener('click', closePanel);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});

/* --- Dica inicial --- */
let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl.style.opacity = '0';
  hintEl.style.transition = 'opacity .5s';
  setTimeout(() => hintEl.remove(), 600);
}

/* =========================================================
   10 · INICIALIZAÇÃO
   ========================================================= */
syncUI();
applyConfig();
resize();
animate();
