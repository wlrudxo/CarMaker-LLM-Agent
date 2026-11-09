# CarMaker LLM Agent

IPG CarMaker 자율주행 시뮬레이션에 LLM Agent를 연결해, 주행 중 상황을 판단하고 차량을 제어하는 연구용 애플리케이션입니다.

![CarMaker 수동 작업의 병목과 CarMaker Agent 루프](docs/images/concept.png)

## 동작 구조

![CarMaker telemetry에서 trigger, LLM 판단, 명령 실행, 결과 환류로 이어지는 루프](docs/images/loop_overview.png)

1. CarMaker telemetry(10 Hz)를 trigger 조건식으로 감시합니다.
2. 조건이 맞으면 시뮬레이션을 멈추고 차량 상태를 LLM에 보냅니다.
3. LLM 응답을 제어 명령으로 바꿔 실행하고 시뮬레이션을 재개합니다.
4. 실행 결과를 다시 LLM에 전달해 다음 판단을 보정합니다(Feedback Loop).

## 예시: 보행자 긴급 회피

버스 뒤에서 보행자가 뛰어드는 시나리오(약 65 km/h, 제동만으로는 회피 불가)에서 세 방식을 비교했습니다.

| 이미지 | 결과 |
|---|---|
| ![보행자 긴급 회피 장면](docs/images/pedestrian_scene.png) | **Rule-based (AEB)**: 보행자 충돌<br>**LLM Single-shot**: 과조향으로 건물 충돌<br>**LLM Feedback Loop**: 실패 결과로 조향, 제동을 보정해 회피 |

![제어 방식별 차량 궤적 비교](docs/images/trajectory_comparison.png)

## 주요 기능

- LLM 채팅으로 시뮬레이션 조작
- 조건식 기반 trigger 등록(아래 예시)
- 시나리오별 프롬프트 템플릿
- 실시간 telemetry 확인
- 독립 실행 Python 도구(제어, 모니터링, 실험)

![trigger 조건 설정 화면](docs/images/trigger_examples.png)

## 구성

```text
SvelteKit UI ── HTTP ── FastAPI backend ── Claude CLI
                              │
                        TCP command
                              │
                      IPG CarMaker
```

| 경로 | 내용 |
|---|---|
| `v3/apps/frontend/` | 웹 UI |
| `v3/apps/desktop-electron/` | 데스크톱 셸 |
| `v3/services/python-api/` | API, 명령 실행, trigger 루프 |
| `workspace/carmaker_llm_scenario_skill/agent/` | 독립 실행 도구 |
| `MapGenerator/` | 지도 검색(선택) |

## 요구사항

- Windows, Python 3.11+, Node.js 20.19+ 또는 22.12+
- IPG CarMaker(별도 라이선스, 저장소에 포함하지 않음)와 TCP command interface
- 인증된 Claude CLI

## 실행

```powershell
v3\start_v3_dev.bat
```

처음 실행하면 Python 가상환경과 npm 패키지를 설치하고, backend, frontend(`http://127.0.0.1:4173`), 데스크톱 셸을 함께 띄웁니다. 앱 설정에서 CarMaker host와 TCP 포트, Claude workspace를 지정한 뒤 연결합니다. backend 설정 예시는 `v3/services/python-api/.env.example`에 있습니다.

## 인용

지경태, 원동열, 고찬혁, 한경석. "LLM 에이전트를 활용한 CarMaker 기반 자율주행 시뮬레이션 의사결정 시스템." 한국자동차공학회 2026 춘계학술대회.

## 사사

이 연구는 2025년도 정부(과학기술정보통신부)의 재원으로 정보통신기획평가원의 지원을 받아 수행된 연구임 (No.RS-2025-25422680, Meta cognitive AGI Framework and its Applications)

## 라이선스

MIT License, VOICE Lab, Hanyang University
