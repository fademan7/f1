/**
 * app.js
 */
import { LocalReplayProvider } from './dataProvider.js';
import { CarRenderer } from './carRenderer.js';

const canvas = document.getElementById('track-canvas');
const ctx = canvas.getContext('2d');
const fpvCanvas = document.getElementById('fpv-canvas');
const fctx = fpvCanvas.getContext('2d');

const viewMapWrap = document.getElementById('view-map');
const viewCockpitWrap = document.getElementById('view-cockpit');

const sessionSelect = document.getElementById('session-select');
const statusTextEl = document.getElementById('status-text');
const lapTextEl = document.getElementById('lap-text');
const flagIndicatorEl = document.getElementById('flag-indicator');
const btnPlay = document.getElementById('btn-play');
const btnViewSwitch = document.getElementById('btn-view-switch'); 
const timeline = document.getElementById('timeline');
const timeDisplay = document.getElementById('time-display');
const speedSelector = document.getElementById('speed-selector');
const leaderboardListEl = document.getElementById('leaderboard-list');

const cockpitDriverName = document.getElementById('cockpit-driver-name');
const f1Wheel = document.getElementById('f1-wheel');
const cpSpeed = document.getElementById('cp-speed');
const cpGear = document.getElementById('cp-gear');
const cpRpm = document.getElementById('cp-rpm');
const cpThr = document.getElementById('cp-thr');
const cpBrk = document.getElementById('cp-brk');
const ledNodes = document.querySelectorAll('#rpm-leds .led');

const TRACK_LINE_WIDTH = 336; 
const CLICK_MOVE_THRESHOLD = 6;
const CAR_HIT_RADIUS_MIN = 30;

const TRACK_STATUS_LABELS = {
  '1': { label: 'CLEAR', color: '#2ecc71' }, '2': { label: 'YELLOW', color: '#f1c40f' },
  '4': { label: 'SC', color: '#f39c12' }, '5': { label: 'RED', color: '#e74c3c' },
  '6': { label: 'VSC', color: '#f39c12' }, '7': { label: 'VSC END', color: '#e0a030' },
};
const COMPOUND_COLORS = { SOFT: '#e30613', MEDIUM: '#f9c000', HARD: '#ffffff', INTERMEDIATE: '#2ecc71', WET: '#3498db' };
const COMPOUND_LETTERS = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

let provider = null;
let worldMapper = null;
let camera = { zoom: 1, panX: 0, panY: 0 };
let zoomBounds = { min: 0.1, max: 10 };
let carRenderer = new CarRenderer();

let isPlaying = false;
let playbackSpeed = 1;
let virtualT = 0;
let lastFrameWallClock = null;
let lastStates = {};
let followedDriver = null;
let isFpvMode = false; 

let denseTrackLine = []; 
let accumulatedDistance = 0;

// 📌 3D 엔진 위치 고정용 글로벌 변수 추가
let followedTrackIdx = null;
let smoothedCamHeading = null; 
const rankHistory = {}; 
let smoothedWheelAngle = 0;

function buildWorldMapper(trackLine) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of trackLine) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const dataW = maxX - minX || 1; const dataH = maxY - minY || 1;
  return { dataW, dataH, toWorld(x, y) { return [x - minX, dataH - (y - minY)]; } };
}

// 📌 차량 이탈 방지를 위해 과도한 스무딩(10회)을 2회로 대폭 축소
function densifyTrack(line, interval = 1.0) {
  if (!line || line.length < 2) return line;
  let dense = [];
  
  for (let i = 0; i < line.length; i++) {
    const p1 = line[i];
    const p2 = line[(i + 1) % line.length];
    const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(1, Math.round(dist / interval));
    for (let j = 0; j < steps; j++) {
      dense.push({ x: p1[0] + (p2[0] - p1[0]) * (j / steps), y: p1[1] + (p2[1] - p1[1]) * (j / steps) });
    }
  }

  // 깎임을 방지하기 위한 최소한의 스무딩만 적용 (2회)
  const smoothingPasses = 2;
  for (let pass = 0; pass < smoothingPasses; pass++) {
    let smoothed = [];
    for (let i = 0; i < dense.length; i++) {
      const prev = dense[(i - 1 + dense.length) % dense.length];
      const curr = dense[i];
      const next = dense[(i + 1) % dense.length];
      smoothed.push({
        x: curr.x * 0.5 + prev.x * 0.25 + next.x * 0.25,
        y: curr.y * 0.5 + prev.y * 0.25 + next.y * 0.25
      });
    }
    dense = smoothed;
  }

  let totalDist = 0;
  for (let i = 0; i < dense.length; i++) {
    const curr = dense[i];
    const next = dense[(i + 1) % dense.length];
    curr.d = totalDist;
    totalDist += Math.hypot(next.x - curr.x, next.y - curr.y);
  }
  return dense;
}

function toScreen(x, y) {
  const [wx, wy] = worldMapper.toWorld(x, y);
  return [camera.panX + camera.zoom * wx, camera.panY + camera.zoom * wy];
}

function fitToTrack() {
  const viewW = viewMapWrap.clientWidth;
  const viewH = viewMapWrap.clientHeight;
  const fitZoom = Math.min((viewW - 120) / worldMapper.dataW, (viewH - 120) / worldMapper.dataH);
  camera.zoom = fitZoom;
  camera.panX = (viewW - worldMapper.dataW * fitZoom) / 2;
  camera.panY = (viewH - worldMapper.dataH * fitZoom) / 2;
  zoomBounds.min = fitZoom * 0.1; zoomBounds.max = fitZoom * 30;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = viewMapWrap.clientWidth * dpr; canvas.height = viewMapWrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fpvCanvas.width = viewCockpitWrap.clientWidth * dpr; fpvCanvas.height = viewCockpitWrap.clientHeight * dpr;
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

btnViewSwitch.addEventListener('click', () => {
  isFpvMode = !isFpvMode;
  document.body.classList.toggle('fpv-mode', isFpvMode);
  setTimeout(() => { resizeCanvas(); fitToTrack(); }, 400); 
});

function drawTrackLine() {
  const line = denseTrackLine;
  if (line.length < 2) return;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = (TRACK_LINE_WIDTH * camera.zoom) + Math.max(4, 6 * camera.zoom);
  ctx.beginPath();
  let [sx, sy] = toScreen(line[0].x, line[0].y);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < line.length; i++) {
    let [px, py] = toScreen(line[i].x, line[i].y);
    ctx.lineTo(px, py);
  }
  ctx.stroke();

  ctx.strokeStyle = '#333333';
  ctx.lineWidth = TRACK_LINE_WIDTH * camera.zoom;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  for (let i = 1; i < line.length; i++) {
    let [px, py] = toScreen(line[i].x, line[i].y);
    ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawCars(states) {
  for (const [driverNum, state] of Object.entries(states)) {
    if (!state.visible) continue;
    const meta = provider.drivers[driverNum] || {};
    const [sx, sy] = toScreen(state.x, state.y);
    carRenderer.drawCar(ctx, sx, sy, -state.heading, camera.zoom, {
      color: meta.color || '#ffffff', code: meta.code || driverNum, braking: state.brk === 1, selected: driverNum === followedDriver,
    });
  }
}

// ==========================================
// 🏎️ 완벽하게 튜닝된 1인칭 카메라 및 렌더링 모듈
// ==========================================
function renderFPV(camState, allStates) {
  const fw = viewCockpitWrap.clientWidth;
  const fh = viewCockpitWrap.clientHeight;
  
  fctx.fillStyle = '#87CEEB'; fctx.fillRect(0, 0, fw, fh / 2);
  fctx.fillStyle = '#55a33c'; fctx.fillRect(0, fh / 2, fw, fh / 2);

  if (!camState || !camState.visible || denseTrackLine.length === 0) {
    cockpitDriverName.textContent = 'Select a driver'; return;
  }

  const trackLen = denseTrackLine.length;

  // 📌 1. 완전한 트랙 스냅 (로컬 서치를 통한 튀어오름 방지)
  if (followedTrackIdx === null) {
    let minD = Infinity; let bestI = 0;
    for (let i = 0; i < trackLen; i++) {
      let d = Math.hypot(denseTrackLine[i].x - camState.x, denseTrackLine[i].y - camState.y);
      if (d < minD) { minD = d; bestI = i; }
    }
    followedTrackIdx = bestI;
  } else {
    let minD = Infinity; let bestI = followedTrackIdx;
    for (let i = -30; i <= 30; i++) {
      let idx = (followedTrackIdx + i + trackLen) % trackLen;
      let d = Math.hypot(denseTrackLine[idx].x - camState.x, denseTrackLine[idx].y - camState.y);
      if (d < minD) { minD = d; bestI = idx; }
    }
    followedTrackIdx = bestI;
  }

  const myIdx = followedTrackIdx;

  // 📌 2. 카메라를 차량 위치보다 6m 뒤로 당겨 화면 하단이 꽉 차게 렌더링 (아스팔트 깨짐 완벽 해결)
  const camIdx = (myIdx - 6 + trackLen) % trackLen;
  const fpvX = denseTrackLine[camIdx].x;
  const fpvY = denseTrackLine[camIdx].y;

  // 전방 15m 지점을 부드럽게 주시
  const lookIdx = (myIdx + 15) % trackLen;
  const targetHeading = Math.atan2(denseTrackLine[lookIdx].y - fpvY, denseTrackLine[lookIdx].x - fpvX);

  if (smoothedCamHeading === null) smoothedCamHeading = targetHeading;
  let dh = targetHeading - smoothedCamHeading;
  while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
  smoothedCamHeading += dh * 0.2; // 부드러운 코너링 시선

  const Fx = Math.cos(smoothedCamHeading); const Fy = Math.sin(smoothedCamHeading);
  const Rx = Math.sin(smoothedCamHeading); const Ry = -Math.cos(smoothedCamHeading);

  // 📌 3. 안전한 클리핑 플레인 설정 (Lz < 1.0 제외)
  function project(x, y, zOffset = 0) {
    const dx = x - fpvX; const dy = y - fpvY;
    const Lz = dx * Fx + dy * Fy; 
    const Lx = dx * Rx + dy * Ry; 
    
    // 카메라 앞 1m 이내의 점들은 렌더링에서 버림(무한대 폭발 방지)
    if (Lz < 1.0) return null; 
    
    const f = 0.85; const camZ = 1.1; 
    const px = fw / 2 + (Lx / Lz) * fw * f;
    const py = fh / 2 + ((camZ - zOffset) / Lz) * fw * f;
    return { px, py, Lz };
  }

  // 앞서 계산한 6m 후방 카메라 기준으로 렌더링을 시작하므로, 차량 바로 밑 화면이 아스팔트로 가득 찹니다.
  const lookaheadPoints = 120; 
  const pts = [];
  for (let i = -2; i < lookaheadPoints; i++) {
    const ptIdx = (myIdx + i + trackLen) % trackLen;
    const pt = denseTrackLine[ptIdx];
    const p = project(pt.x, pt.y);
    if (p) pts.push({...p, d: pt.d});
  }
  
  // 뒤에서부터 덮어 그리기 (Painter's Alg)
  for (let j = pts.length - 2; j >= 0; j--) {
    const p1 = pts[j]; const p2 = pts[j+1];
    
    // 누적 이동거리(accumulatedDistance)를 더해 패턴이 완벽히 미끄러짐
    const isDark = Math.floor((p1.d + accumulatedDistance) / 8) % 2 === 0; 
    
    const overlapY = p2.py - 1.5; 
    const h = Math.max(0, p1.py - overlapY);
    
    if (h > 0) {
      fctx.fillStyle = isDark ? '#4c9634' : '#55a33c'; 
      fctx.fillRect(0, overlapY, fw, h + 2);
    }
    
    const w1 = (7 / p1.Lz) * fw * 0.8; 
    const w2 = (7 / p2.Lz) * fw * 0.8;
    
    fctx.fillStyle = '#ffffff';
    fctx.beginPath();
    const outW1 = w1 + (1.8 / p1.Lz) * fw * 0.8;
    const outW2 = w2 + (1.8 / p2.Lz) * fw * 0.8;
    fctx.moveTo(p1.px - outW1, p1.py); fctx.lineTo(p1.px + outW1, p1.py);
    fctx.lineTo(p2.px + outW2, overlapY); fctx.lineTo(p2.px - outW2, overlapY);
    fctx.fill();

    fctx.fillStyle = isDark ? '#e74c3c' : '#ffffff'; 
    fctx.beginPath();
    const curbW1 = w1 + (1.2 / p1.Lz) * fw * 0.8;
    const curbW2 = w2 + (1.2 / p2.Lz) * fw * 0.8;
    fctx.moveTo(p1.px - curbW1, p1.py); fctx.lineTo(p1.px + curbW1, p1.py);
    fctx.lineTo(p2.px + curbW2, overlapY); fctx.lineTo(p2.px - curbW2, overlapY);
    fctx.fill();

    fctx.fillStyle = isDark ? '#333333' : '#3a3a3a';
    fctx.beginPath();
    fctx.moveTo(p1.px - w1, p1.py); fctx.lineTo(p1.px + w1, p1.py);
    fctx.lineTo(p2.px + w2, overlapY); fctx.lineTo(p2.px - w2, overlapY);
    fctx.fill();
  }

  const carsToDraw = [];
  for (const [dNum, state] of Object.entries(allStates)) {
    if (dNum === followedDriver || !state.visible) continue;
    const p = project(state.x, state.y, 0.4);
    if (p && p.Lz < 250) carsToDraw.push({ p, dNum, meta: provider.drivers[dNum], state });
  }
  carsToDraw.sort((a, b) => b.p.Lz - a.p.Lz);
  for (const c of carsToDraw) {
    const scale = (1 / c.p.Lz) * fw * 0.9; 
    carRenderer.drawRearCar(fctx, c.p.px, c.p.py, scale, c.meta.color, c.state.brk === 1);
  }

  // 내 차 콕핏 인테리어
  fctx.save();
  fctx.translate(fw / 2, fh);
  const tScale = isFpvMode ? 1.4 : 1.0; 
  
  fctx.fillStyle = '#0a0a0a';
  fctx.fillRect(-fw * 0.35, -fh * 0.35, fw * 0.12, fh * 0.5); 
  fctx.fillRect(fw * 0.23, -fh * 0.35, fw * 0.12, fh * 0.5); 
  
  fctx.strokeStyle = '#151515'; fctx.lineWidth = 8;
  fctx.beginPath(); fctx.moveTo(-fw*0.3, -fh*0.25); fctx.lineTo(0, -fh*0.1); fctx.stroke();
  fctx.beginPath(); fctx.moveTo(fw*0.3, -fh*0.25); fctx.lineTo(0, -fh*0.1); fctx.stroke();

  const teamColor = provider.drivers[followedDriver]?.color || '#ffffff';
  fctx.fillStyle = teamColor;
  fctx.beginPath();
  fctx.moveTo(-fw * 0.12 * tScale, 0); fctx.lineTo(fw * 0.12 * tScale, 0); 
  fctx.lineTo(fw * 0.04 * tScale, -fh * 0.35); fctx.lineTo(-fw * 0.04 * tScale, -fh * 0.35); 
  fctx.fill();

  fctx.fillStyle = '#0d0d0f';
  fctx.beginPath();
  fctx.moveTo(-fw * 0.5, 0); fctx.lineTo(-fw * 0.5, -fh * 0.45);
  fctx.lineTo(-fw * 0.25, -fh * 0.25); fctx.quadraticCurveTo(0, -fh * 0.1, fw * 0.25, -fh * 0.25);
  fctx.lineTo(fw * 0.5, -fh * 0.45); fctx.lineTo(fw * 0.5, 0);
  fctx.fill();
  
  fctx.restore();
}

function formatLapTime(seconds) { return seconds == null ? '-' : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, '0')}`; }
function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function tyreChipHtml(compound, laps, isCurrent) { const color = COMPOUND_COLORS[compound] || '#888'; const letter = COMPOUND_LETTERS[compound] || '?'; return `<div class="${isCurrent ? 'tyre-chip current' : 'tyre-chip prev'}" style="border-color:${color}; color:${color};" title="${compound || '?'} - ${laps} Laps">${laps ?? letter}</div>`; }

function updateLeaderboard(states) {
  const flaggedDrivers = provider.getFlaggedDrivers(virtualT);
  const rows = Object.entries(states).map(([driverNum, state]) => {
    const meta = provider.drivers[driverNum] || {};
    const lapInfo = provider.getLapInfo(driverNum, virtualT);
    return { driverNum, meta, lapInfo, isFastest: provider.fastestLap && provider.fastestLap.driver === driverNum, isFlagged: flaggedDrivers.has(driverNum), pos: state.visible && state.pos != null ? state.pos : 9999, isDrsOpen: state.visible && state.drs === 1, isDnf: !state.visible };
  });

  rows.sort((a, b) => a.pos - b.pos);
  leaderboardListEl.innerHTML = rows.map((r) => {
    const rowClasses = ['lb-row'];
    if (r.driverNum === followedDriver) rowClasses.push('followed');
    if (r.isDnf) rowClasses.push('dnf'); 
    
    let rankArrowHtml = `<div class="rank-arrow" style="opacity:0;">▲</div>`;
    if (r.pos !== 9999) {
       const history = rankHistory[r.driverNum];
       if (!history) rankHistory[r.driverNum] = { pos: r.pos, t: virtualT, display: '' };
       else {
         if (history.pos !== r.pos) {
           history.display = history.pos > r.pos ? `<div class="rank-arrow up">▲</div>` : `<div class="rank-arrow down">▼</div>`;
           history.pos = r.pos; history.t = virtualT;
         }
         if (virtualT - history.t < 4.0 && history.display) rankArrowHtml = history.display;
       }
    }
    const tags = [r.isFastest ? '<span class="lb-tag fl">FL</span>' : '', r.isFlagged ? '<span class="lb-tag bw">B/W</span>' : '', r.isDrsOpen ? '<span class="lb-tag drs">DRS</span>' : ''].join('');
    const currentTyre = r.lapInfo.currentCompound ? tyreChipHtml(r.lapInfo.currentCompound, r.lapInfo.currentTyreLife, true) : '';
    const prevTyres = r.lapInfo.previousStints.map((s) => tyreChipHtml(s.compound, s.laps, false)).join('');

    return `<div class="${rowClasses.join(' ')}" data-driver="${r.driverNum}">
        <div class="lb-pos-container">${rankArrowHtml}<div class="lb-pos">${r.pos === 9999 ? '-' : r.pos}</div></div>
        <div class="lb-main">
          <div class="lb-left"><span class="lb-name">${r.meta.code || r.driverNum}</span>${tags}${currentTyre}${prevTyres}</div>
          <div class="lb-right"><div class="lb-times">B: ${formatLapTime(r.lapInfo.bestLapTime)}</div><div class="lb-times">L: ${formatLapTime(r.lapInfo.lastLapTime)}</div></div>
        </div>
      </div>`;
  }).join('');
}

leaderboardListEl.addEventListener('mousedown', (e) => { const row = e.target.closest('.lb-row'); if (row) setFollowedDriver(row.dataset.driver); });

function updateTopPanelInfo(states) {
  const status = provider.getTrackStatusAt(virtualT);
  const info = TRACK_STATUS_LABELS[status] || TRACK_STATUS_LABELS['1'];
  flagIndicatorEl.style.background = info.color;
  flagIndicatorEl.title = `Status: ${info.label}`;
  let maxLap = 0;
  for (const driverNum of Object.keys(states)) {
    const lapInfo = provider.getLapInfo(driverNum, virtualT);
    if (lapInfo && lapInfo.lapsCompleted > maxLap) maxLap = lapInfo.lapsCompleted;
  }
  lapTextEl.textContent = `Lap ${Math.max(1, maxLap + 1)} / ${provider.totalLaps || '?'}`;
}

// 🏎️ 오직 트랙의 곡률(Curvature)만으로 작동하는 완벽한 스티어링 휠
function updateCockpitHud(states) {
  const state = followedDriver ? states[followedDriver] : null;
  const scaleFactor = isFpvMode ? 1.8 : 0.65;
  const ty = isFpvMode ? -20 : 40;

  if (!state || !state.visible || followedTrackIdx === null || denseTrackLine.length === 0) {
    cpSpeed.textContent = '-'; cpGear.textContent = '-'; cpRpm.textContent = '-';
    cpThr.style.width = '0%'; cpBrk.style.width = '0%';
    f1Wheel.style.transform = `scale(${scaleFactor}) translateY(${ty}px) rotate(0deg)`;
    ledNodes.forEach(led => led.className = 'led');
    return;
  }
  
  const meta = provider.drivers[followedDriver] || {};
  cockpitDriverName.textContent = `${meta.code || followedDriver} · ${meta.team || ''}`;
  cpSpeed.textContent = Math.round(state.v); cpGear.textContent = state.gear > 0 ? state.gear : 'N'; cpRpm.textContent = Math.round(state.rpm);
  cpThr.style.width = `${Math.max(0, Math.min(100, state.thr))}%`; cpBrk.style.width = state.brk ? '100%' : '0%';

  const rpmRatio = Math.max(0, Math.min(1, (state.rpm - 8000) / 4000));
  const ledCount = Math.floor(rpmRatio * 15);
  ledNodes.forEach((led, idx) => {
    if (idx < ledCount) {
      if (idx < 5) led.className = 'led on green'; else if (idx < 10) led.className = 'led on red'; else led.className = 'led on blue';
    } else led.className = 'led';
  });

  // 📌 원시 데이터(Yaw)를 버리고, '지금 지나가는 트랙 각도'와 '15m 앞의 트랙 각도'의 차이를 구해 핸들을 꺾음
  const len = denseTrackLine.length;
  
  // 현재 트랙 각도
  const pA = denseTrackLine[followedTrackIdx];
  const pB = denseTrackLine[(followedTrackIdx + 2) % len];
  const currAngle = Math.atan2(pB.y - pA.y, pB.x - pA.x);

  // 15m 앞의 트랙 각도
  const pC = denseTrackLine[(followedTrackIdx + 15) % len];
  const pD = denseTrackLine[(followedTrackIdx + 17) % len];
  const futureAngle = Math.atan2(pD.y - pC.y, pD.x - pC.x);

  let diff = futureAngle - currAngle;
  while(diff > Math.PI) diff -= Math.PI * 2;
  while(diff < -Math.PI) diff += Math.PI * 2;

  // 곡률 차이를 스티어링 휠 각도로 변환 (차량이 직선에 있으면 무조건 0도 복귀)
  let targetWheelAngle = (diff * 180 / Math.PI) * 4.0; 
  targetWheelAngle = Math.max(-160, Math.min(160, targetWheelAngle)); 
  
  // 부드러운 손동작 연출
  smoothedWheelAngle += (targetWheelAngle - smoothedWheelAngle) * 0.15;
  
  f1Wheel.style.transform = `scale(${scaleFactor}) translateY(${ty}px) rotate(${smoothedWheelAngle}deg)`;
}

function renderMainFrame(states) {
  ctx.clearRect(0, 0, viewMapWrap.clientWidth, viewMapWrap.clientHeight);
  drawTrackLine(); drawCars(states);
  timeline.value = Math.round((virtualT - provider.startTime) * 10);
  timeDisplay.textContent = formatTime(virtualT - provider.startTime);
}

function applyFollowCamera(states) {
  if (!followedDriver) return;
  const state = states[followedDriver];
  if (!state || !state.visible) return;
  const [wx, wy] = worldMapper.toWorld(state.x, state.y);
  camera.panX = viewMapWrap.clientWidth / 2 - camera.zoom * wx;
  camera.panY = viewMapWrap.clientHeight / 2 - camera.zoom * wy;
}

function tick(nowMs) {
  if (lastFrameWallClock === null) lastFrameWallClock = nowMs;
  const deltaSec = (nowMs - lastFrameWallClock) / 1000;
  lastFrameWallClock = nowMs;

  if (isPlaying) {
    virtualT += deltaSec * playbackSpeed;
    const endT = provider.startTime + provider.duration;
    if (virtualT > endT) virtualT = endT;

    if (followedDriver && lastStates[followedDriver]) {
      accumulatedDistance += (lastStates[followedDriver].v / 3.6) * deltaSec * playbackSpeed;
    }
  }

  const states = provider.getStateAt(virtualT);
  lastStates = states;
  
  applyFollowCamera(states);
  renderMainFrame(states); 
  renderFPV(followedDriver ? states[followedDriver] : null, states); 
  
  updateLeaderboard(states);
  updateTopPanelInfo(states);
  updateCockpitHud(states);

  requestAnimationFrame(tick);
}

function zoomAt(screenX, screenY, zoomFactor) {
  const newZoom = Math.min(zoomBounds.max, Math.max(zoomBounds.min, camera.zoom * zoomFactor));
  const worldX = (screenX - camera.panX) / camera.zoom;
  const worldY = (screenY - camera.panY) / camera.zoom;
  camera.panX = screenX - worldX * newZoom;
  camera.panY = screenY - worldY * newZoom;
  camera.zoom = newZoom;
}

function setFollowedDriver(driverNum) {
  followedDriver = driverNum || null;
  smoothedWheelAngle = 0; smoothedCamHeading = null; followedTrackIdx = null;
}

function handleCanvasClick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const clickX = clientX - rect.left;
  const clickY = clientY - rect.top;
  let hitDriver = null; let hitDist = Infinity;
  for (const [driverNum, state] of Object.entries(lastStates)) {
    if (!state.visible) continue;
    const [sx, sy] = toScreen(state.x, state.y);
    const dist = Math.hypot(sx - clickX, sy - clickY);
    if (dist < Math.max(CAR_HIT_RADIUS_MIN, 128 * camera.zoom * 0.6) && dist < hitDist) { hitDriver = driverNum; hitDist = dist; }
  }
  setFollowedDriver(hitDriver);
}

function wireCameraControls() {
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  canvas.addEventListener('mousedown', (e) => { let isDragging = true; let dragStart = { x: e.clientX, y: e.clientY }; let panStart = { x: camera.panX, y: camera.panY }; canvas.style.cursor = 'grabbing'; 
    const onMove = (me) => { if (!isDragging) return; const dx = me.clientX - dragStart.x; const dy = me.clientY - dragStart.y; if (followedDriver && Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) setFollowedDriver(null); camera.panX = panStart.x + dx; camera.panY = panStart.y + dy; };
    const onUp = (ue) => { if (!isDragging) return; isDragging = false; canvas.style.cursor = 'grab'; if (Math.hypot(ue.clientX - dragStart.x, ue.clientY - dragStart.y) < CLICK_MOVE_THRESHOLD) handleCanvasClick(ue.clientX, ue.clientY); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  });
  canvas.addEventListener('dblclick', () => { setFollowedDriver(null); fitToTrack(); });
}

function wirePlaybackControls() {
  btnPlay.addEventListener('click', () => { isPlaying = !isPlaying; btnPlay.textContent = isPlaying ? '⏸' : '▶'; });
  speedSelector.addEventListener('change', (e) => { playbackSpeed = Number(e.target.value); });
  timeline.addEventListener('input', (e) => { virtualT = provider.startTime + provider.duration * (Number(e.target.value) / Number(timeline.max)); });
  window.addEventListener('resize', () => { resizeCanvas(); fitToTrack(); });
}

async function loadSession(filename) {
  isPlaying = false; btnPlay.textContent = '▶'; statusTextEl.textContent = 'Loading session data...';
  try { provider = await LocalReplayProvider.load(`data/${filename}`); } catch (err) { statusTextEl.textContent = `Failed to load: ${err.message}`; return; }

  Object.keys(rankHistory).forEach(k => delete rankHistory[k]);
  lastStates = {}; setFollowedDriver(null); 
  worldMapper = buildWorldMapper(provider.trackLine);
  
  denseTrackLine = densifyTrack(provider.trackLine, 1.0);
  accumulatedDistance = 0;

  virtualT = provider.startTime; timeline.max = Math.max(1, Math.round(provider.duration * 10));

  statusTextEl.innerHTML = `${Object.keys(provider.drivers).length} cars loaded.`;
  resizeCanvas(); fitToTrack();
}

async function main() {
  try {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error('Error loading index.json');
    const sessionList = await res.json();
    sessionSelect.innerHTML = '';
    sessionList.forEach(session => { const opt = document.createElement('option'); opt.value = session.filename; opt.textContent = session.name; sessionSelect.appendChild(opt); });
    sessionSelect.addEventListener('change', (e) => { loadSession(e.target.value); });
    if (sessionList.length > 0) await loadSession(sessionList[0].filename);
  } catch (err) { statusTextEl.textContent = `index.json error`; return; }

  wireCameraControls(); wirePlaybackControls(); requestAnimationFrame(tick);
}

main();
