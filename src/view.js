/* =========================================================================
   view.js — Three.js presentation layer.
   Renders from PARTIAL knowledge: your own hand face-up, everyone else as
   face-down fans. The local player is always drawn at the bottom seat.
   ========================================================================= */

import {
  SUIT_SYM, HS_CARDS, HS_NAME, CARD_HS, cardRank, cardSuit, cardLabel, isRed,
  TEAM_HEX, TEAM_CSS, SEAT_TEAM
} from './engine.js';

const THREE = window.THREE;
const TWEEN = window.TWEEN;

const CARD_W = 1.15, CARD_H = 1.6, CARD_D = 0.035;
const SEAT_R = 7.4, AVATAR_R = 9.9, TABLE_R = 9.0;

let renderer, scene, camera, controls, raycaster, pointer, container;
let handlers = {};
let mySeat = 0;
let seatInfo = [];
let hoverView = -1;
let activeSeat = 0;
let running = false;

const myMeshes = {};        // cardId -> mesh (only my own hand)
const fans = [[], [], [], [], [], []];   // absolute seat -> array of face-down meshes
const avatars = [];         // index = VIEW index (0 = bottom = me)
const rings = [];
const labels = [];
const faceTexCache = {};
let backTex = null;
let selectedCard = null;

/* ---------- scene refs needed by juice (hoisted out of local scope) ---------- */
let feltMesh = null, rimMesh = null, bounceLight = null, ambientLight = null, keyLight = null;

/* ---------- juice state ---------- */
let reducedMotion = false;
let MOTION = 1;                 // 1 or 0 — multiplies every displacement
let trauma = 0, lastT = 0;

const _savedP = new THREE.Vector3();
const _savedQ = new THREE.Quaternion();
const _roll   = new THREE.Quaternion();
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

// travelling active-turn ring
let ringFromV = 0, ringToV = 0, ringSweep = 1;   // sweep 1 = settled
let bloomV = -1, bloomK = 0;                     // arrival bloom
const ringFlash = [0, 0, 0, 0, 0, 0];            // per-view alert flash 0..1
const RING_TEAM = [];                            // per-view team colour
const _flashCol = new THREE.Color(0xff5a5a);
const _ringCol  = new THREE.Color();

// which side of a transfer the local player is on
const ROLE_GAIN = 0, ROLE_LOSE = 1, ROLE_WATCH = 2;

/* ---------- seat mapping ---------- */
const toView = seat => (seat - mySeat + 6) % 6;
const toSeat = view => (mySeat + view) % 6;
const viewAngle = v => Math.PI / 2 - v * Math.PI / 3;
function viewPos(v, r) {
  const a = viewAngle(v);
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

/* ---------- procedural textures ---------- */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function faceTexture(cid) {
  if (faceTexCache[cid]) return faceTexCache[cid];
  const W = 256, H = 356;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#fbfaf6'; roundRectPath(ctx, 0, 0, W, H, 22); ctx.fill();
  ctx.strokeStyle = '#d8d4c8'; ctx.lineWidth = 3;
  roundRectPath(ctx, 5, 5, W - 10, H - 10, 18); ctx.stroke();

  const col = isRed(cid) ? '#c8102e' : '#141821';
  const r = cardRank(cid), sym = SUIT_SYM[cardSuit(cid)];
  ctx.fillStyle = col;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  ctx.font = 'bold 150px Georgia, serif';
  ctx.globalAlpha = 0.13; ctx.fillText(sym, W / 2, H / 2 + 6); ctx.globalAlpha = 1;

  ctx.font = 'bold 88px Georgia, serif'; ctx.fillText(r, W / 2, H / 2 - 26);
  ctx.font = 'bold 62px Georgia, serif'; ctx.fillText(sym, W / 2, H / 2 + 62);

  const corner = (x, y, flip) => {
    ctx.save(); ctx.translate(x, y); if (flip) ctx.rotate(Math.PI);
    ctx.font = 'bold 44px Georgia, serif'; ctx.fillText(r, 0, 0);
    ctx.font = 'bold 36px Georgia, serif'; ctx.fillText(sym, 0, 38);
    ctx.restore();
  };
  corner(36, 44, false); corner(W - 36, H - 44, true);

  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  faceTexCache[cid] = tex;
  return tex;
}

function backTexture() {
  if (backTex) return backTex;
  const W = 256, H = 356;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f2ec'; roundRectPath(ctx, 0, 0, W, H, 22); ctx.fill();
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1d3f6e'); g.addColorStop(.5, '#2a5f9e'); g.addColorStop(1, '#16304f');
  ctx.fillStyle = g; roundRectPath(ctx, 12, 12, W - 24, H - 24, 14); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2;
  for (let i = -H; i < W; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 12); ctx.lineTo(i + H, H - 12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, H - 12); ctx.lineTo(i + H, 12); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 4;
  roundRectPath(ctx, 26, 26, W - 52, H - 52, 10); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px Georgia, serif'; ctx.fillText('LIT', W / 2, H / 2);
  backTex = new THREE.CanvasTexture(cv); backTex.anisotropy = 8;
  return backTex;
}

function labelSprite(text, cssColor) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 72;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(8,14,20,.8)'; roundRectPath(ctx, 4, 4, 248, 64, 14); ctx.fill();
  ctx.strokeStyle = cssColor; ctx.lineWidth = 3; roundRectPath(ctx, 4, 4, 248, 64, 14); ctx.stroke();
  ctx.fillStyle = '#f2f7fc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 28px Segoe UI, sans-serif';
  ctx.fillText(text.length > 13 ? text.slice(0, 12) + '…' : text, 128, 38);
  const t = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  sp.scale.set(2.4, 0.68, 1);
  sp.userData.tex = t;
  return sp;
}

/* ---------- geometry ---------- */
function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function fixUV(geo, w, h) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  uv.needsUpdate = true;
}
let BODY_GEO = null, FACE_GEO = null;
function geoms() {
  if (!BODY_GEO) {
    const shp = roundedShape(CARD_W, CARD_H, 0.11);
    BODY_GEO = new THREE.ExtrudeGeometry(shp, { depth: CARD_D, bevelEnabled: false, curveSegments: 5 });
    BODY_GEO.translate(0, 0, -CARD_D / 2);
    fixUV(BODY_GEO, CARD_W, CARD_H);
    FACE_GEO = new THREE.ShapeGeometry(shp, 5);
    fixUV(FACE_GEO, CARD_W, CARD_H);
  }
  return [BODY_GEO, FACE_GEO];
}

/** cardId = null builds a card that is face-down on both sides. */
function buildCard(cardId) {
  const [bodyGeo, faceGeo] = geoms();
  const grp = new THREE.Group();
  grp.rotation.order = 'YXZ';

  const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
    color: 0xf6f4ee, roughness: .85, metalness: .02
  }));
  body.castShadow = true; body.receiveShadow = true;
  grp.add(body);

  const front = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({
    map: cardId ? faceTexture(cardId) : backTexture(), roughness: .78
  }));
  front.position.z = CARD_D / 2 + 0.002;
  grp.add(front);

  const back = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({
    map: backTexture(), roughness: .78
  }));
  back.position.z = -CARD_D / 2 - 0.002;
  back.rotation.y = Math.PI;
  grp.add(back);

  grp.userData.cardId = cardId || null;
  grp.userData.picks = [body, front, back];
  scene.add(grp);
  return grp;
}
function destroyCard(mesh) {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.traverse(o => { if (o.material && o.material.dispose) o.material.dispose(); });
}

/* ---------- layout ---------- */
function handTransform(view, idx, count) {
  const rot = new THREE.Euler(0, 0, 0, 'YXZ');
  const pos = new THREE.Vector3();
  const mid = (count - 1) / 2;
  const off = idx - mid;

  if (view === 0) {
    const spread = count > 9 ? 0.82 : 0.95;
    pos.set(off * spread, 3.05 - Math.abs(off) * 0.06, 8.5 + Math.abs(off) * 0.16);
    rot.set(-Math.PI / 2 + 0.80, 0, -off * 0.045);
  } else {
    const a = viewAngle(view);
    const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const tang = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    pos.copy(radial).multiplyScalar(SEAT_R * 0.79).addScaledVector(tang, off * 0.44);
    pos.y = 0.06 + idx * 0.012;
    rot.set(Math.PI / 2, -Math.PI / 2 - a, off * 0.05);
  }
  return { pos, rot };
}

/* Shortest-arc angle interpolation. The raw lerp this replaces could spin a
   card the long way round: side seats sit at rot.y = -PI/2 - a, down near
   -2.6 rad, so a naive lerp from +0.6 travels ~3.2 rad the wrong way. */
function angLerp(a, b, k) {
  let d = (b - a) % (Math.PI * 2);
  if (d >  Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
function lerpEuler(out, a, b, k) {
  out.x = angLerp(a.x, b.x, k);
  out.y = angLerp(a.y, b.y, k);
  out.z = angLerp(a.z, b.z, k);
}
/* Anticipation curve: dips to -0.037 at t=1/3 before running to 1. The card
   pulls back toward your hand before being torn away. */
const backIn = t => t * t * (2.0 * t - 1.0);
/* Signed shortest step around the 6-seat ring. */
function shortDelta(a, b) { const d = (b - a + 6) % 6; return d > 3 ? d - 6 : d; }

function roleFor(fromSeat, toSeat) {
  if (toSeat === mySeat) return ROLE_GAIN;
  if (fromSeat === mySeat) return ROLE_LOSE;
  return ROLE_WATCH;
}

/* Quartic.Out gives front-loaded velocity and a long settle — the card leaps
   out and comes to rest, instead of gliding symmetrically. Rotation lands at
   86% of the position duration so the card is square in the fan while still
   sliding the last few percent home; that desync is what reads as mass. */
function tweenTo(mesh, pos, rot, dur, delay, done, ease) {
  const e = ease || TWEEN.Easing.Quartic.Out;
  new TWEEN.Tween(mesh.position).to({ x: pos.x, y: pos.y, z: pos.z }, dur)
    .delay(delay || 0).easing(e)
    .onComplete(() => { if (done) done(); }).start();
  new TWEEN.Tween(mesh.rotation).to({ x: rot.x, y: rot.y, z: rot.z }, dur * 0.86)
    .delay(delay || 0).easing(e).start();
}

let myOrder = [];   // ordered cardIds of my hand

export function layout(dur = 480) {
  myOrder.forEach((cid, i) => {
    const m = myMeshes[cid];
    if (!m) return;
    const t = handTransform(0, i, myOrder.length);
    const isSel = selectedCard === cid;
    if (isSel) { t.pos.y += 0.75 * MOTION; t.pos.z -= 0.35 * MOTION; }
    tweenTo(m, t.pos, t.rot, dur, 0, null, isSel ? TWEEN.Easing.Back.Out : undefined);
  });
  for (let s = 0; s < 6; s++) {
    if (s === mySeat) continue;
    const v = toView(s);
    fans[s].forEach((m, i) => {
      const t = handTransform(v, i, fans[s].length);
      tweenTo(m, t.pos, t.rot, dur, 0);
    });
  }
}

/* ---------- scene construction ---------- */
export function initView(el, cbs) {
  container = el;
  handlers = cbs || {};

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080d12);
  scene.fog = new THREE.Fog(0x080d12, 30, 70);

  camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 16, 16.5);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2.4);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 15; controls.maxDistance = 45;
  controls.minPolarAngle = 0.18; controls.maxPolarAngle = 1.16;
  controls.enablePan = false;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.update();

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  ambientLight = new THREE.AmbientLight(0xbfd4ea, 0.55);
  scene.add(ambientLight);
  const key = new THREE.DirectionalLight(0xffffff, 0.95);
  keyLight = key;
  key.position.set(6, 22, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18; key.shadow.camera.right = 18;
  key.shadow.camera.top = 18; key.shadow.camera.bottom = -18;
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.bias = -0.0009;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fa8e0, 0.35);
  rim.position.set(-10, 8, -12); scene.add(rim);
  bounceLight = new THREE.PointLight(0x2f6f4f, 0.5, 40);
  bounceLight.position.set(0, 4, 0); scene.add(bounceLight);

  buildTable();
  buildAvatars();

  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0x0d151d, roughness: .95 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.6; floor.receiveShadow = true;
  scene.add(floor);

  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

  running = true;
  requestAnimationFrame(loop);
}

function buildTable() {
  const felt = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_R, TABLE_R, 0.5, 72),
    new THREE.MeshStandardMaterial({ color: 0x1d6b46, roughness: .95 }));
  felt.position.y = -0.25; felt.receiveShadow = true; scene.add(felt);
  feltMesh = felt;

  const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_R + 0.32, 0.55, 18, 80),
    new THREE.MeshStandardMaterial({ color: 0x5a3720, roughness: .55, metalness: .18 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = -0.12;
  rim.castShadow = true; rim.receiveShadow = true; scene.add(rim);
  rimMesh = rim;

  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.6, 1.3, 32),
    new THREE.MeshStandardMaterial({ color: 0x3f2717, roughness: .7 }));
  base.position.y = -1.1; base.castShadow = true; scene.add(base);

  const inlay = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.75, 72),
    new THREE.MeshBasicMaterial({ color: 0x2f8f60, transparent: true, opacity: .35, side: THREE.DoubleSide }));
  inlay.rotation.x = -Math.PI / 2; inlay.position.y = 0.011; scene.add(inlay);
}

function buildAvatars() {
  for (let v = 0; v < 6; v++) {
    const grp = new THREE.Group();
    grp.position.copy(viewPos(v, AVATAR_R));
    grp.lookAt(0, 0, 0);

    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.05, 1.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x223243, roughness: .8 }));
    ped.position.y = -0.4; ped.castShadow = true; grp.add(ped);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.78, 1.25, 20),
      new THREE.MeshStandardMaterial({ color: 0x777777, roughness: .6, metalness: .12 }));
    torso.position.y = 0.95; torso.castShadow = true; grp.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0xd7b393, roughness: .75 }));
    head.position.y = 1.92; head.castShadow = true; grp.add(head);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.09, 10, 40),
      new THREE.MeshBasicMaterial({ color: 0xffdd66, transparent: true, opacity: 0 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = -1.05; grp.add(ring);

    const lbl = labelSprite('—', '#888');
    lbl.position.set(0, 2.85, 0); grp.add(lbl);

    grp.userData.view = v;
    grp.userData.picks = [ped, torso, head];
    // You never need to look at your own avatar, and it would sit right on
    // top of your hand — so the bottom seat is left empty.
    if (v === 0) grp.visible = false;
    scene.add(grp);
    avatars.push(grp); rings.push(ring); labels.push(lbl);
  }
}

/* ---------- public API ---------- */

export function setSeats(seats, me) {
  seatInfo = seats;
  mySeat = me;
  for (let v = 0; v < 6; v++) {
    const s = toSeat(v);
    const info = seats[s] || { name: '—', team: SEAT_TEAM[s] };
    const grp = avatars[v];
    grp.userData.seat = s;
    grp.userData.picks[1].material.color.setHex(TEAM_HEX[info.team]);
    grp.remove(labels[v]);
    if (labels[v].material.map) labels[v].material.map.dispose();
    const lbl = labelSprite(info.name + (info.isBot ? ' 🤖' : ''), TEAM_CSS[info.team]);
    lbl.position.set(0, 2.85, 0);
    grp.add(lbl);
    labels[v] = lbl;
    rings[v].material.color.setHex(TEAM_HEX[info.team]);
    RING_TEAM[v] = new THREE.Color(TEAM_HEX[info.team]);
  }
  // my own seat shows no face-down fan
  fans[mySeat].forEach(destroyCard);
  fans[mySeat] = [];
}

export function clearTable() {
  syncSig = '';
  Object.keys(myMeshes).forEach(k => { destroyCard(myMeshes[k]); delete myMeshes[k]; });
  for (let s = 0; s < 6; s++) { fans[s].forEach(destroyCard); fans[s] = []; }
  myOrder = [];
  selectedCard = null;
}

let syncSig = '';

/** Reconcile all meshes with authoritative counts + my own hand. */
export function sync(myHand, counts, dur = 420) {
  const sig = myHand.join(',') + '|' + counts.join(',') + '|' + (selectedCard || '');
  if (sig === syncSig) return;                 // nothing changed — don't restart tweens
  syncSig = sig;
  myOrder = myHand.slice();
  for (const cid of Object.keys(myMeshes)) {
    if (!myOrder.includes(cid)) { destroyCard(myMeshes[cid]); delete myMeshes[cid]; }
  }
  for (const cid of myOrder) if (!myMeshes[cid]) myMeshes[cid] = buildCard(cid);
  if (selectedCard && !myOrder.includes(selectedCard)) selectedCard = null;

  for (let s = 0; s < 6; s++) {
    if (s === mySeat) { fans[s].forEach(destroyCard); fans[s] = []; continue; }
    const want = counts[s] | 0;
    while (fans[s].length > want) destroyCard(fans[s].pop());
    while (fans[s].length < want) fans[s].push(buildCard(null));
  }
  layout(dur);
}

/** Debug accessor — used by tests/ and the #debug console hook. */
export function debugScene() { return scene; }

export function setReducedMotion(b) {
  reducedMotion = !!b;
  MOTION = reducedMotion ? 0 : 1;
  if (reducedMotion) trauma = 0;
}
export function isReducedMotion() { return reducedMotion; }

/** Additive trauma. Decays quadratically, so it reads as an impact not a rumble. */
export function shake(amount) {
  if (reducedMotion) return;
  trauma = Math.min(1, trauma + amount);
}

/** The active-turn highlight travels around the seat ring instead of teleporting. */
export function setActive(seat, delay) {
  if (seat === activeSeat) return;
  const from = toView(activeSeat), to = toView(seat);
  activeSeat = seat;
  const go = () => {
    ringFromV = from; ringToV = to;
    if (reducedMotion) { ringSweep = 1; startBloom(to); return; }
    const o = { s: 0 };
    ringSweep = 0;
    new TWEEN.Tween(o).to({ s: 1 }, 260).easing(TWEEN.Easing.Cubic.InOut)
      .onUpdate(() => { ringSweep = o.s; })
      .onComplete(() => { ringSweep = 1; startBloom(to); }).start();
  };
  if (delay) setTimeout(go, delay); else go();
}

function startBloom(v) {
  bloomV = v; bloomK = 1;
  const o = { b: 1 };
  new TWEEN.Tween(o).to({ b: 0 }, 340).easing(TWEEN.Easing.Quadratic.Out)
    .onUpdate(() => { bloomK = o.b; }).start();
}

/** Alert flash on one seat's ring — used for a refused ask and for the
    spectator's "that seat held that card" reveal. */
export function flashRing(seat, dur) {
  const v = toView(seat);
  const o = { f: 1 };
  ringFlash[v] = 1;
  new TWEEN.Tween(o).to({ f: 0 }, dur || 400).easing(TWEEN.Easing.Quadratic.Out)
    .onUpdate(() => { ringFlash[v] = o.f; }).start();
}

export function setSelected(cid) {
  selectedCard = (selectedCard === cid) ? null : cid;
  syncSig = '';
  layout(200);
  return selectedCard;
}
export function getSelected() { return selectedCard; }

export function animateDeal(myHand, counts, done) {
  clearTable();
  syncSig = '';
  myOrder = myHand.slice();

  const stack = [];
  myOrder.forEach(cid => { myMeshes[cid] = buildCard(cid); stack.push({ m: myMeshes[cid], seat: mySeat }); });
  for (let s = 0; s < 6; s++) {
    if (s === mySeat) continue;
    for (let i = 0; i < (counts[s] | 0); i++) {
      const m = buildCard(null);
      fans[s].push(m); stack.push({ m, seat: s });
    }
  }
  stack.forEach((e, i) => {
    e.m.position.set(0, 0.35 + i * 0.02, 0);
    e.m.rotation.set(Math.PI / 2, Math.random() * 0.1, 0);
  });

  // interleave so it looks like a real deal
  const order = [];
  const idx = [0, 0, 0, 0, 0, 0];
  const bySeat = [[], [], [], [], [], []];
  stack.forEach(e => bySeat[e.seat].push(e.m));
  let more = true;
  while (more) {
    more = false;
    for (let s = 0; s < 6; s++) {
      if (idx[s] < bySeat[s].length) { order.push({ m: bySeat[s][idx[s]], seat: s, i: idx[s] }); idx[s]++; more = true; }
    }
  }
  order.forEach((e, n) => {
    const v = toView(e.seat);
    const t = handTransform(v, e.i, bySeat[e.seat].length);
    tweenTo(e.m, t.pos, t.rot, 460, n * 40);
  });
  setTimeout(() => { if (done) done(); }, order.length * 40 + 620);
}

/* Transfer timing. The apex HOLD is the point of the whole animation: the
   reveal used to happen at the instant the card was moving fastest through the
   top of its arc, so nobody could read it. Now it stops, face-on and scaled up,
   for long enough to actually be seen. Streak shortens the hold (pace), never
   the roles (fairness) — role must not change total duration, or an observer
   could infer who gained from timing alone. */
const T_LAUNCH = 300, T_LAND = 460;
const holdFor = streak => 320 - 120 * Math.min(streak, 8) / 8;   // 320 → 200

/** Public reveal of a transferred card, from one fan into another. */
export function animateTransfer(fromSeat, toSeat, cardId, streak, done) {
  streak = streak || 0;
  const k = Math.min(streak, 8) / 8;
  const role = roleFor(fromSeat, toSeat);

  /* ---- acquire the flyer ---- */
  let flyer = null;
  if (fromSeat === mySeat && myMeshes[cardId]) {
    flyer = myMeshes[cardId];
    delete myMeshes[cardId];
    myOrder = myOrder.filter(c => c !== cardId);
  } else if (fans[fromSeat] && fans[fromSeat].length) {
    const back = fans[fromSeat].pop();
    const bp = back.position.clone(), br = back.rotation.clone();
    destroyCard(back);
    flyer = buildCard(cardId);
    flyer.position.copy(bp);
    flyer.rotation.copy(br);
  } else {
    flyer = buildCard(cardId);
    const t = handTransform(toView(fromSeat), 0, 1);
    flyer.position.copy(t.pos); flyer.rotation.copy(t.rot);
  }
  layout(300);

  /* ---- per-role dressing. The same event means three different things:
     you took a card, you got robbed, or you learned where a card lives. ---- */
  let APEX = role === ROLE_GAIN ? 1.35 + 0.40 * k
           : role === ROLE_LOSE ? 1.35 + 0.20 * k
           : 1.30;
  const SHK = role === ROLE_GAIN ? 0.28 + 0.30 * k
            : role === ROLE_LOSE ? 0.22 + 0.22 * k
            : 0.11;
  if (reducedMotion) APEX = 1.15;

  const launchEase = (role === ROLE_LOSE && !reducedMotion)
    ? backIn : TWEEN.Easing.Cubic.Out;

  if (role !== ROLE_WATCH) {
    const em = role === ROLE_GAIN ? TEAM_HEX[SEAT_TEAM[mySeat]] : 0x883344;
    const amt = role === ROLE_GAIN ? 0.35 * k : 0.22 * k;
    flyer.userData.picks.forEach(pk => {
      pk.material.emissive = new THREE.Color(em);
      pk.material.emissiveIntensity = amt;
    });
  }

  /* ---- geometry ---- */
  const p0 = flyer.position.clone();
  const endT = handTransform(toView(toSeat), 0, 1);
  const mid = p0.clone().lerp(endT.pos, 0.5);
  mid.y += 4.2 * MOTION;
  const showRot = new THREE.Euler(-Math.PI / 2 + 0.62, 0, 0, 'YXZ');
  const r0 = flyer.rotation.clone();

  const HOLD = holdFor(streak);
  const TOTAL = T_LAUNCH + HOLD + T_LAND;
  const B1 = T_LAUNCH, B2 = T_LAUNCH + HOLD;

  let firedApex = false;
  const o = { t: 0 };

  new TWEEN.Tween(o).to({ t: TOTAL }, TOTAL).easing(TWEEN.Easing.Linear.None)
    .onUpdate(() => {
      const ms = o.t;
      if (ms < B1) {
        const u = Math.min(1, Math.max(-0.1, launchEase(ms / B1)));
        flyer.position.lerpVectors(p0, mid, u);
        lerpEuler(flyer.rotation, r0, showRot, Math.min(1, Math.max(0, u)));
        flyer.scale.setScalar(1 + (APEX - 1) * Math.min(1, Math.max(0, u)));
      } else if (ms < B2) {
        const u = (ms - B1) / HOLD;
        if (!firedApex) {
          firedApex = true;
          // The spectator's news is the SEAT, not the card: "they held that."
          if (role === ROLE_WATCH) flashRing(fromSeat, 260);
        }
        flyer.position.copy(mid);
        flyer.rotation.copy(showRot);
        flyer.rotation.y = showRot.y + 0.35 * u * MOTION;
        flyer.scale.setScalar(APEX);
      } else {
        const u = TWEEN.Easing.Cubic.In((ms - B2) / T_LAND);   // accelerates: it falls home
        flyer.position.lerpVectors(mid, endT.pos, u);
        lerpEuler(flyer.rotation, showRot, endT.rot, u);
        flyer.scale.setScalar(APEX - (APEX - 1) * u);
      }
    })
    .onComplete(() => {
      flyer.scale.setScalar(1);
      shake(SHK);
      if (toSeat === mySeat) {
        myMeshes[cardId] = flyer;
      } else {
        destroyCard(flyer);
        fans[toSeat].push(buildCard(null));
      }
      if (done) done();
    }).start();
}

/** A refused ask. You reached for something and it wasn't there. */
export function animateMiss(askerSeat, targetSeat, cardId, done) {
  const ghost = buildCard(cardId);
  ghost.traverse(o => {
    if (o.material) { o.material.transparent = true; o.material.opacity = 0.62; }
  });

  const aV = toView(askerSeat), tV = toView(targetSeat);
  const p0 = handTransform(aV, 0, 1).pos.clone(); p0.y += 0.6;
  const pT = handTransform(tV, 0, 1).pos.clone();
  const stop = p0.clone().lerp(pT, 0.62);            // 62% of the way. It never arrives.
  stop.y += 2.0 * MOTION;
  const dropTo = stop.y - 2.5 * MOTION;
  const showRot = new THREE.Euler(-Math.PI / 2 + 0.62, 0, 0, 'YXZ');
  const r0 = ghost.rotation.clone();
  ghost.position.copy(p0);

  const REACH = 190, HOLD = 40, DROP = 330;
  const B1 = REACH, B2 = REACH + HOLD, TOTAL = B2 + DROP;
  let firedStop = false;
  const o = { t: 0 };

  new TWEEN.Tween(o).to({ t: TOTAL }, TOTAL).easing(TWEEN.Easing.Linear.None)
    .onUpdate(() => {
      const ms = o.t;
      if (ms < B1) {
        const u = TWEEN.Easing.Cubic.Out(ms / B1);
        ghost.position.lerpVectors(p0, stop, u);
        lerpEuler(ghost.rotation, r0, showRot, u);
        ghost.scale.setScalar(1 + 0.20 * u);
      } else if (ms < B2) {
        if (!firedStop) {
          firedStop = true;
          shake(0.22);
          flashRing(targetSeat, 400);
          refuseGesture(tV);
        }
        ghost.position.copy(stop);                   // hard stop — an eased stop reads as "arrived"
      } else {
        const u = (ms - B2) / DROP;
        const g = TWEEN.Easing.Quadratic.In(u);      // gravity
        ghost.position.y = stop.y + (dropTo - stop.y) * g;
        ghost.rotation.z = showRot.z + 1.4 * g * MOTION;
        const a = 0.62 * (1 - u);
        ghost.traverse(c => { if (c.material) c.material.opacity = a; });
      }
    })
    .onComplete(() => { destroyCard(ghost); if (done) done(); }).start();
}

/** The asked player shakes their head. Reduced motion gets a colour pulse. */
function refuseGesture(v) {
  const grp = avatars[v];
  const torso = grp.userData.picks[1];
  if (reducedMotion || v === 0) {
    const base = torso.material.color.clone();
    const hot = new THREE.Color(0xa04747);
    const o = { k: 0 };
    new TWEEN.Tween(o).to({ k: 1 }, 300).easing(TWEEN.Easing.Quadratic.InOut)
      .onUpdate(() => {
        const w = o.k < 0.5 ? o.k * 2 : (1 - o.k) * 2;
        torso.material.color.lerpColors(base, hot, w);
      })
      .onComplete(() => torso.material.color.copy(base)).start();
    return;
  }
  const base = grp.rotation.y;
  const o = { a: 0 };
  new TWEEN.Tween(o).to({ a: 1 }, 260).easing(TWEEN.Easing.Linear.None)
    .onUpdate(() => {
      grp.rotation.y = base + Math.sin(o.a * Math.PI * 6) * 0.14 * (1 - o.a);
    })
    .onComplete(() => { grp.rotation.y = base; }).start();
}

/** Reveal all six cards of a declared set and sweep them to the centre. */
export function animateClaim(hs, truth, done) {
  const cards = HS_CARDS[hs];
  const flyers = [];

  cards.forEach(cid => {
    const owner = truth[cid];
    let f;
    if (owner === mySeat && myMeshes[cid]) {
      f = myMeshes[cid];
      delete myMeshes[cid];
      myOrder = myOrder.filter(c => c !== cid);
    } else if (owner >= 0 && fans[owner] && fans[owner].length) {
      const back = fans[owner].pop();
      f = buildCard(cid);
      f.position.copy(back.position); f.rotation.copy(back.rotation);
      destroyCard(back);
    } else {
      f = buildCard(cid);
      const t = handTransform(toView(owner >= 0 ? owner : mySeat), 0, 1);
      f.position.copy(t.pos); f.rotation.copy(t.rot);
    }
    flyers.push(f);
  });

  layout(320);

  let remaining = flyers.length;
  flyers.forEach((m, i) => {
    const a = (i / flyers.length) * Math.PI * 2;
    const target = new THREE.Vector3(Math.cos(a) * 2.0, 0.10 + i * 0.02, Math.sin(a) * 2.0);
    tweenTo(m, target, new THREE.Euler(-Math.PI / 2, a, 0, 'YXZ'), 700, i * 55);
    const f = { s: 1 };
    new TWEEN.Tween(f).to({ s: 0.001 }, 460).delay(1150 + i * 55)
      .easing(TWEEN.Easing.Quadratic.In)
      .onUpdate(() => m.scale.setScalar(f.s))
      .onComplete(() => {
        destroyCard(m);
        if (--remaining === 0 && done) done();
      }).start();
  });
  if (!flyers.length && done) done();
}

/* ---------- input ---------- */
function pickTargets() {
  const arr = [];
  for (const cid of myOrder) { const m = myMeshes[cid]; if (m) arr.push(...m.userData.picks); }
  // skip view 0 — that avatar is hidden, and its colliders would sit over your hand
  for (let v = 1; v < avatars.length; v++) arr.push(...avatars[v].userData.picks);
  return arr;
}
function resolve(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.cardId) return { type: 'card', id: o.userData.cardId };
    if (o.userData && o.userData.seat !== undefined) return { type: 'seat', id: o.userData.seat };
    o = o.parent;
  }
  return null;
}
function pickAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickTargets(), false);
  return hits.length ? resolve(hits[0].object) : null;
}
function onPointerMove(ev) {
  const p = pickAt(ev);
  hoverView = (p && p.type === 'seat') ? toView(p.id) : -1;
  renderer.domElement.style.cursor = p ? 'pointer' : 'default';
}
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const p = pickAt(ev);
  if (!p) return;
  if (p.type === 'card' && handlers.onCardClick) handlers.onCardClick(p.id);
  if (p.type === 'seat' && handlers.onSeatClick) handlers.onSeatClick(p.id);
}
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* ---------- loop ---------- */
function loop(t) {
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = lastT ? Math.min(t - lastT, 50) : 16;   // clamped so a backgrounded tab can't dump trauma
  lastT = t;
  TWEEN.update(t);
  controls.update();                                  // OrbitControls owns the camera

  const pulse = 0.65 + Math.sin(t * 0.004) * 0.30;

  /* ---- rings: settled pulse, or a bright head travelling between seats ---- */
  const headRaw = ringSweep >= 1
    ? ringToV
    : ringFromV + shortDelta(ringFromV, ringToV) * ringSweep;
  const head = ((headRaw % 6) + 6) % 6;

  for (let v = 0; v < 6; v++) {
    let o;
    if (ringSweep >= 1) {
      o = (v === ringToV) ? pulse : 0;
      if (v === bloomV) o = Math.min(1, o + bloomK * 0.9);
    } else {
      let d = Math.abs(v - head);
      d = Math.min(d, 6 - d);
      o = Math.max(0, 1 - d);
    }
    const f = ringFlash[v];
    if (f > 0) {
      o = Math.max(o, f);
      _ringCol.copy(RING_TEAM[v] || _flashCol).lerp(_flashCol, f);
      rings[v].material.color.copy(_ringCol);
    } else if (RING_TEAM[v]) {
      rings[v].material.color.copy(RING_TEAM[v]);
    }
    rings[v].material.opacity = o;
    rings[v].scale.setScalar(1 + (v === bloomV ? 0.28 * bloomK : 0));

    const torso = avatars[v].userData.picks[1];
    const want = (v === hoverView) ? 1.06 : 1.0;
    torso.scale.setScalar(THREE.MathUtils.lerp(torso.scale.x, want, 0.18));
    labels[v].material.opacity = (toSeat(v) === activeSeat) ? 1.0 : 0.55;
  }

  /* ---- override → render → restore.
     Never mutate controls or its inputs: with damping on, controls.update()
     recomputes camera.position from its own spherical state every frame and
     would clobber (or fight) anything written between updates. Offsetting
     after update and restoring after render means a player can be mid-drag
     through a shake and nothing desyncs. ---- */
  if (trauma > 0 && !reducedMotion) {
    _savedP.copy(camera.position);
    _savedQ.copy(camera.quaternion);
    const s = trauma * trauma;                        // quadratic: impact, not rumble
    camera.position.x += (Math.random() * 2 - 1) * 0.55 * s;
    camera.position.y += (Math.random() * 2 - 1) * 0.55 * s;
    _roll.setFromAxisAngle(_AXIS_Z, (Math.random() * 2 - 1) * 0.020 * s);
    camera.quaternion.multiply(_roll);                // local Z is the view axis
    renderer.render(scene, camera);
    camera.position.copy(_savedP);
    camera.quaternion.copy(_savedQ);
    trauma = Math.max(0, trauma - dt * 0.0019);       // 1.0 → 0 in ~526ms
  } else {
    renderer.render(scene, camera);
  }
}

export function cardInfoText(cid, myHand) {
  const hs = CARD_HS[cid];
  const mine = myHand.filter(c => CARD_HS[c] === hs).map(cardLabel).join(' ');
  return cardLabel(cid) + '  —  ' + HS_NAME[hs] + '   (you hold: ' + mine + ')';
}
