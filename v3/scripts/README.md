# Development launchers

`dev-windows.ps1` and `dev.mjs` start the frontend, backend and Electron shell. The Windows launcher selects a free backend port and prints the URL. Use that exact URL with standalone agents.

Launcher regression checks:

```powershell
powershell.exe -NoProfile -File v3/scripts/tests/dev-windows.Tests.ps1
powershell.exe -NoProfile -File v3/scripts/tests/dependency-install.Tests.ps1 -OutputDirectory outputs/launcher-checks
```

Offline preflight (replace the paths and TestRun name with your licensed installation and project):

```powershell
python workspace/carmaker_llm_scenario_skill/agent/carmaker_research_runner.py preflight --backend-url http://127.0.0.1:8000 --project-dir ./my-project --carmaker-root $env:CARMAKER_ROOT --testrun MyTestRun
```

Preflight checks paths without contacting or starting CarMaker. It does not verify a license or which project the running GUI has loaded.
