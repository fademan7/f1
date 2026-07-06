/**
 * dataProvider.js
 * ---------------------------------------------------------------
 * app.js는 아래 공개 인터페이스만 알면 됩니다:
 *   - provider.trackLine, provider.drivers, provider.duration, provider.totalLaps
 *   - provider.getStateAt(t)
 *   - provider.getTrackStatusAt(t)      : 전역 트랙 상태 코드 문자열
 *   - provider.getFlaggedDrivers(t)     : Black-and-white 등 플래그 받은 driverNum Set
 *   - provider.getLapInfo(driverNum, t) : 베스트/라스트랩, 타이어 정보
 *   - provider.fastestLap
 *
 * 실시간 모드로 교체될 때도 이 인터페이스들은 동일하게 유지되어야 합니다.
 * ---------------------------------------------------------------
 */

const GAP_THRESHOLD_SEC = 3.0;
const LOW_SPEED_HEADING_HOLD = 5.0;

class LocalReplayProvider {
  constructor(sessionData) {
    this.trackLine = sessionData.trackLine || [];
    this.drivers = sessionData.drivers || {};
    this._cars = {};
    this._laps = sessionData.laps || {};

    this.trackStatusEvents = sessionData.trackStatus || [];
    this.driverFlagEvents = sessionData.driverFlags || [];
    this.fastestLap = sessionData.fastestLap || null;
    this.totalLaps = sessionData.totalLaps || null;

    let minT = Infinity;
    let maxT = -Infinity;

    for (const [driverNum, frames] of Object.entries(sessionData.cars || {})) {
      const withHeading = this._precomputeHeadings(frames);
      this._cars[driverNum] = withHeading;
      if (withHeading.length > 0) {
        minT = Math.min(minT, withHeading[0].t);
        maxT = Math.max(maxT, withHeading[withHeading.length - 1].t);
      }
    }

    this.startTime = Number.isFinite(minT) ? minT : 0;
    this.duration = Number.isFinite(maxT) ? maxT - this.startTime : 0;
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`session.json 로드 실패: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return new LocalReplayProvider(data);
  }

  _precomputeHeadings(frames) {
    const sorted = [...frames].sort((a, b) => a.t - b.t);
    let prevHeading = 0;
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      if (cur.v < LOW_SPEED_HEADING_HOLD || !next) {
        cur.heading = prevHeading;
      } else {
        const dx = next.x - cur.x;
        const dy = next.y - cur.y;
        cur.heading = (dx === 0 && dy === 0) ? prevHeading : Math.atan2(dy, dx);
      }
      prevHeading = cur.heading;
    }
    return sorted;
  }

  getStateAt(t) {
    const result = {};
    for (const [driverNum, frames] of Object.entries(this._cars)) {
      result[driverNum] = this._interpolate(frames, t);
    }
    return result;
  }

  _interpolate(frames, t) {
    if (frames.length === 0) return { visible: false };
    if (t < frames[0].t || t > frames[frames.length - 1].t) return { visible: false };

    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[hi];

    if (b.t - a.t > GAP_THRESHOLD_SEC) return { visible: false };

    const span = b.t - a.t;
    const ratio = span > 0 ? (t - a.t) / span : 0;

    return {
      x: this._lerp(a.x, b.x, ratio),
      y: this._lerp(a.y, b.y, ratio),
      v: this._lerp(a.v, b.v, ratio),
      thr: this._lerp(a.thr, b.thr, ratio),
      brk: ratio < 0.5 ? a.brk : b.brk,
      gear: ratio < 0.5 ? (a.gear ?? 0) : (b.gear ?? 0),
      rpm: this._lerp(a.rpm ?? 0, b.rpm ?? 0, ratio),
      pos: ratio < 0.5 ? (a.pos ?? null) : (b.pos ?? null),
      drs: ratio < 0.5 ? (a.drs ?? 0) : (b.drs ?? 0),
      heading: this._lerpAngle(a.heading, b.heading, ratio),
      visible: true,
    };
  }

  _lerp(start, end, ratio) {
    return start + (end - start) * ratio;
  }

  _lerpAngle(a, b, ratio) {
    const x = this._lerp(Math.cos(a), Math.cos(b), ratio);
    const y = this._lerp(Math.sin(a), Math.sin(b), ratio);
    return Math.atan2(y, x);
  }

  /** 전역 트랙 상태 코드('1'=Clear,'2'=Yellow,'4'=SC,'5'=Red,'6'=VSC,'7'=VSC Ending 등) */
  getTrackStatusAt(t) {
    let status = '1';
    for (const ev of this.trackStatusEvents) {
      if (ev.t > t) break;
      status = ev.status;
    }
    return status;
  }

  /** Black and White 등 드라이버 지정 플래그를 받은 driverNum 집합 (발령 이후 계속 유지) */
  getFlaggedDrivers(t) {
    const flagged = new Set();
    for (const ev of this.driverFlagEvents) {
      if (ev.t > t) break;
      if (ev.flag.includes('BLACK')) flagged.add(ev.driver);
    }
    return flagged;
  }

  /** 특정 드라이버의 현재(t 시점) 베스트/라스트랩, 타이어 상태를 계산 */
  getLapInfo(driverNum, t) {
    const laps = this._laps[driverNum] || [];
    const completed = [];
    let currentLap = null;

    for (const lap of laps) {
      if (lap.endT != null && lap.endT <= t) {
        completed.push(lap);
      } else if (currentLap === null) {
        currentLap = lap;
      }
    }

    const lastLap = completed.length ? completed[completed.length - 1] : null;
    let bestLap = null;
    for (const lap of completed) {
      if (lap.lapTime != null && (bestLap === null || lap.lapTime < bestLap.lapTime)) {
        bestLap = lap;
      }
    }

    const stintMap = new Map();
    for (const lap of completed) {
      if (lap.stint == null) continue;
      if (!stintMap.has(lap.stint)) {
        stintMap.set(lap.stint, { stint: lap.stint, compound: lap.compound, laps: 0 });
      }
      stintMap.get(lap.stint).laps += 1;
    }
    const stints = Array.from(stintMap.values()).sort((a, b) => a.stint - b.stint);
    const currentStint = stints.length ? stints[stints.length - 1] : null;
    const previousStints = stints.slice(0, -1);

    return {
      lapsCompleted: completed.length,
      lastLapTime: lastLap ? lastLap.lapTime : null,
      bestLapTime: bestLap ? bestLap.lapTime : null,
      currentCompound: currentStint ? currentStint.compound : (currentLap ? currentLap.compound : null),
      currentTyreLife: currentLap ? currentLap.tyreLife : (lastLap ? lastLap.tyreLife : null),
      previousStints,
    };
  }
}

export { LocalReplayProvider };
