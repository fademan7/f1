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

// 🏎️ 3D 엔진용 변수
let denseTrackLine = []; 
let accumulatedDistance = 0;

// 카메라 스무딩 변수 (계단 현상 제거용)
let smoothFpvX = null;
let smoothFpvY = null;
let smoothedCamHeading = null; 

const rankHistory = {}; 
let lastCockpitHeading = null;
let lastCockpitVirtualT = null;
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

// 1m 단위 초고밀도 분할 알고리즘
function densifyTrack(line, interval = 1.0) {
  if (!line || line.length < 2) return line;
  const dense = [];
  for (let i = 0; i < line.length; i++) {
    const p1 = line[i];
    const p2 = line[(i + 1) % line.length];
    const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(1, Math.round(dist / interval));
    for (let j = 0; j < steps; j++) {
      dense.push({
        x: p1[0] + (p2[0] - p1[0]) * (j / steps),
        y: p1[1] + (p2[1] - p1[1]) * (j / steps)
      });
    }
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
  const line = provider.trackLine;
  if (line.length < 2) return;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = (TRACK_LINE_WIDTH * camera.zoom) + Math.max(4, 6 * camera.zoom);
  ctx.beginPath();
  let [sx, sy] = toScreen(line[0][0], line[0][1]);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < line.length; i++) {
    let [px, py] = toScreen(line[i][0], line[i][1]);
    ctx.lineTo(px, py);
  }
  ctx.stroke();

  ctx.strokeStyle = '#333333';
  ctx.lineWidth = TRACK_LINE_WIDTH * camera.zoom;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  for (let i = 1; i < line.length; i++) {
    let [px, py] = toScreen(line[i][0], line[i][1]);
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
// 🏎️ 완성형 1인칭 FPV 렌더링 엔진 (Magnetic Snap & Sub-pixel Smooth)
// ==========================================
function renderFPV(camState, allStates) {
  const fw = viewCockpitWrap.clientWidth;
  const fh = viewCockpitWrap.clientHeight;
  
  fctx.fillStyle = '#87CEEB'; fctx.fillRect(0, 0, fw, fh / 2);
  fctx.fillStyle = '#55a33c'; fctx.fillRect(0, fh / 2, fw, fh / 2);

  if (!camState || !camState.visible || denseTrackLine.length === 0) {
    cockpitDriverName.textContent = '차량을 선택하세요'; return;
  }

  // 1. 가장 가까운 트랙 기준점 찾기
  let minDist = Infinity; let startIdx = 0;
  for (let i = 0; i < denseTrackLine.length; i++) {
    const pt = denseTrackLine[i];
    const dist = Math.hypot(pt.x - camState.x, pt.y - camState.y);
    if (dist < minDist) { minDist = dist; startIdx = i; }
  }

  // 📌 2. 자석 스냅 & 스무딩 (잔디 이탈 방지 + 계단현상 완벽 제거)
  let fpvX, fpvY, fpvHeading;

  if (minDist < 30) { 
    // 트랙 중앙(Apex) 목표 좌표
    const targetX = denseTrackLine[startIdx].x;
    const targetY = denseTrackLine[startIdx].y;
    
    // 초기화 또는 부드러운 카메라 이동 (Low-pass filter)
    if (smoothFpvX === null) { smoothFpvX = targetX; smoothFpvY = targetY; }
    else { smoothFpvX += (targetX - smoothFpvX) * 0.2; smoothFpvY += (targetY - smoothFpvY) * 0.2; }
    
    fpvX = smoothFpvX; fpvY = smoothFpvY;

    // 전방 5m 지점을 주시하여 부드러운 코너링 연출
    const lookIdx = (startIdx + 5) % denseTrackLine.length;
    const targetHeading = Math.atan2(denseTrackLine[lookIdx].y - fpvY, denseTrackLine[lookIdx].x - fpvX);
    
    if (smoothedCamHeading === null) smoothedCamHeading = targetHeading;
    let dh = targetHeading - smoothedCamHeading;
    while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
    smoothedCamHeading += dh * 0.25; 
    
    fpvHeading = smoothedCamHeading;
  } else {
    // 피트레인 등 완전히 트랙 밖일 때는 원본 좌표 유지
    fpvX = camState.x; fpvY = camState.y; fpvHeading = camState.heading;
    smoothFpvX = null; smoothedCamHeading = null;
  }

  // 스티어링 휠로 정확한 트랙 곡률 데이터 전달
  camState.fpvHeading = fpvHeading;

  const Fx = Math.cos(fpvHeading); const Fy = Math.sin(fpvHeading);
  const Rx = Math.sin(fpvHeading); const Ry = -Math.cos(fpvHeading);

  function project(x, y, zOffset = 0) {
    const dx = x - fpvX; const dy = y - fpvY;
    const Lz = dx * Fx + dy * Fy; 
    const Lx = dx * Rx + dy * Ry; 
    if (Lz < 0.1) return null; 
    const f = 0.85; const camZ = 1.0; 
    const px = fw / 2 + (Lx / Lz) * fw * f;
    const py = fh / 2 + ((camZ - zOffset) / Lz) * fw * f;
    return { px, py, Lz };
  }

  // 3. 전방 150m 트랙 그리기
  const lookaheadPoints = 150; 
  const pts = [];
  for (let i = 0; i < lookaheadPoints; i++) {
    const pt = denseTrackLine[(startIdx + i) % denseTrackLine.length];
    const p = project(pt.x, pt.y);
    if (p) pts.push(p);
  }
  
  for (let j = pts.length - 2; j >= 0; j--) {
    const p1 = pts[j]; const p2 = pts[j+1];
    
    // 📌 서브픽셀 스크롤링: 누적 거리를 인덱스에 더해 완벽하게 부드러운 질감 이동
    const isDark = Math.floor((j + accumulatedDistance) / 8) % 2 === 0; 
    
    const h = p1.py - p2.py;
    if (h > 0) {
      fctx.fillStyle = isDark ? '#4c9634' : '#55a33c'; 
      fctx.fillRect(0, p2.py, fw, h + 1.5);
    }
    
    const w1 = (7 / p1.Lz) * fw * 0.8; 
    const w2 = (7 / p2.Lz) * fw * 0.8;
    
    // 외곽 흰색 테두리 라인 추가
    fctx.fillStyle = '#ffffff';
    fctx.beginPath();
    const outW1 = w1 + (1.8 / p1.Lz) * fw * 0.8;
    const outW2 = w2 + (1.8 / p2.Lz) * fw * 0.8;
    fctx.moveTo(p1.px - outW1, p1.py); fctx.lineTo(p1.px + outW1, p1.py);
    fctx.lineTo(p2.px + outW2, p2.py); fctx.lineTo(p2.px - outW2, p2.py);
    fctx.fill();

    // 연석 (빨강/하양)
    fctx.fillStyle = isDark ? '#e74c3c' : '#ffffff'; 
    fctx.beginPath();
    const curbW1 = w1 + (1.2 / p1.Lz) * fw * 0.8;
    const curbW2 = w2 + (1.2 / p2.Lz) * fw * 0.8;
    fctx.moveTo(p1.px - curbW1, p1.py); fctx.lineTo(p1.px + curbW1, p1.py);
    fctx.lineTo(p2.px + curbW2, p2.py); fctx.lineTo(p2.px - curbW2, p2.py);
    fctx.fill();

    // 아스팔트
    fctx.fillStyle = isDark ? '#333333' : '#3a3a3a';
    fctx.beginPath();
    fctx.moveTo(p1.px - w1, p1.py); fctx.lineTo(p1.px + w1, p1.py);
    fctx.lineTo(p2.px + w2, p2.py); fctx.lineTo(p2.px - w2, p2.py);
    fctx.fill();
  }

  // 4. 주변 차량 그리기
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

  // 5. 내 차의 콕핏 바디 및 노즈 렌더링
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
  fctx.moveTo(-fw * 0.12 * tScale, 0); 
  fctx.lineTo(fw * 0.12 * tScale, 0); 
  fctx.lineTo(fw * 0.04 * tScale, -fh * 0.35); 
  fctx.lineTo(-fw * 0.04 * tScale, -fh * 0.35); 
  fctx.fill();

  fctx.fillStyle = '#0d0d0f';
  fctx.beginPath();
  fctx.moveTo(-fw * 0.5, 0);
  fctx.lineTo(-fw * 0.5, -fh * 0.45);
  fctx.lineTo(-fw * 0.25, -fh * 0.25);
  fctx.quadraticCurveTo(0, -fh * 0.1, fw * 0.25, -fh * 0.25);
  fctx.lineTo(fw * 0.5, -fh * 0.45);
  fctx.lineTo(fw * 0.5, 0);
  fctx.fill();
  
  fctx.restore();
}

function formatLapTime(seconds) { return seconds == null ? '-' : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, '0')}`; }
function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function tyreChipHtml(compound, laps, isCurrent) { const color = COMPOUND_COLORS[compound] || '#888'; const letter = COMPOUND_LETTERS[compound] || '?'; return `<div class="${isCurrent ? 'tyre-chip current' : 'tyre-chip prev'}" style="border-color:${color}; color:${color};" title="${compound || '?'} - ${laps}랩">${laps ?? letter}</div>`; }

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

function updateCockpitHud(states) {
  const state = followedDriver ? states[followedDriver] : null;
  const scaleFactor = isFpvMode ? 1.8 : 0.65;
  const ty = isFpvMode ? -20 : 40;

  if (!state || !state.visible) {
    cpSpeed.textContent = '-'; cpGear.textContent = '-'; cpRpm.textContent = '-';
    cpThr.style.width = '0%'; cpBrk.style.width = '0%';
    f1Wheel.style.transform = `scale(${scaleFactor}) translateY(${ty}px) rotate(0deg)`;
    ledNodes.forEach(led => led.className = 'led');
    lastCockpitHeading = null; return;
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

  // 📌 휠 완벽 동기화: 트랙 스냅으로 계산된 안정적인 fpvHeading 사용
  let currentHeading = state.fpvHeading !== undefined ? state.fpvHeading : state.heading;

  if (lastCockpitHeading !== null && lastCockpitVirtualT !== null) {
    const dt = virtualT - lastCockpitVirtualT;
    if (dt > 0 && state.v > 10) { 
      let dh = currentHeading - lastCockpitHeading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      let yawRateDeg = (dh * 180 / Math.PI) / dt;
      let targetWheelAngle = -yawRateDeg * 2.5; 
      targetWheelAngle = Math.max(-150, Math.min(150, targetWheelAngle)); 
      smoothedWheelAngle += (targetWheelAngle - smoothedWheelAngle) * 0.25;
    }
  } else smoothedWheelAngle = 0;
  
  lastCockpitHeading = currentHeading; lastCockpitVirtualT = virtualT;
  
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

    // 📌 서브픽셀 스크롤을 위한 차량 이동 거리(m/s) 누적
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
  smoothedWheelAngle = 0; lastCockpitHeading = null; 
  smoothFpvX = null; smoothedCamHeading = null;
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
  isPlaying = false; btnPlay.textContent = '▶'; statusTextEl.textContent = '세션 데이터 로딩 중...';
  try { provider = await LocalReplayProvider.load(`data/${filename}`); } catch (err) { statusTextEl.textContent = `로드 실패: ${err.message}`; return; }

  Object.keys(rankHistory).forEach(k => delete rankHistory[k]);
  lastStates = {}; setFollowedDriver(null); 
  worldMapper = buildWorldMapper(provider.trackLine);
  
  denseTrackLine = densifyTrack(provider.trackLine, 1.0);
  accumulatedDistance = 0;

  virtualT = provider.startTime; timeline.max = Math.max(1, Math.round(provider.duration * 10));

  statusTextEl.innerHTML = `${Object.keys(provider.drivers).length}대 로드 완료.`;
  resizeCanvas(); fitToTrack();
}

async function main() {
  try {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error('index.json 없음');
    const sessionList = await res.json();
    sessionSelect.innerHTML = '';
    sessionList.forEach(session => { const opt = document.createElement('option'); opt.value = session.filename; opt.textContent = session.name; sessionSelect.appendChild(opt); });
    sessionSelect.addEventListener('change', (e) => { loadSession(e.target.value); });
    if (sessionList.length > 0) await loadSession(sessionList[0].filename);
  } catch (err) { statusTextEl.textContent = `index.json 오류`; return; }

  wireCameraControls(); wirePlaybackControls(); requestAnimationFrame(tick);
}

main();
