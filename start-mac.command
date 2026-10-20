#!/bin/bash
cd "$(dirname "$0")"

# Locate Node.js & npm
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  if [ -f "./.runtime/node/bin/node" ]; then
    export PATH="$(pwd)/.runtime/node/bin:$PATH"
  else
    echo "❌ Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 Node.js(v18 이상)를 설치해 주세요."
    read -p "엔터 키를 누르면 종료합니다..."
    exit 1
  fi
fi

echo "🚀 ClipSync Desktop 시작 준비 중..."
cd desktop

if [ ! -d "node_modules" ]; then
  echo "📦 필수 패키지를 설치합니다 (최초 1회 실행)..."
  npm install
fi

echo "✨ ClipSync를 실행합니다..."
npm start
