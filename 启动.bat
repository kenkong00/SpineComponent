@echo off
setlocal
cd /d "%~dp0"
set "PORT=5310"

rem ---- 找 node：优先 PATH，其次 WorkBuddy 内置版本 ----
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto run
set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto run

echo.
echo [启动失败] 这台电脑上没找到 Node.js。
echo   请先安装 Node.js 18 或更高版本：https://nodejs.org
echo.
pause
exit /b 1

:run
title Spine 人物装配工坊
echo ==================================================
echo   Spine 人物装配工坊
echo.
echo   地址: http://127.0.0.1:%PORT%
echo   浏览器会自动打开；关掉这个窗口 = 停止服务
echo ==================================================
echo.

"%NODE%" launcher.js --port=%PORT%
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" goto reuse
if "%RC%"=="3" goto busy

echo.
echo [启动失败] 运行出错，退出码 %RC%。
echo   请把上面的日志发给开发者。
echo.
pause
exit /b %RC%

:busy
echo.
echo [启动失败] 端口 %PORT% 被占用，而且占用的不是本工坊。
echo   · 强制接管：双击「重启.bat」
echo   · 换个端口：用记事本打开本文件，把 set "PORT=5310" 改成 5311
echo.
pause
exit /b 3

:reuse
echo.
echo 服务已经在另一个窗口里跑着了，本窗口 3 秒后自动关闭...
timeout /t 3 >nul
exit /b 0
