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
let trackTotalLen = 0; // 트랙 1랩의 총 길이
let accumulatedDistance = 0;

const rankHistory = {}; 
let currentCurve = 0; // 레트로 3D 곡률 및 휠 연동 변수
let carProgressMap = {}; // 차량별 실시간 진행 거리 보관

function buildWorldMapper(trackLine) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of trackLine) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const dataW = maxX - minX || 1; const dataH = maxY - minY || 1;
  return { dataW, dataH, toWorld(x, y) { return [x - minX, dataH - (y - minY)]; } };
}

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

  const smoothingPasses = 10;
  for (let pass = 0; pass < smoothingPasses; pass++) {
    let smoothed = [];
    for (let i = 0; i < dense.length; i++) {
      const prev = dense[(i - 1 + dense.length) % dense.length];
      const curr = dense[i];
      const next = dense[(i + 1) % dense.length];
      smoothed.push({ x: curr.x * 0.5 + prev.x * 0.25 + next.x * 0.25, y: curr.y * 0.5 + prev.y * 0.25 + next.y * 0.25 });
    }
    dense = smoothed;
  }

  let totalDist = 0;
  for (let i = 0; i < dense.length; i++) {
    const curr = dense[i];
    const next = dense[(i + 1) % dense.length];
    curr.heading = Math.atan2(next.y - curr.y, next.x - curr.x);
    curr.d = totalDist;
    totalDist += Math.hypot(next.x - curr.x, next.y - curr.y);
  }
  trackTotalLen = totalDist;
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

// 📌 실시간 진행 거리(Progress) 계산 (유령 차 제거 및 갭 계산용)
function calculateCarProgress(states) {
  carProgressMap = {};
  for (const [dNum, state] of Object.entries(states)) {
    if (!state.visible) { carProgressMap[dNum] = -1; continue; }
    
    let minD = Infinity; let idx = 0;
    for (let i = 0; i < denseTrackLine.length; i += 2) {
      let d = Math.hypot(denseTrackLine[i].x - state.x, denseTrackLine[i].y - state.y);
      if (d < minD) { minD = d; idx = i; }
    }
    
    let lapInfo = provider.getLapInfo(dNum, virtualT);
    let laps = lapInfo ? lapInfo.lapsCompleted : 0;
    carProgressMap[dNum] = (laps * trackTotalLen) + denseTrackLine[idx].d;
  }
}

// ==========================================
// 🏎️ 클래식 유사 3D (Pseudo-3D) 렌더링 엔진 
// ==========================================
function renderFPV(camState, allStates) {
  const fw = viewCockpitWrap.clientWidth;
  const fh = viewCockpitWrap.clientHeight;
  
  fctx.fillStyle = '#87CEEB'; fctx.fillRect(0, 0, fw, fh / 2);
  fctx.fillStyle = '#55a33c'; fctx.fillRect(0, fh / 2, fw, fh / 2);

  if (!camState || !camState.visible || denseTrackLine.length === 0) {
    cockpitDriverName.textContent = 'Select a driver'; return;
  }

  let minD = Infinity; let myIdx = 0;
  for (let i = 0; i < denseTrackLine.length; i++) {
    let d = Math.hypot(denseTrackLine[i].x - camState.x, denseTrackLine[i].y - camState.y);
    if (d < minD) { minD = d; myIdx = i; }
  }

  // 📌 1. 레트로 트랙 곡률 결정 (고정된 좌/우 굽힘)
  let lookAheadMeters = 35;
  let lookIdx = (myIdx + lookAheadMeters) % denseTrackLine.length;
  let diff = denseTrackLine[lookIdx].heading - denseTrackLine[myIdx].heading;
  
  while(diff > Math.PI) diff -= Math.PI*2;
  while(diff < -Math.PI) diff += Math.PI*2;

  let targetCurve = 0;
  if (diff > 0.1) targetCurve = 0.0018;       // Right Turn
  else if (diff < -0.1) targetCurve = -0.0018; // Left Turn

  // 트랙과 휠이 동일한 변수(currentCurve)로 보간되어 100% 완벽한 동기화
  currentCurve += (targetCurve - currentCurve) * 0.1;

  // 📌 2. OutRun 스타일 평면 렌더링 (Z클리핑 완전 면제)
  const maxLz = 150;
  const segLen = 2; // 2m 단위 세그먼트
  const shift = accumulatedDistance % segLen;

  for (let Lz = maxLz; Lz >= 2; Lz -= segLen) {
    let z1 = Lz - shift;
    let z2 = z1 + segLen;
    
    if (z1 < 0.5) continue;
    
    let isDark = Math.floor((accumulatedDistance + z1) / 8) % 2 === 0;
    
    let px1 = fw / 2 + (currentCurve * z1 * z1) / z1 * fw * 0.8;
    let py1 = fh / 2 + (1.1 / z1) * fw * 0.8;
    let px2 = fw / 2 + (currentCurve * z2 * z2) / z2 * fw * 0.8;
    let py2 = fh / 2 + (1.1 / z2) * fw * 0.8;
    
    let w1 = (7 / z1) * fw * 0.8;
    let w2 = (7 / z2) * fw * 0.8;

    const overlapY = py2 - 1.5; 
    const h = Math.max(0, py1 - overlapY);
    
    if (h > 0) {
      fctx.fillStyle = isDark ? '#4c9634' : '#55a33c'; 
      fctx.fillRect(0, overlapY, fw, h + 2);
    }
    
    // 외곽 흰선
    fctx.fillStyle = '#ffffff';
    fctx.beginPath();
    let outW1 = w1 + (1.8 / z1) * fw * 0.8; let outW2 = w2 + (1.8 / z2) * fw * 0.8;
    fctx.moveTo(px1 - outW1, py1); fctx.lineTo(px1 + outW1, py1);
    fctx.lineTo(px2 + outW2, overlapY); fctx.lineTo(px2 - outW2, overlapY);
    fctx.fill();

    // 연석
    fctx.fillStyle = isDark ? '#e74c3c' : '#ffffff'; 
    fctx.beginPath();
    let curbW1 = w1 + (1.2 / z1) * fw * 0.8; let curbW2 = w2 + (1.2 / z2) * fw * 0.8;
    fctx.moveTo(px1 - curbW1, py1); fctx.lineTo(px1 + curbW1, py1);
    fctx.lineTo(px2 + curbW2, overlapY); fctx.lineTo(px2 - curbW2, overlapY);
    fctx.fill();

    // 아스팔트
    fctx.fillStyle = isDark ? '#333333' : '#3a3a3a';
    fctx.beginPath();
    fctx.moveTo(px1 - w1, py1); fctx.lineTo(px1 + w1, py1);
    fctx.lineTo(px2 + w2, overlapY); fctx.lineTo(px2 - w2, overlapY);
    fctx.fill();
  }

  // 📌 3. 차량 렌더링 (진행도 필터링을 통해 유령 차 완벽 제거)
  const myProg = carProgressMap[followedDriver] || 0;
  const carsToDraw = [];

  for (const [dNum, state] of Object.entries(allStates)) {
    if (dNum === followedDriver || !state.visible) continue;
    
    let otherProg = carProgressMap[dNum] || 0;
    let deltaD = otherProg - myProg;
    
    // 내 차 기준으로 0m ~ 200m '앞에' 있는 차만 렌더링
    if (deltaD > 0 && deltaD < 200) {
      // 좌우 차선 편차 계산 (Cross Product)
      let p1 = denseTrackLine[myIdx];
      let p2 = denseTrackLine[(myIdx + 1) % denseTrackLine.length];
      let dx = p2.x - p1.x; let dy = p2.y - p1.y;
      let cx = state.x - p1.x; let cy = state.y - p1.y;
      let lateralOffset = (dx * cy - dy * cx) / Math.hypot(dx, dy); 

      let Lz = deltaD;
      let px = fw / 2 + (lateralOffset + currentCurve * Lz * Lz) / Lz * fw * 0.8;
      let py = fh / 2 + (0.7 / Lz) * fw * 0.8; // Z 오프셋 (차량 띄움)
      
      carsToDraw.push({ Lz, px, py, meta: provider.drivers[dNum], brk: state.brk });
    }
  }

  carsToDraw.sort((a, b) => b.Lz - a.Lz);
  for (const c of carsToDraw) {
    const scale = (1 / c.Lz) * fw * 0.9; 
    carRenderer.drawRearCar(fctx, c.px, c.py, scale, c.meta.color, c.brk === 1);
  }

  // 4. 콕핏 바디 렌더링
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

// 📌 리더보드에 1위와의 시간차(Gap to Leader) 및 바로 앞차와의 시간차(Interval) 추가
function updateLeaderboard(states) {
  const flaggedDrivers = provider.getFlaggedDrivers(virtualT);
  
  const sortedCars = Object.keys(states).map((dNum) => {
    const state = states[dNum];
    const meta = provider.drivers[dNum] || {};
    const lapInfo = provider.getLapInfo(dNum, virtualT);
    return {
       dNum, meta, lapInfo, state,
       prog: carProgressMap[dNum] || -1,
       isFastest: provider.fastestLap && provider.fastestLap.driver === dNum,
       isFlagged: flaggedDrivers.has(dNum),
       isDrsOpen: state.visible && state.drs === 1,
       isDnf: !state.visible
    };
  }).sort((a, b) => b.prog - a.prog); // 진짜 진행 거리 기반 정렬

  const leaderProg = sortedCars[0]?.prog || 0;

  leaderboardListEl.innerHTML = sortedCars.map((r, i) => {
    const rowClasses = ['lb-row'];
    if (r.dNum === followedDriver) rowClasses.push('followed');
    if (r.isDnf) rowClasses.push('dnf'); 
    
    // 시간차(Gap) 근사치 계산 (초속 60m 기준)
    let gapLStr = i === 0 ? 'Leader' : `+${((leaderProg - r.prog) / 60).toFixed(1)}s`;
    let gapPStr = i === 0 ? '' : `+${((sortedCars[i-1].prog - r.prog) / 60).toFixed(1)}s`;
    if (r.isDnf) { gapLStr = 'DNF'; gapPStr = ''; }

    // 공식 포지션 (순위)
    const posLabel = r.isDnf ? '-' : (i + 1);

    let rankArrowHtml = `<div class="rank-arrow" style="opacity:0;">▲</div>`;
    if (!r.isDnf) {
       const history = rankHistory[r.dNum];
       if (!history) rankHistory[r.dNum] = { pos: posLabel, t: virtualT, display: '' };
       else {
         if (history.pos !== posLabel) {
           history.display = history.pos > posLabel ? `<div class="rank-arrow up">▲</div>` : `<div class="rank-arrow down">▼</div>`;
           history.pos = posLabel; history.t = virtualT;
         }
         if (virtualT - history.t < 4.0 && history.display) rankArrowHtml = history.display;
       }
    }

    const tags = [r.isFastest ? '<span class="lb-tag fl">FL</span>' : '', r.isFlagged ? '<span class="lb-tag bw">B/W</span>' : '', r.isDrsOpen ? '<span class="lb-tag drs">DRS</span>' : ''].join('');
    const currentTyre = r.lapInfo.currentCompound ? tyreChipHtml(r.lapInfo.currentCompound, r.lapInfo.currentTyreLife, true) : '';
    const prevTyres = r.lapInfo.previousStints.map((s) => tyreChipHtml(s.compound, s.laps, false)).join('');

    return `<div class="${rowClasses.join(' ')}" data-driver="${r.dNum}">
        <div class="lb-pos-container">${rankArrowHtml}<div class="lb-pos">${posLabel}</div></div>
        <div class="lb-main">
          <div class="lb-top-line">
             <div class="lb-left"><span class="lb-name">${r.meta.code || r.dNum}</span>${tags}</div>
             <div class="lb-times">B: ${formatLapTime(r.lapInfo.bestLapTime)}</div>
          </div>
          <div class="lb-bottom-line">
             <div class="lb-left">${currentTyre}${prevTyres} <div class="lb-gaps"><span class="gap-leader">${gapLStr}</span> <span class="gap-prev">${gapPStr}</span></div></div>
             <div class="lb-times">L: ${formatLapTime(r.lapInfo.lastLapTime)}</div>
          </div>
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

  if (!state || !state.visible || denseTrackLine.length === 0) {
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

  // 📌 휠 완벽 동기화 (트랙의 곡률 변수인 currentCurve와 완전히 동일한 비율로 회전)
  let wheelAngle = currentCurve * 60000; 
  f1Wheel.style.transform = `scale(${scaleFactor}) translateY(${ty}px) rotate(${wheelAngle}deg)`;
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
  
  calculateCarProgress(states); // 순위, 유령차 필터용 진행거리 계산
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
  currentCurve = 0; 
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
