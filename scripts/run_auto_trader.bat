@echo off
REM ---------------------------------------------------------------------------
REM run_auto_trader.bat - wrapper so Task Scheduler can run one trading cycle.
REM Runs a SINGLE cycle (connect -> evaluate 15m -> manage paper position) and
REM exits. Task Scheduler re-runs it every 15 minutes. All output is appended to
REM logs\auto_trader.log by the script itself; this wrapper also tees stdout.
REM ---------------------------------------------------------------------------

REM Project root = parent of this scripts\ folder.
set "PROJECT_DIR=%~dp0.."
pushd "%PROJECT_DIR%"

REM Full path to node so the task works regardless of PATH in the task context.
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" scripts\auto_trader.js >> "logs\auto_trader.stdout.log" 2>&1

popd
exit /b %ERRORLEVEL%
