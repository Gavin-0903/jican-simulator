@echo off
chcp 65001 >nul
rem Windows：双击启动机惨模拟器（自动打开浏览器窗口）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或以上版本：https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\ws (
  echo 首次运行，正在安装依赖（需要联网，只需一次）…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server\index.js --open
pause
