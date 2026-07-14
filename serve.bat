@echo off
rem Serve World Atlas Surveyor locally.
rem Browsers refuse to load ES modules from file:// URLs, so the app needs a
rem local HTTP server. Uses Python 3 if available, falling back to Node (npx).
rem Usage: serve.bat [port]   (double-click also works; opens your browser.
rem If the port is taken or reserved by Windows, nearby ports are tried.)
setlocal
pushd "%~dp0"
set "REQ=%~1"
if "%REQ%"=="" set "REQ=5654"

rem Probe that each runtime actually works -- Windows ships fake py/python
rem stubs on PATH that fail when a real Python isn't installed.
set "PY="
py -3 -c "import http.server" >nul 2>nul && set "PY=py -3"
if not defined PY (
    python -c "import http.server" >nul 2>nul && set "PY=python"
)
if not defined PY (
    node -e "0" >nul 2>nul && set "USE_NODE=1"
)
if not defined PY if not defined USE_NODE (
    echo Error: no working Python 3 or Node.js found. Install one and retry.
    pause
    goto :end
)

rem Find a port that actually binds -- the requested one may be taken by
rem another app or sit in a Windows reserved range; either way the bind
rem fails (often as WinError 10013), so test before launching.
set /a REQ1=REQ+1
set /a REQ2=REQ+2
set "PORT="
for %%P in (%REQ% %REQ1% %REQ2% 8080 8888 9000) do call :tryport %%P
if not defined PORT (
    echo Error: no free local port found ^(tried %REQ%-%REQ2%, 8080, 8888, 9000^).
    echo If this persists, check Windows reserved ranges with:
    echo   netsh interface ipv4 show excludedportrange protocol=tcp
    pause
    goto :end
)
if not "%PORT%"=="%REQ%" echo Port %REQ% is unavailable, using %PORT% instead.

echo WAS - serving on http://localhost:%PORT%/  (Ctrl+C to stop)
if not defined WAS_NO_OPEN start "" "http://localhost:%PORT%/"

if defined PY (
    %PY% -m http.server %PORT% --bind 127.0.0.1
) else (
    call npx --yes serve --listen tcp://127.0.0.1:%PORT% .
)
goto :end

:tryport
if defined PORT goto :eof
if defined PY (
    %PY% -c "import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',%1));s.close()" >nul 2>nul && set "PORT=%1"
) else (
    node -e "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen(%1,'127.0.0.1',()=>s.close(()=>process.exit(0)))" >nul 2>nul && set "PORT=%1"
)
goto :eof

:end
popd
