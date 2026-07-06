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
const telemetryTitleEl = document.getElementById('telemetry-title');
const speedValEl = document.getElementById('speed-val');
const gearValEl = document.getElementById('gear-val');
const rpmValEl = document.getElementById('rpm-val');
const throttleBarEl = document.getElementById('throttle-bar');
const brakeBarEl = document.getElementById('brake-bar');

// 트랙 너비를 최적의 크기(6배)로 조절
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

// 타이어 컴파운드 색상 강제 지정
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

// 화살표 추적 객체
const rankHistory = {}; 

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
  const fitZoom = Math.min(
    (viewW - padding * 2) / worldMapper.dataW,
    (viewH - padding * 2) / worldMapper.dataH
  );
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

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. 하얀색 테두리 라인 (아우트라인) 먼저 그리기
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

  // 2. 어두운 아스팔트 라인 덮어 그리기
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
    const screenHeading = -state.heading;

    carRenderer.drawCar(ctx, sx, sy, screenHeading, camera.zoom, {
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

// 폰트 컬러와 테두리 컬러를 컴파운드 고유색상으로 강제 적용
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
    // 현재 트랙에 보이지 않는 차량(리타이어 또는 시작전 피트레인 대기)은 순위 9999 부여
    const pos = state.visible && state.pos != null ? state.pos : 9999;
    const isDrsOpen = state.visible && state.drs === 1;
    const isDnf = !state.visible; 

    return { driverNum, meta, lapInfo, isFastest, isFlagged, pos, isDrsOpen, isDnf };
  });

  // 순위(pos) 기준 정렬 - 9999를 받은 DNF 차량은 무조건 최하단으로 이동
  rows.sort((a, b) => a.pos - b.pos);

  leaderboardListEl.innerHTML = rows.map((r) => {
    const posLabel = r.pos === 9999 ? '-' : r.pos;
    const rowClasses = ['lb-row'];
    if (r.driverNum === followedDriver) rowClasses.push('followed');
    if (r.isDnf) rowClasses.push('dnf'); // 흐린색 처리 클래스 추가
    
    // 순위 변동 화살표 HTML (기본 투명상태 유지로 레이아웃 고정)
    let rankArrowHtml = `<div class="rank-arrow" style="opacity:0;">▲</div>`;
    if (r.pos !== 9999) {
       const history = rankHistory[r.driverNum];
       if (!history) {
         rankHistory[r.driverNum] = { pos: r.pos, t: virtualT, display: '' };
       } else {
         if (history.pos !== r.pos) {
           if (history.pos > r.pos) history.display = `<div class="rank-arrow up">▲</div>`;
           else history.display = `<div class="rank-arrow down">▼</div>`;
           history.pos = r.pos;
           history.t = virtualT;
         }
         // 4초간 화살표 표시
         if (virtualT - history.t < 4.0 && history.display) {
            rankArrowHtml = history.display;
         }
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
        <div class="lb-pos-container">
          ${rankArrowHtml}
          <div class="lb-pos">${posLabel}</div>
        </div>
        <div class="lb-main">
          <div class="lb-left">
            <span class="lb-name">${r.meta.code || r.driverNum}</span>
            ${tags}
            ${currentTyre}${prevTyres}
          </div>
          <div class="lb-right">
            <div class="lb-times">B: ${formatLapTime(r.lapInfo.bestLapTime)}</div>
            <div class="lb-times">L: ${formatLapTime(r.lapInfo.lastLapTime)}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// mousedown 이벤트로 즉시 클릭 인지
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
  const currentDisplayLap = Math.max(1, maxLap + 1);
  const totalDisplay = provider.totalLaps ? provider.totalLaps : '?';
  lapTextEl.textContent = `Lap ${currentDisplayLap} / ${totalDisplay}`;
}

function updateTelemetryHud(states) {
  const state = followedDriver ? states[followedDriver] : null;
  if (!state || !state.visible) {
    telemetryTitleEl.textContent = '차량을 선택하세요';
    speedValEl.textContent = '-'; gearValEl.textContent = '-'; rpmValEl.textContent = '-';
    throttleBarEl.style.width = '0%'; brakeBarEl.style.width = '0%';
    return;
  }
  const meta = provider.drivers[followedDriver] || {};
  telemetryTitleEl.textContent = `${meta.code || followedDriver} · ${meta.team || ''}`;
  speedValEl.textContent = Math.round(state.v);
  gearValEl.textContent = state.gear > 0 ? state.gear : 'N';
  rpmValEl.textContent = Math.round(state.rpm).toLocaleString();
  throttleBarEl.style.width = `${Math.max(0, Math.min(100, state.thr))}%`;
  brakeBarEl.style.width = state.brk ? '100%' : '0%';
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
  updateTelemetryHud(states);

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
    if (dist < hitRadius && dist < hitDist) {
      hitDriver = driverNum;
      hitDist = dist;
    }
  }
  setFollowedDriver(hitDriver);
}

function wireCameraControls() {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { x: camera.panX, y: camera.panY };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (followedDriver && Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) setFollowedDriver(null);
    camera.panX = panStart.x + dx;
    camera.panY = panStart.y + dy;
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    canvas.style.cursor = 'grab';
    const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
    if (moved < CLICK_MOVE_THRESHOLD) handleCanvasClick(e.clientX, e.clientY);
  });

  canvas.addEventListener('dblclick', () => {
    setFollowedDriver(null);
    fitToTrack();
  });
}

function wirePlaybackControls() {
  btnPlay.addEventListener('click', () => {
    isPlaying = !isPlaying;
    btnPlay.textContent = isPlaying ? '⏸' : '▶';
  });
  speedSelector.addEventListener('change', (e) => { playbackSpeed = Number(e.target.value); });
  timeline.addEventListener('input', (e) => {
    const ratio = Number(e.target.value) / Number(timeline.max);
    virtualT = provider.startTime + provider.duration * ratio;
  });
  window.addEventListener('resize', resizeCanvas);
}

async function loadSession(filename) {
  isPlaying = false;
  btnPlay.textContent = '▶';
  statusTextEl.textContent = '세션 데이터 로딩 중...';
  
  try { provider = await LocalReplayProvider.load(`data/${filename}`); } 
  catch (err) { statusTextEl.textContent = `로드 실패: ${err.message}`; return; }

  Object.keys(rankHistory).forEach(k => delete rankHistory[k]);
  lastStates = {};
  setFollowedDriver(null); 

  worldMapper = buildWorldMapper(provider.trackLine);
  virtualT = provider.startTime;
  timeline.max = Math.max(1, Math.round(provider.duration * 10));

  statusTextEl.innerHTML = `${Object.keys(provider.drivers).length}대 차량 로드 완료.<br>휠: 확대/축소 · 드래그: 이동 · 더블클릭: 초기화 · 클릭: 추적`;
  resizeCanvas(); fitToTrack();
  renderFrame(provider.getStateAt(virtualT));
}

async function main() {
  try {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error('index.json 없음');
    const sessionList = await res.json();
    
    sessionSelect.innerHTML = '';
    sessionList.forEach(session => {
      const opt = document.createElement('option');
      opt.value = session.filename;
      opt.textContent = session.name;
      sessionSelect.appendChild(opt);
    });

    sessionSelect.addEventListener('change', (e) => { loadSession(e.target.value); });

    if (sessionList.length > 0) await loadSession(sessionList[0].filename);
  } catch (err) {
    statusTextEl.textContent = `index.json을 찾을 수 없습니다. 파이썬 스크립트를 먼저 실행하세요.`;
    return;
  }

  wireCameraControls();
  wirePlaybackControls();
  requestAnimationFrame(tick);
}

main();