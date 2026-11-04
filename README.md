# CarMaker LLM Agent

A research application that connects an LLM agent to autonomous driving simulations in CarMaker. A trigger monitors simulation state, pauses or slows the simulation, requests a decision from Claude CLI, and executes structured vehicle-control commands. The interface provides chat, prompt templates, telemetry and rule-based trigger controls.

## Components

```text
SvelteKit / Svelte 5 UI
         | HTTP
FastAPI backend ---- Claude CLI (authenticated separately)
         | TCP command interface
Licensed CarMaker installation and your simulation project
```

- `v3/apps/frontend/`: browser interface.
- `v3/apps/desktop-electron/`: desktop shell and native dialogs.
- `v3/services/python-api/`: API, local persistence, command execution and trigger loop.
- `workspace/carmaker_llm_scenario_skill/agent/`: standalone Python control, monitoring, catalog and experiment tools.
- `MapGenerator/`: optional map embedding and search scripts used by the API.

## Requirements

- Windows for the bundled desktop launcher; Python 3.11 or newer and Node.js 20.19+ or 22.12+.
- A separately licensed IPG CarMaker installation with its TCP command interface enabled, plus a project and TestRun that you are entitled to use. CarMaker software, manuals, libraries, headers and sample data are not included.
- Claude CLI installed and authenticated for LLM decisions. Provider credentials and usage charges are managed separately.
- Optional map embeddings require `OPENAI_API_KEY`, an indexed map collection and network access.

## Install and run

Run these commands from the repository root in PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e "./v3/services/python-api[dev]"
cd v3/apps/frontend
npm ci
cd ../desktop-electron
npm ci
cd ../../..
```

Start each service in a separate terminal:

```powershell
# Backend (repository root)
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# Frontend
cd v3/apps/frontend
npm run dev
# Desktop shell (another terminal)
cd v3/apps/desktop-electron
npm run dev
```

Alternatively, `v3/start_v3_dev.bat` creates service-local environments and starts the three components on Windows. The launcher prints its selected backend port; use that URL for agents. The frontend is served at `http://127.0.0.1:4173`.

Configure CarMaker's host and TCP command port in the application before connecting. Set the Claude workspace in application settings. The backend stores new data under the user application-data directory `CarMaker-LLM-Agent`; `DATA_DIR` overrides this location. An example backend configuration is provided in `v3/services/python-api/.env.example`.

Standalone tools expose usage with:

```powershell
python workspace/carmaker_llm_scenario_skill/agent/carmaker_research_runner.py --help
```

Set `CARMAKER_ROOT` or pass `--carmaker-root` to catalog/experiment commands. Pass `--backend-url` explicitly; older standalone tools default to port 8010. Supply your own licensed project and TestRun. Keep generated catalogs and reports local.

## Verification and limitations

```powershell
.venv/Scripts/python.exe -m pytest v3/services/python-api/tests
cd v3/apps/frontend
npm run check
npm run build
```

The extracted application is a research prototype. Live CarMaker, LLM decisions and paid embedding calls require separate environment validation. Telemetry uses polling. Database import/export uses file copies; avoid importing or exporting while writes are active. Included tests use isolated data. No benchmark data or paper experiment results are bundled.

## Citation

Kyoungtae Ji, Dongyeol Won, Chanhyeok Ko, and Kyoungseok Han. “LLM 에이전트를 활용한 CarMaker 기반 자율주행 시뮬레이션 의사결정 시스템” (LLM Agent-Based Decision-Making System for Autonomous Driving Simulation in CarMaker). KSAE 2026 Spring Conference.

## Acknowledgment

이 논문은 2025년도 정부(과학기술정보통신부)의 재원으로 정보통신기획평가원의 지원을 받아 수행된 연구임 (No.RS-2025-25422680, Meta cognitive AGI Framework and its Applications)

## License and provenance

MIT License, copyright 2026 VOICE Lab, Hanyang University. Third-party dependencies retain their own licenses. This repository starts a new history from selected application sources in the private AGI_VOICE repository, source commit `f1c7171fa1f7bee17ac2448e2ce792bbfc21ad7e`.
