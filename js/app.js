/**
 * app.js
 */
import { LocalReplayProvider } from './dataProvider.js';
import { CarRenderer } from './carRenderer.js';

// 캔버스 2개 분리 운영
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
const btnViewSwitch = document.getElementById('btn-view-switch'); // 스위칭 버튼
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
let isFpvMode = false; // 화면 스위치 상태 플래그

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
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  return { dataW, dataH, toWorld(x, y) { return [x - minX, dataH - (y - minY)]; } };
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

// 부모 컨테이너 크기에 맞춰 2개 캔버스를 모두 리사이즈
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  
  canvas.width = viewMapWrap.clientWidth * dpr;
  canvas.height = viewMapWrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  fpvCanvas.width = viewCockpitWrap.clientWidth * dpr;
  fpvCanvas.height = viewCockpitWrap.clientHeight * dpr;
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// --- 뷰어 스위칭 로직 ---
btnViewSwitch.addEventListener('click', () => {
  isFpvMode = !isFpvMode;
  document.body.classList.toggle('fpv-mode', isFpvMode);
  // CSS Transition(0.4초)이 끝난 후 내부 캔버스 크기 재계산
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
// 🏎️ 유사 3D 원근 투영 (Perspective Engine)
// ==========================================
function renderFPV(camState, allStates) {
  const fw = viewCockpitWrap.clientWidth;
  const fh = viewCockpitWrap.clientHeight;
  
  // 배경 하늘과 잔디 렌더링
  fctx.fillStyle = '#1e272e'; // 스카이박스 (밤하늘)
  fctx.fillRect(0, 0, fw, fh * 0.5);
  fctx.fillStyle = '#052c11'; // 잔디밭
  fctx.fillRect(0, fh * 0.5, fw, fh * 0.5);

  if (!camState || !camState.visible) {
    cockpitDriverName.textContent = '차량을 선택하세요';
    return;
  }

  // 삼각함수를 통한 기준 차량의 전방(Forward) / 측면(Right) 벡터 추출
  const Fx = Math.cos(camState.heading);
  const Fy = Math.sin(camState.heading);
  const Rx = Math.sin(camState.heading);
  const Ry = -Math.cos(camState.heading);

  // 로컬 좌표 변환 및 스크린 분할 함수
  function project(x, y, zOffset = 0) {
    const dx = x - camState.x;
    const dy = y - camState.y;
    const Lz = dx * Fx + dy * Fy; // 전후 깊이 (Depth)
    const Lx = dx * Rx + dy * Ry; // 좌우 거리 (Horizontal)

    if (Lz < 0.5) return null; // 카메라 바로 앞이나 뒤에 있는 건 버림 (Frustum Culling)

    const f = 0.8; // 시야각(FOV) 줌 팩터
    const camZ = 1.0; // 카메라 높이
    const px = fw / 2 + (Lx / Lz) * fw * f;
    const py = fh / 2 + ((camZ - zOffset) / Lz) * fw * f;
    return { px, py, Lz };
  }

  // 1. 가장 가까운 트랙 노드 탐색
  let minDist = Infinity;
  let startIdx = 0;
  for (let i = 0; i < provider.trackLine.length; i++) {
    const [tx, ty] = provider.trackLine[i];
    const dist = Math.hypot(tx - camState.x, ty - camState.y);
    if (dist < minDist) { minDist = dist; startIdx = i; }
  }

  // 2. 1인칭 트랙 그리기 (앞으로 80개 포인트만큼 계산)
  const lookahead = 80;
  const pts = [];
  for (let i = 0; i < lookahead; i++) {
    const idx = (startIdx + i) % provider.trackLine.length;
    const [tx, ty] = provider.trackLine[idx];
    const p = project(tx, ty);
    if (p) pts.push(p);
  }

  const trackWidth = 7; // 미터 단위 도로 절반 폭 (가정)
  
  // 뒤에서부터 앞으로 그리기 (Painter's Algorithm)
  for (let i = pts.length - 2; i >= 0; i--) {
    const p1 = pts[i];
    const p2 = pts[i+1];
    const w1 = (trackWidth / p1.Lz) * fw * 0.8;
    const w2 = (trackWidth / p2.Lz) * fw * 0.8;

    // 아스팔트
    fctx.fillStyle = (i % 2 === 0) ? '#2a2a2a' : '#333333';
    fctx.beginPath();
    fctx.moveTo(p1.px - w1, p1.py); fctx.lineTo(p1.px + w1, p1.py);
    fctx.lineTo(p2.px + w2, p2.py); fctx.lineTo(p2.px - w2, p2.py);
    fctx.fill();
    
    // 연석 (Curbs)
    fctx.fillStyle = (i % 2 === 0) ? '#ffffff' : '#e74c3c';
    fctx.fillRect(p1.px - w1 - 4, p1.py - 1, 8, 3); // 좌측
    fctx.fillRect(p1.px + w1 - 4, p1.py - 1, 8, 3); // 우측
  }

  // 3. 주변 타 차량 빌보딩 렌더링
  const carsToDraw = [];
  for (const [dNum, state] of Object.entries(allStates)) {
    if (dNum === followedDriver || !state.visible) continue;
    const p = project(state.x, state.y, 0.4); // 0.4는 차량 바닥을 띄우는 Z오프셋
    if (p && p.Lz < 250) carsToDraw.push({ p, dNum, meta: provider.drivers[dNum], state }); // 250m 이내만
  }
  
  // 멀리 있는 차부터 그리기
  carsToDraw.sort((a, b) => b.p.Lz - a.p.Lz);
  for (const c of carsToDraw) {
    const scale = (1 / c.p.Lz) * fw * 0.9; 
    carRenderer.drawRearCar(fctx, c.p.px, c.p.py, scale, c.meta.color, c.state.brk === 1);
  }
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
  if (!state || !state.visible) {
    cpSpeed.textContent = '-'; cpGear.textContent = '-'; cpRpm.textContent = '-';
    cpThr.style.width = '0%'; cpBrk.style.width = '0%';
    f1Wheel.style.transform = `rotate(0deg)`;
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

  if (lastCockpitHeading !== null && lastCockpitVirtualT !== null) {
    const dt = virtualT - lastCockpitVirtualT;
    if (dt > 0 && state.v > 10) { 
      let dh = state.heading - lastCockpitHeading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      
      let yawRateDeg = (dh * 180 / Math.PI) / dt;
      let targetWheelAngle = -yawRateDeg * 2.0; // 📌 역방향 버그 수정됨 (-)
      targetWheelAngle = Math.max(-150, Math.min(150, targetWheelAngle)); 
      smoothedWheelAngle += (targetWheelAngle - smoothedWheelAngle) * 0.25;
    }
  } else smoothedWheelAngle = 0;
  
  lastCockpitHeading = state.heading; lastCockpitVirtualT = virtualT;
  f1Wheel.style.transform = `rotate(${smoothedWheelAngle}deg)`;
}

function renderMainFrame(states) {
  ctx.clearRect(0, 0, viewMapWrap.clientWidth, viewMapWrap.clientHeight);
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
  }

  const states = provider.getStateAt(virtualT);
  lastStates = states;
  
  applyFollowCamera(states);
  renderMainFrame(states); // 맵 렌더링
  renderFPV(followedDriver ? states[followedDriver] : null, states); // FPV 렌더링
  
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
