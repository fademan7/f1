"""
F1 세션 데이터 수집 및 전처리 스크립트

사용법:
    pip install fastf1 pandas --break-system-packages
    python fetch_data.py --year 2024 --gp "Bahrain" --session R --max-laps 3

--max-laps: 드라이버당 몇 개 랩까지만 받을지 (프로토타입 테스트용, 기본 3랩).
            베스트/라스트랩, 순위, 타이어 정보도 이 범위 내에서만 계산되므로,
            전체 레이스 기준을 보고 싶으면 --max-laps 999 처럼 크게 주세요.

트랙 선택 참고: 모나코는 코스가 좁아 실제로도 추월이 거의 없는 트랙입니다.
순위 변화를 보고 싶다면 바레인, 인터라고스(브라질), 바쿠, 몬자처럼
직선 구간과 DRS존이 많은 트랙을 추천합니다.

포함된 데이터:
  - cars           : 차량별 시계열 텔레메트리 (위치/속도/스로틀/브레이크/기어/RPM/DRS/랩순위)
  - laps           : 드라이버별 랩 요약(랩타임/컴파운드/타이어수명/스틴트)
  - totalLaps      : 세션의 전체 랩 수 (좌상단 "1/52" 같은 표시에 사용)
  - fastestLap     : 수집된 랩 범위 내에서의 최속랩 (전체 레이스 기준이 아님, 주의)
  - trackStatus    : 세션 전체의 공식 플래그 상태 타임라인 (Clear/Yellow/SC/VSC/Red)
  - sectorFlags    : 마샬링 섹터별 옐로우 플래그 타임라인 (참고용 원시 데이터.
                     실제 코너 좌표와 매핑할 근거가 API에 없어 화면에는 표시하지 않습니다)
  - driverFlags    : 특정 드라이버에게 내려진 플래그(예: Black and White) 타임라인
  - drivers[].status : 최종 완주 상태 (Finished/Retired 등, 있는 경우)
"""

import argparse
import json
import os

import fastf1
import pandas as pd

CACHE_DIR = "./f1_cache"
OUTPUT_DIR = "./data"
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "session.json")

TEAM_COLORS = {
    "Red Bull Racing": "#3671C6",
    "Ferrari": "#E8002D",
    "Mercedes": "#27F4D2",
    "McLaren": "#FF8000",
    "Aston Martin": "#229971",
    "Alpine": "#FF87BC",
    "Williams": "#64C4FF",
    "RB": "#6692FF",
    "Kick Sauber": "#52E252",
    "Haas F1 Team": "#B6BABD",
}


def to_seconds(value, session):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, pd.Timedelta):
        return value.total_seconds()
    try:
        return (value - session.t0_date).total_seconds()
    except Exception:
        return None


def fetch_session(year: int, gp: str, session_type: str):
    os.makedirs(CACHE_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE_DIR)
    fastf1.logger.set_log_level("DEBUG")

    print(f"[1/5] 세션 로드 중: {year} {gp} {session_type} ...")
    session = fastf1.get_session(year, gp, session_type)
    session.load(telemetry=True, laps=True, weather=False, messages=True)

    if session.laps is None or session.laps.empty:
        raise RuntimeError(
            "랩 데이터 로드에 실패했습니다. 위 DEBUG 로그에서 "
            "실패한 HTTP 요청(타임아웃/404 등)을 확인하세요."
        )
    return session


def build_track_line(session) -> list:
    print("[2/5] 트랙 라인(최속 랩 궤적) 추출 중...")
    fastest_lap = session.laps.pick_fastest()
    tel = fastest_lap.get_telemetry()
    points = tel[["X", "Y"]].dropna()
    sampled = points.iloc[::5]
    return [[round(row.X, 1), round(row.Y, 1)] for row in sampled.itertuples()]


def build_track_status(session) -> list:
    print("[3/5] 트랙 상태(Flag/SC/VSC) 타임라인 추출 중...")
    events = []
    try:
        ts = session.track_status
        if ts is None or ts.empty:
            print("  참고: 이 세션에는 트랙 상태 데이터가 없습니다.")
            return events
        for _, row in ts.iterrows():
            t = to_seconds(row.get("Time"), session)
            if t is None:
                continue
            events.append({"t": round(t, 2), "status": str(row.get("Status", ""))})
        events.sort(key=lambda e: e["t"])
        print(f"  트랙 상태 이벤트 {len(events)}건")
    except Exception as e:
        print(f"  경고: 트랙 상태 로드 실패 - 건너뜁니다 ({e})")
    return events


def build_flag_events(session):
    print("[4/5] 레이스 컨트롤 플래그 메시지 추출 중...")
    sector_flags = []
    driver_flags = []
    max_sector = 0
    try:
        rcm = session.race_control_messages
        if rcm is None or rcm.empty:
            print("  참고: 레이스 컨트롤 메시지가 없습니다.")
            return sector_flags, driver_flags, max_sector

        for _, row in rcm.iterrows():
            if str(row.get("Category", "")) != "Flag":
                continue
            t = to_seconds(row.get("Time"), session)
            if t is None:
                continue
            flag = str(row.get("Flag", "")).upper()
            sector = row.get("Sector")
            racing_number = row.get("RacingNumber")

            if pd.notna(sector):
                s = int(sector)
                max_sector = max(max_sector, s)
                sector_flags.append({"t": round(t, 2), "sector": s, "flag": flag})

            if pd.notna(racing_number):
                driver_flags.append({
                    "t": round(t, 2),
                    "driver": str(int(racing_number)),
                    "flag": flag,
                    "message": str(row.get("Message", "")),
                })

        sector_flags.sort(key=lambda e: e["t"])
        driver_flags.sort(key=lambda e: e["t"])
        print(f"  섹터 플래그 {len(sector_flags)}건, 드라이버 지정 플래그 {len(driver_flags)}건")
    except Exception as e:
        print(f"  경고: 레이스 컨트롤 메시지 로드 실패 - 건너뜁니다 ({e})")
    return sector_flags, driver_flags, max_sector


def build_cars_and_laps(session, max_laps: int):
    print(f"[5/5] 차량 텔레메트리 및 랩 정보 추출 중 (드라이버당 최대 {max_laps}랩)...")
    cars = {}
    laps_out = {}
    drivers_meta = {}

    for drv in session.drivers:
        try:
            driver_laps = session.laps.pick_drivers(drv)
            if driver_laps.empty:
                continue
            driver_laps = driver_laps.iloc[:max_laps]

            info = session.get_driver(drv)
            team = info.get("TeamName", "Unknown")
            status = info.get("Status")
            drivers_meta[drv] = {
                "code": info.get("Abbreviation", drv),
                "team": team,
                "color": TEAM_COLORS.get(team, "#FFFFFF"),
                "status": str(status) if pd.notna(status) else None,
            }

            frames = []
            laps_summary = []

            for _, lap in driver_laps.iterlaps():
                tel = lap.get_telemetry()
                if tel.empty:
                    continue
                tel = tel.dropna(subset=["X", "Y"])
                t_rel = tel["SessionTime"].dt.total_seconds().reset_index(drop=True)
                lap_pos = int(lap.Position) if pd.notna(getattr(lap, "Position", None)) else None

                for i, row in enumerate(tel.itertuples()):
                    # DRS: FastF1 원시 코드는 0/1(닫힘)과 8/10/12/14(가능/열림) 등으로 나뉨.
                    # 10 이상을 "열림"으로 간주하는 것이 커뮤니티에서 통용되는 근사 기준.
                    drs_open = 1 if (pd.notna(row.DRS) and row.DRS >= 10) else 0

                    frames.append({
                        "t": round(float(t_rel.iloc[i]), 2),
                        "x": round(row.X, 1),
                        "y": round(row.Y, 1),
                        "v": round(row.Speed, 1) if pd.notna(row.Speed) else 0,
                        "thr": int(row.Throttle) if pd.notna(row.Throttle) else 0,
                        "brk": 1 if row.Brake else 0,
                        "gear": int(row.nGear) if pd.notna(row.nGear) else 0,
                        "rpm": round(row.RPM, 0) if pd.notna(row.RPM) else 0,
                        "pos": lap_pos,
                        "drs": drs_open,
                    })

                lap_time_td = getattr(lap, "LapTime", None)
                lap_time = lap_time_td.total_seconds() if pd.notna(lap_time_td) else None
                end_t = to_seconds(getattr(lap, "Time", None), session)

                laps_summary.append({
                    "lapNumber": int(lap.LapNumber) if pd.notna(getattr(lap, "LapNumber", None)) else None,
                    "endT": round(end_t, 2) if end_t is not None else None,
                    "lapTime": round(lap_time, 3) if lap_time is not None else None,
                    "compound": lap.Compound if pd.notna(getattr(lap, "Compound", None)) else None,
                    "tyreLife": int(lap.TyreLife) if pd.notna(getattr(lap, "TyreLife", None)) else None,
                    "stint": int(lap.Stint) if pd.notna(getattr(lap, "Stint", None)) else None,
                })

            if frames:
                frames.sort(key=lambda f: f["t"])
                cars[str(drv)] = frames
                laps_out[str(drv)] = sorted(
                    laps_summary, key=lambda l: (l["endT"] is None, l["endT"])
                )
                print(f"  드라이버 {drv} ({drivers_meta[drv]['code']}): "
                      f"{len(frames)} 프레임, {len(laps_summary)}랩")

        except Exception as e:
            print(f"  경고: 드라이버 {drv} 처리 중 오류 발생 - 건너뜁니다 ({e})")
            continue

    return cars, drivers_meta, laps_out


def compute_fastest_lap(laps_out: dict):
    best = None
    for drv, laps in laps_out.items():
        for lap in laps:
            if lap["lapTime"] is None:
                continue
            if best is None or lap["lapTime"] < best["lapTime"]:
                best = {"driver": drv, "lapNumber": lap["lapNumber"], "lapTime": lap["lapTime"]}
    return best


def compute_total_laps(session):
    try:
        max_lap = session.laps["LapNumber"].max()
        return int(max_lap) if pd.notna(max_lap) else None
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="F1 세션 데이터 수집 스크립트")
    parser.add_argument("--year", type=int, default=2024)
    parser.add_argument("--gp", type=str, default="Bahrain")
    parser.add_argument("--session", type=str, default="R",
                         help="R=레이스, Q=퀄리파잉, FP1/FP2/FP3=연습세션")
    parser.add_argument("--max-laps", type=int, default=3,
                         help="드라이버당 가져올 최대 랩 수")
    args = parser.parse_args()

    session = fetch_session(args.year, args.gp, args.session)
    track_line = build_track_line(session)
    track_status = build_track_status(session)
    sector_flags, driver_flags, max_sector = build_flag_events(session)
    cars, drivers_meta, laps_out = build_cars_and_laps(session, args.max_laps)
    fastest_lap = compute_fastest_lap(laps_out)
    total_laps = compute_total_laps(session)

    output = {
        "meta": {"year": args.year, "gp": args.gp, "sessionType": args.session, "maxLaps": args.max_laps},
        "trackLine": track_line,
        "drivers": drivers_meta,
        "cars": cars,
        "laps": laps_out,
        "totalLaps": total_laps,
        "fastestLap": fastest_lap,
        "trackStatus": track_status,
        "sectorFlags": sector_flags,
        "driverFlags": driver_flags,
        "maxSectorNumber": max_sector,
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 1. 파일명 동적 생성 (공백을 언더바로 치환)
    safe_gp = args.gp.replace(" ", "_")
    filename = f"session_{args.year}_{safe_gp}_{args.session}.json"
    output_file = os.path.join(OUTPUT_DIR, filename)

    print(f"JSON 저장 중: {output_file}")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)

    # 2. index.json 업데이트 (웹에서 목록을 읽기 위한 용도)
    index_file = os.path.join(OUTPUT_DIR, "index.json")
    index_data = []
    if os.path.exists(index_file):
        try:
            with open(index_file, "r", encoding="utf-8") as f:
                index_data = json.load(f)
        except Exception:
            pass

    # 중복 데이터 제거 후 새 데이터 추가
    index_data = [d for d in index_data if d.get("filename") != filename]
    index_data.append({
        "name": f"{args.year} {args.gp} ({args.session})",
        "filename": filename
    })

    with open(index_file, "w", encoding="utf-8") as f:
        json.dump(index_data, f, ensure_ascii=False, indent=2)

    size_mb = os.path.getsize(output_file) / (1024 * 1024)
    print(f"완료. 파일 크기 {size_mb:.2f}MB, 트랙 목록이 index.json에 업데이트되었습니다.")

if __name__ == "__main__":
    main()