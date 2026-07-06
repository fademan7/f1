---

```markdown
# 🏎️ F1 Telemetry Replay Viewer (Prototype)

이 프로젝트는 F1(Formula 1) 공식 텔레메트리 데이터를 활용하여 과거 레이스를 2D 미니맵 형태로 복기할 수 있는 경량화된 웹 기반 리플레이 뷰어입니다. 
무거운 3D 물리 엔진 없이 `FastF1` API와 `HTML5 Canvas`만으로 차량의 궤적, 실시간 순위 변동, 속도/페달 조작 상태(HUD)를 부드럽게 시각화합니다.

## ✨ 주요 기능 (Features)
* **2D 트랙 및 차량 시각화:** 최고속 랩(Fastest Lap)의 궤적 데이터를 기반으로 트랙 한계선을 자동 생성합니다.
* **실시간 텔레메트리 HUD:** 특정 차량 클릭 시 속도(Speed), RPM, 기어(Gear), 스로틀(Throttle), 브레이크(Brake) 데이터를 게이지 형태로 제공합니다.
* **동적 리더보드:** 랩타임 기준이 아닌 실제 트랙 위 위치(Position)를 기반으로 순위와 변동 화살표(▲/▼), 타이어 컴파운드, DRS 상태를 실시간으로 갱신합니다.
* **멀티 세션 스위칭:** 여러 그랑프리(GP) 데이터를 미리 다운로드해 두고, 브라우저 새로고침 없이 드롭다운 메뉴로 즉시 맵을 교체할 수 있습니다.
* **재생 컨트롤:** 배속(1x, 2x, 4x, 8x) 조절 및 타임라인 탐색 기능을 지원합니다.

---

## ⚙️ 설치 및 실행 방법 (Getting Started)

### 1. 사전 요구 사항 (Prerequisites)
* **Python 3.8+** (데이터 수집용)
* **최신 웹 브라우저** (Chrome, Edge, Safari 등)

### 2. 패키지 설치
데이터 추출을 위해 `fastf1`과 `pandas` 라이브러리가 필요합니다. 터미널을 열고 아래 명령어를 실행하세요.
```bash
pip install fastf1 pandas

```

*(참고: 최근 파이썬 버전에서 환경 충돌 에러가 발생한다면 `pip install fastf1 pandas --break-system-packages`를 사용하세요.)*

### 3. F1 레이스 데이터 다운로드

`fetch_data.py` 스크립트를 사용하여 원하는 그랑프리(GP)의 데이터를 로컬로 다운로드합니다. 데이터는 자동으로 용량이 압축되어 `data/` 폴더에 저장되며, 웹에서 읽을 수 있도록 `index.json`이 갱신됩니다.

**추천 서킷 다운로드 예시 (추월이 잦은 맵 5랩 기준):**

```bash
# 이탈리아 몬자 (가장 빠른 서킷)
python fetch_data.py --year 2024 --gp "Italy" --session R --max-laps 5

# 아제르바이잔 바쿠 (긴 직선 구간)
python fetch_data.py --year 2024 --gp "Azerbaijan" --session R --max-laps 5

# 브라질 상파울루 (고도차 및 잦은 배틀)
python fetch_data.py --year 2024 --gp "São Paulo" --session R --max-laps 5

```

> **옵션 설명:**
> * `--year`: 시즌 연도 (예: 2023, 2024)
> * `--gp`: 그랑프리 이름 또는 국가명
> * `--session`: `R`(Race), `Q`(Qualifying), `FP1/FP2/FP3`(Practice)
> * `--max-laps`: 가져올 최대 랩 수 (전체 레이스를 보려면 `999` 입력)
> 
> 

### 4. 로컬 웹 서버 실행

보안 정책(CORS)으로 인해 로컬 HTML 파일을 그냥 더블클릭하면 데이터가 로드되지 않습니다. 프로젝트 폴더에서 파이썬 내장 웹 서버를 실행하세요.

```bash
python -m http.server 8000

```

### 5. 뷰어 접속

브라우저를 열고 다음 주소로 접속합니다.
👉 **[http://localhost:8000](https://www.google.com/search?q=http://localhost:8000)**

---

## 📂 디렉토리 구조 (Project Structure)

```text
/f1-telemetry-viewer
 ├── fetch_data.py              # [Python] FastF1 API 연동 및 데이터 전처리
 ├── index.html                 # [HTML] 메인 UI (캔버스 및 HUD 레이어)
 ├── data/                      # (자동 생성) 정적 데이터 저장소
 │    ├── index.json            # 다운로드된 세션 목록
 │    └── session_*.json        # 세션별 텔레메트리 압축 데이터
 └── js/                        
      ├── app.js                # 메인 렌더링 루프 및 UI 이벤트 제어
      ├── dataProvider.js       # 데이터 로드 및 선형 보간(Interpolation) 연산
      └── carRenderer.js        # HTML5 Canvas 기반 F1 차량 벡터 드로잉

```

## ⚠️ 한계점 및 알려진 이슈 (Limitations)

* **실시간 데이터(Live) 미지원:** 현재 프로토타입은 과거 경기(Historical Data)의 VOD 재생 방식에 맞춰져 있습니다.
* **트랙 이미지 부재:** F1 API는 서킷의 절대 좌표 배경 이미지를 제공하지 않으므로, 세션 중 가장 빠른 랩(Fastest Lap)의 좌표 궤적을 기반으로 트랙의 뼈대를 역산하여 렌더링합니다. 다른 차량이 코스 아웃(Run-off)할 경우 트랙 바깥을 달리는 것처럼 보일 수 있습니다.
* **보간(Interpolation) 한계:** 통신 음영 지역에서 데이터가 누락된 경우, 차량이 코너를 무시하고 맵을 직선으로 관통하여 이동할 수 있습니다.

```

```
