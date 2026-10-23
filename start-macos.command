#!/bin/zsh
set -u

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 22.13 或更高版本。"
  read -r "?按回车退出..."
  exit 1
fi

trap 'exit 0' INT TERM
node scripts/harden-state-acl.mjs --quiet

while true; do
  node src/bridge.js
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "桥接已在另一个窗口运行，退出。"
    read -r "?按回车退出..."
    exit 2
  fi
  if [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    exit 0
  fi
  echo "桥接退出（code $code），5 秒后重启..."
  sleep 5
done
