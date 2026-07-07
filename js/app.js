/**
 * app.js
 */
import { LocalReplayProvider } from './dataProvider.js';
import { CarRenderer } from './carRenderer.js';

const canvas = document.getElementById('track-canvas');
const ctx = canvas.getContext('2d');
const sessionSelect = document.getElementById('session-select');
const statusTextEl = document.getElementById('status-text');
const lapTextEl = document.getElementById('lap-text');
const flagIndicatorEl = document.getElementById('flag-indicator');
const btnPlay = document.getElementById('btn-play');
const timeline = document.getElementById('timeline');
const timeDisplay = document.getElementById('time-display');
const speedSelector = document.getElementById('speed-selector');
const leaderboardListEl = document.getElementById('leaderboard-list');

// 🏎️ 콕핏 UI DOM 엘리먼트 
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
  '1': { label: 'CLEAR', color: '#2ecc71' },
  '2': { label: 'YELLOW', color: '#f1c40f' },
  '4': { label: 'SC', color: '#f39c12' },
  '5': { label: 'RED', color: '#e74c3c' },
  '6': { label: 'VSC', color: '#f39c12' },
  '7': { label: 'VSC END', color: '#e0a030' },
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

// 스티어링 회전 연산용 변수
const rankHistory = {}; 
let lastCockpitHeading = null;
let lastCockpitVirtualT = null;
let smoothedWheelAngle = 0;

function buildWorldMapper(trackLine) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of trackLine) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  return {
    dataW, dataH,
    toWorld(x, y) { return [x - minX, dataH - (y - minY)]; },
  };
}

function toScreen(x, y) {
  const [wx, wy] = worldMapper.toWorld(x, y);
  return [camera.panX + camera.zoom * wx, camera.panY + camera.zoom * wy];
}

function fitToTrack() {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const padding = 60;
  const fitZoom = Math.min((viewW - padding * 2) / worldMapper.dataW, (viewH - padding * 2) / worldMapper.dataH);
  camera.zoom = fitZoom;
  camera.panX = (viewW - worldMapper.dataW * fitZoom) / 2;
  camera.panY = (viewH - worldMapper.dataH * fitZoom) / 2;
  zoomBounds.min = fitZoom * 0.1;
  zoomBounds.max = fitZoom * 30;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

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
      color: meta.color || '#ffffff',
      code: meta.code || driverNum,
      braking: state.brk === 1,
      selected: driverNum === followedDriver,
    });
  }
}

function formatLapTime(seconds) {
  if (seconds == null) return '-';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function tyreChipHtml(compound, laps, isCurrent) {
  const color = COMPOUND_COLORS[compound] || '#888';
  const letter = COMPOUND_LETTERS[compound] || '?';
  const cls = isCurrent ? 'tyre-chip current' : 'tyre-chip prev';
  return `<div class="${cls}" style="border-color:${color}; color:${color};" title="${compound || '?'} - ${laps}랩">${laps ?? letter}</div>`;
}

function updateLeaderboard(states) {
  const flaggedDrivers = provider.getFlaggedDrivers(virtualT);
  const rows = Object.entries(states).map(([driverNum, state]) => {
    const meta = provider.drivers[driverNum] || {};
    const lapInfo = provider.getLapInfo(driverNum, virtualT);
    const isFastest = provider.fastestLap && provider.fastestLap.driver === driverNum;
    const isFlagged = flaggedDrivers.has(driverNum);
    const pos = state.visible && state.pos != null ? state.pos : 9999;
    return { driverNum, meta, lapInfo, isFastest, isFlagged, pos, isDrsOpen: state.visible && state.drs === 1, isDnf: !state.visible };
  });

  rows.sort((a, b) => a.pos - b.pos);

  leaderboardListEl.innerHTML = rows.map((r) => {
    const posLabel = r.pos === 9999 ? '-' : r.pos;
    const rowClasses = ['lb-row'];
    if (r.driverNum === followedDriver) rowClasses.push('followed');
    if (r.isDnf) rowClasses.push('dnf'); 
    
    let rankArrowHtml = `<div class="rank-arrow" style="opacity:0;">▲</div>`;
    if (r.pos !== 9999) {
       const history = rankHistory[r.driverNum];
       if (!history) rankHistory[r.driverNum] = { pos: r.pos, t: virtualT, display: '' };
       else {
         if (history.pos !== r.pos) {
           if (history.pos > r.pos) history.display = `<div class="rank-arrow up">▲</div>`;
           else history.display = `<div class="rank-arrow down">▼</div>`;
           history.pos = r.pos; history.t = virtualT;
         }
         if (virtualT - history.t < 4.0 && history.display) rankArrowHtml = history.display;
       }
    }

    const tags = [
      r.isFastest ? '<span class="lb-tag fl">FL</span>' : '',
      r.isFlagged ? '<span class="lb-tag bw">B/W</span>' : '',
      r.isDrsOpen ? '<span class="lb-tag drs">DRS</span>' : ''
    ].join('');

    const currentTyre = r.lapInfo.currentCompound ? tyreChipHtml(r.lapInfo.currentCompound, r.lapInfo.currentTyreLife, true) : '';
    const prevTyres = r.lapInfo.previousStints.map((s) => tyreChipHtml(s.compound, s.laps, false)).join('');

    return `
      <div class="${rowClasses.join(' ')}" data-driver="${r.driverNum}">
        <div class="lb-pos-container">${rankArrowHtml}<div class="lb-pos">${posLabel}</div></div>
        <div class="lb-main">
          <div class="lb-left"><span class="lb-name">${r.meta.code || r.driverNum}</span>${tags}${currentTyre}${prevTyres}</div>
          <div class="lb-right"><div class="lb-times">B: ${formatLapTime(r.lapInfo.bestLapTime)}</div><div class="lb-times">L: ${formatLapTime(r.lapInfo.lastLapTime)}</div></div>
        </div>
      </div>`;
  }).join('');
}

leaderboardListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.lb-row');
  if (row) setFollowedDriver(row.dataset.driver);
});

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

// 🏎️ 1인칭 콕핏 스티어링 휠 연동 함수
function updateCockpitHud(states) {
  const state = followedDriver ? states[followedDriver] : null;
  const meta = followedDriver ? (provider.drivers[followedDriver] || {}) : {};

  if (!state || !state.visible) {
    cockpitDriverName.textContent = '차량을 선택하세요';
    cpSpeed.textContent = '-'; cpGear.textContent = '-'; cpRpm.textContent = '-';
    cpThr.style.width = '0%'; cpBrk.style.width = '0%';
    f1Wheel.style.transform = `rotate(0deg)`;
    ledNodes.forEach(led => led.className = 'led'); // LED 끄기
    lastCockpitHeading = null;
    return;
  }

  // 1. 기본 LCD 데이터 연동
  cockpitDriverName.textContent = `${meta.code || followedDriver} · ${meta.team || ''}`;
  cpSpeed.textContent = Math.round(state.v);
  cpGear.textContent = state.gear > 0 ? state.gear : 'N';
  cpRpm.textContent = Math.round(state.rpm);
  cpThr.style.width = `${Math.max(0, Math.min(100, state.thr))}%`;
  cpBrk.style.width = state.brk ? '100%' : '0%';

  // 2. 15구 RPM LED 점등 로직 (8000 ~ 12000 구간)
  const rpmRatio = Math.max(0, Math.min(1, (state.rpm - 8000) / 4000));
  const ledCount = Math.floor(rpmRatio * 15);
  
  ledNodes.forEach((led, idx) => {
    if (idx < ledCount) {
      if (idx < 5) led.className = 'led on green';      // 1~5구간 (초록)
      else if (idx < 10) led.className = 'led on red';  // 6~10구간 (빨강)
      else led.className = 'led on blue';               // 11~15구간 (파랑)
    } else {
      led.className = 'led'; // 꺼짐
    }
  });

  // 3. 요 레이트(Yaw Rate)를 이용한 스티어링 휠 역학 회전 연산
  if (lastCockpitHeading !== null && lastCockpitVirtualT !== null) {
    const dt = virtualT - lastCockpitVirtualT;
    if (dt > 0 && state.v > 10) { // 너무 느릴땐 핸들을 고정
      let dh = state.heading - lastCockpitHeading;
      // 각도 넘어감 현상(-PI ~ +PI) 방지
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      
      // 초당 회전 각도(Degree per second) 도출
      let yawRateDeg = (dh * 180 / Math.PI) / dt;
      
      // 핸들을 실제보다 시각적으로 더 많이 꺾어보이도록 증폭 (매직 넘버)
      let targetWheelAngle = -yawRateDeg * 2.0; 
      targetWheelAngle = Math.max(-150, Math.min(150, targetWheelAngle)); // 150도 락 제한
      
      // 선형 보간으로 부드러운 핸들링 연출
      smoothedWheelAngle += (targetWheelAngle - smoothedWheelAngle) * 0.25;
    }
  } else {
    smoothedWheelAngle = 0;
  }
  
  lastCockpitHeading = state.heading;
  lastCockpitVirtualT = virtualT;

  // CSS 회전 적용 (Canvas +Y축 반전 보정)
  f1Wheel.style.transform = `rotate(${smoothedWheelAngle}deg)`;
}

function renderFrame(states) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawTrackLine();
  drawCars(states);
  timeline.value = Math.round((virtualT - provider.startTime) * 10);
  timeDisplay.textContent = formatTime(virtualT - provider.startTime);
}

function applyFollowCamera(states) {
  if (!followedDriver) return;
  const state = states[followedDriver];
  if (!state || !state.visible) return;
  const [wx, wy] = worldMapper.toWorld(state.x, state.y);
  camera.panX = window.innerWidth / 2 - camera.zoom * wx;
  camera.panY = window.innerHeight / 2 - camera.zoom * wy;
}

function tick(nowMs) {
  if (lastFrameWallClock === null) lastFrameWallClock = nowMs;
  const deltaSec = (nowMs - lastFrameWallClock) / 1000;
  lastFrameWallClock = nowMs;

  if (isPlaying) {
    virtualT += deltaSec * playbackSpeed;
    const endT = provider.startTime + provider.duration;
    if (virtualT > endT) virtualT = endT;
  }

  const states = provider.getStateAt(virtualT);
  lastStates = states;
  applyFollowCamera(states);
  renderFrame(states);
  updateLeaderboard(states);
  updateTopPanelInfo(states);
  
  // 새로 추가된 콕핏 업데이트 호출
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
  smoothedWheelAngle = 0; // 차량 변경시 핸들 초기화
  lastCockpitHeading = null;
}

function handleCanvasClick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const clickX = clientX - rect.left;
  const clickY = clientY - rect.top;
  let hitDriver = null;
  let hitDist = Infinity;

  for (const [driverNum, state] of Object.entries(lastStates)) {
    if (!state.visible) continue;
    const [sx, sy] = toScreen(state.x, state.y);
    const dist = Math.hypot(sx - clickX, sy - clickY);
    const hitRadius = Math.max(CAR_HIT_RADIUS_MIN, 128 * camera.zoom * 0.6);
    if (dist < hitRadius && dist < hitDist) { hitDriver = driverNum; hitDist = dist; }
  }
  setFollowedDriver(hitDriver);
}

function wireCameraControls() {
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  canvas.addEventListener('mousedown', (e) => { isDragging = true; dragStart = { x: e.clientX, y: e.clientY }; panStart = { x: camera.panX, y: camera.panY }; canvas.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', (e) => { if (!isDragging) return; const dx = e.clientX - dragStart.x; const dy = e.clientY - dragStart.y; if (followedDriver && Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) setFollowedDriver(null); camera.panX = panStart.x + dx; camera.panY = panStart.y + dy; });
  window.addEventListener('mouseup', (e) => { if (!isDragging) return; isDragging = false; canvas.style.cursor = 'grab'; if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < CLICK_MOVE_THRESHOLD) handleCanvasClick(e.clientX, e.clientY); });
  canvas.addEventListener('dblclick', () => { setFollowedDriver(null); fitToTrack(); });
}

function wirePlaybackControls() {
  btnPlay.addEventListener('click', () => { isPlaying = !isPlaying; btnPlay.textContent = isPlaying ? '⏸' : '▶'; });
  speedSelector.addEventListener('change', (e) => { playbackSpeed = Number(e.target.value); });
  timeline.addEventListener('input', (e) => { virtualT = provider.startTime + provider.duration * (Number(e.target.value) / Number(timeline.max)); });
  window.addEventListener('resize', resizeCanvas);
}

async function loadSession(filename) {
  isPlaying = false; btnPlay.textContent = '▶'; statusTextEl.textContent = '세션 데이터 로딩 중...';
  try { provider = await LocalReplayProvider.load(`data/${filename}`); } catch (err) { statusTextEl.textContent = `로드 실패: ${err.message}`; return; }

  Object.keys(rankHistory).forEach(k => delete rankHistory[k]);
  lastStates = {}; setFollowedDriver(null); 
  worldMapper = buildWorldMapper(provider.trackLine);
  virtualT = provider.startTime; timeline.max = Math.max(1, Math.round(provider.duration * 10));

  statusTextEl.innerHTML = `${Object.keys(provider.drivers).length}대 로드 완료.`;
  resizeCanvas(); fitToTrack(); renderFrame(provider.getStateAt(virtualT));
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
