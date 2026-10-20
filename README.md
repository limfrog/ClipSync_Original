# ClipSync (클립싱크)

> **Cross-Platform Real-Time Universal Clipboard & File Synchronization**  
> macOS, Windows, Linux, iOS 및 웹 브라우저 간의 초고속 실시간 클립보드 및 대용량 파일 동기화 솔루션

[![Build Status](https://img.shields.io/badge/build-20261020.7-brightgreen.svg)](docs/BUILDING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Web-lightgrey.svg)](docs/ARCHITECTURE.md)
[![Electron](https://img.shields.io/badge/Electron-33.0.0-47848F.svg)](desktop/package.json)
[![Node](https://img.shields.io/badge/Node-20%2B-339933.svg)](package.json)

---

## 📖 목차 / Table of Contents
- [한국어 소개](#-한국어-소개)
  - [핵심 기능](#-핵심-기능)
  - [빠른 시작](#-빠른-시작)
  - [폴더 구조](#-프로젝트-구조)
  - [빌드 및 패키징](#-빌드-및-패키징)
- [English Overview](#-english-overview)
  - [Key Features](#-key-features)
  - [Quick Start](#-quick-start)
  - [Documentation Links](#-documentation-links)
- [License](#-license)

---

## 🇰🇷 한국어 소개

**ClipSync**는 Mac과 윈도우 PC, 스마트폰(아이폰/안드로이드), 웹 브라우저 사이에서 텍스트, 코드, 이미지, 그리고 **최대 100MB 크기의 대용량 파일**을 별도의 클라우드 가입 없이 로컬 네트워크 또는 릴레이 서버를 통해 실시간으로 즉시 전송하고 동기화하는 모던 클립보드 매니저입니다.

### 🌟 핵심 기능

1. **초고속 실시간 동기화 (Sub-second Latency)**
   - 텍스트, URL, 스크린샷 이미지, 파일 복사 시 0.5초 이내에 상대방 기기의 클립보드로 즉시 전송됩니다.
   - 단방향이 아닌 완벽한 양방향 실시간 웹소켓(WebSocket) 이벤트 기반 동기화.

2. **완벽한 한글 인코딩 보존 & 자모 분리 방지**
   - macOS 특유의 자모 분리 현상(NFD: `ㄱㅗㅇㅈㅜ`)을 표준 유니코드(NFC: `공주`)로 자동 정규화.
   - Windows의 CP949 / EUC-KR 텍스트 및 CSV 파일을 UTF-8로 자동 변환하여 맥과 윈도우 양쪽에서 깨짐 없이 열람 가능.
   - RFC 5987 표준 파일명 인코딩 헤더를 적용하여 한글 파일명이 온전히 보존됩니다.

3. **듀얼 엔진 파일 클립보드 감지**
   - macOS: AppleScript / JXA Fallback 엔진을 탑재하여 Finder에서 복사한 파일 목록을 100% 감지.
   - Windows: `FileNameW`, `HDROP` 및 Electron 네이티브 포맷을 통합 파싱.
   - 최대 100MB 단일 파일 및 다중 파일 복사/붙여넣기 완벽 지원.

4. **Apple iOS 단축어 (Shortcuts) 1단계 연동**
   - 아이폰에서 클립보드를 복사하고 "ClipSync Push" 단축어 한 번만 누르면 Mac/PC로 즉각 전송.
   - Mac/PC에서 복사된 최신 텍스트, 이미지, 파일을 아이폰에서 1단계 단축어로 즉시 수신.

5. **현대적인 Glassmorphism 사용자 인터페이스**
   - **다크 모드 / 라이트 모드 / 시스템 설정 자동 감지** 지원.
   - **글로벌 단축키 커스터마이징** (원하는 키 조합으로 클립보드 창 토글).
   - **항상 위에 고정 (Pin Window)**: 창을 항상 위에 띄워두거나 다른 앱 클릭 시 자동으로 숨기도록 자유롭게 전환.
   - **원클릭 히스토리 활성화 & 검색**: 과거 복사 기록을 다시 클릭하여 즉시 현재 클립보드로 재복사.
   - 즐겨찾기 고정(Pin Item) 및 불필요한 히스토리 일괄 비우기.

---

### 🚀 빠른 시작

#### 1. 저장소 클론 및 패키지 설치
```bash
git clone https://github.com/<your-username>/clipsync.git
cd clipsync

# 모든 패키지(루트, 데스크톱, 서버) 일괄 설치
npm run install:all
```

#### 2. 개발 모드로 실행
```bash
# 데스크톱 앱 실행 (내장 릴레이 서버 동시 구동)
npm start
```

#### 3. 간편 실행 스크립트 (무설치 포터블)
- **macOS**: `start-mac.command` 더블 클릭
- **Windows**: `start-windows.bat` 더블 클릭

---

### 📁 프로젝트 구조

```plaintext
clipsync/
├── .github/
│   └── workflows/
│       └── build.yml          # GitHub Actions 멀티 OS 자동 빌드 CI/CD
├── desktop/                   # Electron 데스크톱 앱 소스코드
│   ├── main.js                # 메인 프로세스 (클립보드 폴링, 핫키, 시스템 트레이, 창 관리)
│   ├── preload.js             # 보안 컨텍스트 브릿지 (IPC)
│   ├── renderer.html          # 모던 Glassmorphism UI (설정, 테마, 히스토리, 검색)
│   ├── afterPack.js           # 패키징 후처리 스크립트
│   ├── package.json           # Electron 및 번들러 설정
│   ├── build/                 # 고해상도 앱 아이콘 (icon.icns, icon.ico, icon.png)
│   └── embedded-server/       # 앱 내장 독립형 릴레이 서버 (오프라인/로컬 구동용)
├── server/                    # 독립형 웹/릴레이 서버 (Render, Docker, VPS 배포용)
│   ├── index.js               # Express + WebSocket 양방향 릴레이 서버
│   ├── Dockerfile             # 컨테이너 배포용 Docker 설정
│   └── public/                # 웹 클라이언트 PWA (브라우저용 UI)
├── docs/                      # 기술 문서
│   ├── ARCHITECTURE.md        # 시스템 아키텍처 및 동기화 루프 다이어그램
│   ├── API.md                 # REST API 및 WebSocket 프로토콜 명세서
│   └── BUILDING.md            # 맥/윈도우 빌드 및 패키징 가이드
├── start-mac.command          # macOS 원클릭 간편 실행 스크립트
├── start-windows.bat          # Windows 원클릭 간편 실행 배치파일
├── package.json               # 모노레포 통합 스크립트 (빌드/실행/의존성)
└── LICENSE                    # MIT 라이선스
```

---

### 🔨 빌드 및 패키징

#### macOS 설치 패키지 (.dmg / .zip)
```bash
npm run build:mac
```
- 결과물: `desktop/dist/ClipSync-1.0.0-arm64.dmg` (Apple Silicon) 및 Intel x64 패키지.

#### Windows 설치 패키지 (.exe / .zip)
```bash
npm run build:win
```
- 결과물: `desktop/dist/ClipSync-Setup-1.0.0.exe` (NSIS 인스톨러).

자세한 빌드 가이드와 코드 서명 환경설정은 [docs/BUILDING.md](docs/BUILDING.md) 문서를 참고하세요.

---

## 🌐 English Overview

**ClipSync** is an open-source, ultra-fast real-time clipboard and file synchronizer engineered for seamless interoperability across macOS, Windows, Linux, iOS, and Web browsers.

### ✨ Key Features
- **Zero-Config Real-Time Sync**: Instant synchronization of text, URLs, screenshots, and rich media via low-latency WebSockets.
- **Large File Support**: Transfer and synchronize files up to 100MB with automatic hash verification and disk hygiene.
- **Robust Encoding Guard**: Automatic conversion of Windows CP949 / EUC-KR and macOS decomposed NFD characters into normalized UTF-8 NFC.
- **Dual-Engine Clipboard Watcher**: Native Win32 clipboard format handling combined with macOS JXA / AppleScript fallback listeners.
- **iOS Shortcuts Integration**: Native 1-click iOS Siri Shortcuts to push and pull your universal clipboard seamlessly from iPhone or iPad.
- **Customizable Experience**: Dark, Light, and System themes, customizable global hotkeys, always-on-top window pin mode, and search filtering.

### 🚀 Quick Start
```bash
git clone https://github.com/<your-username>/clipsync.git
cd clipsync
npm run install:all
npm start
```

---

## 📚 Documentation Links
- 📐 [System Architecture & Data Flows](docs/ARCHITECTURE.md)
- 🔌 [REST & WebSocket API Specification](docs/API.md)
- 🛠️ [Building & Packaging Manual](docs/BUILDING.md)

---

## 📄 License
This project is licensed under the terms of the [MIT License](LICENSE).
Copyright (c) 2026 ClipSync Contributors.
