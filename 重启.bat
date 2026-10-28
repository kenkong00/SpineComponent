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
title Spine 人物装配工坊（强制重启）
echo ==================================================
echo   Spine 人物装配工坊 —— 强制重启
echo.
echo   会先结束旧实例，再启动新的；
echo   关掉这个窗口 = 停止服务
echo ==================================================
echo.

"%NODE%" launcher.js --port=%PORT% --restart
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto done

echo.
echo [启动失败] 退出码 %RC%，请把上面的日志发给开发者。
echo.
pause
exit /b %RC%

:done
echo.
echo 已重启完成，本窗口 3 秒后自动关闭...
timeout /t 3 >nul
exit /b 0
