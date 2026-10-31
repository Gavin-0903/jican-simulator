#!/bin/zsh
# macOS：双击启动机惨模拟器（自动打开浏览器窗口）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 20 或以上版本：https://nodejs.org"
  read -r "?按回车键退出…"
  exit 1
fi
if [ ! -d node_modules/ws ]; then
  echo "首次运行，正在安装依赖（需要联网，只需一次）…"
  npm install --no-audit --no-fund || { read -r "?安装失败，按回车键退出…"; exit 1; }
fi
node server/index.js --open
