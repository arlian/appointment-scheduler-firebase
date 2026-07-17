@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"
set "URL=http://localhost:%PORT%"

call :cari_python || exit /b 1
call :bebaskan_port
call :jalankan_server
call :tunggu_server_siap
call :buka_browser

echo.
echo Aplikasi berjalan di %URL%
echo Tutup jendela "Jadwal Treatment Server" untuk menghentikan server.
pause >nul
exit /b 0


REM ---- Cari perintah python yang tersedia (python / py) ----
:cari_python
    where python >nul 2>&1
    if %errorlevel%==0 (
        set "PY=python"
        exit /b 0
    )
    where py >nul 2>&1
    if %errorlevel%==0 (
        set "PY=py"
        exit /b 0
    )
    echo Python tidak ditemukan. Install Python lalu coba lagi.
    pause
    exit /b 1


REM ---- Matikan proses lama yang masih menempati PORT (jika ada) ----
:bebaskan_port
    echo Mengecek port %PORT% ...
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
        echo Port %PORT% sedang dipakai oleh PID %%P, menghentikan proses lama...
        taskkill /PID %%P /F >nul 2>&1
    )
    exit /b 0


REM ---- Start server Python di window terpisah (minimized) ----
:jalankan_server
    echo Menjalankan server di %URL% ...
    start "Jadwal Treatment Server" /min %PY% "%~dp0serve.py" %PORT%
    exit /b 0


REM ---- Polling sampai server merespons (maks 10 detik) ----
:tunggu_server_siap
    set /a tries=0
    :tunggu_loop
        curl -sf "%URL%" >nul 2>&1
        if not errorlevel 1 exit /b 0
        set /a tries+=1
        if %tries% geq 20 exit /b 0
        timeout /t 1 /nobreak >nul
        goto tunggu_loop


REM ---- Buka URL aplikasi di browser default ----
:buka_browser
    start "" "%URL%"
    exit /b 0
