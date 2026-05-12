@echo off
REM K3Vision Quick Start Script - Windows Batch
REM Run as: start.bat

cd /d "e:\POLITEKNIK NEGERI BANDUNG\Pilmapres 2026\ProdukInovatif\K3Vision"

REM Check if venv exists
if not exist "venv311\Scripts\activate.bat" (
    echo [*] Creating virtual environment...
    python -m venv venv311
)

REM Activate virtual environment
echo [+] Activating virtual environment...
call venv311\Scripts\activate.bat

REM Install dependencies
echo [*] Installing dependencies...
pip install -r requirements.txt

REM Start application
echo.
echo [+] Starting K3Vision Server...
echo [*] Dashboard: http://127.0.0.1:8000/
echo [*] Press Ctrl+C to stop
echo.

uvicorn main:app --reload --port 8000
pause
