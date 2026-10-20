# ClipSync Build & Packaging Guide

This document outlines the step-by-step process for developing, building, and packaging ClipSync across macOS and Windows.

---

## 1. Prerequisites

### All Platforms
- **Node.js**: `v18.0.0` or higher (`v20.x LTS` recommended).
- **npm**: `v9.0.0` or higher.
- **Git**: `v2.30.0` or higher.

### macOS Build Requirements
- macOS 12 (Monterey) or higher.
- Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- (Optional for notarization) Apple Developer Account credentials.

### Windows Build Requirements
- Windows 10 / 11 (64-bit).
- PowerShell 5.1 or PowerShell Core 7+.
- (Optional) Visual Studio C++ Build Tools.

---

## 2. Repository Setup & Dependencies

Clone the repository and install all dependencies across the monorepo:

```bash
git clone https://github.com/<your-username>/clipsync.git
cd clipsync

# Install root, desktop, and server dependencies in one command
npm run install:all
```

Or install individually:
```bash
# Root tooling
npm install

# Desktop app dependencies
cd desktop && npm install && cd ..

# Standalone relay server dependencies
cd server && npm install && cd ..
```

---

## 3. Running in Development Mode

### Running the Desktop App
```bash
npm run dev
# or
npm start
```
This launches the Electron app with hot reload support for the renderer process. The embedded relay server will automatically start on `http://localhost:4580`.

### Running Standalone Server Only
If you wish to test or host the relay server independently (e.g. on a headless Linux server or Docker):
```bash
npm run server
```
Server starts on `http://0.0.0.0:4580` by default. You can change the port with the `PORT` environment variable:
```bash
PORT=8080 npm run server
```

---

## 4. Building Distribution Installers

### 4.1 macOS Installer (DMG & ZIP)

To build macOS packages for Apple Silicon and Intel:
```bash
npm run build:mac
```
Output files will be generated in `desktop/dist/`:
- `ClipSync-<version>-arm64.dmg` (Apple Silicon M1/M2/M3/M4)
- `ClipSync-<version>-arm64-mac.zip`
- `ClipSync-<version>-x64.dmg` (Intel Mac)

#### macOS Code Signing & Notarization (Optional)
Set the following environment variables prior to running `npm run build:mac`:
```bash
export CSC_LINK="/path/to/certificate.p12"
export CSC_KEY_PASSWORD="your-certificate-password"
export APPLE_ID="developer@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

---

### 4.2 Windows Installer (NSIS EXE & ZIP)

To build Windows packages:
```cmd
npm run build:win
```
Output files will be generated in `desktop/dist/`:
- `ClipSync-Setup-<version>.exe` (Interactive NSIS Installer)
- `ClipSync-<version>-win.zip` (Portable ZIP package)

#### Windows Code Signing (Optional)
Set the following environment variables:
```cmd
set CSC_LINK=C:\path\to\code-signing-certificate.pfx
set CSC_KEY_PASSWORD=your-certificate-password
```

---

## 5. Automated CI/CD (GitHub Actions)

This repository includes a multi-platform GitHub Actions workflow at [`.github/workflows/build.yml`](file:///Applications/clip%20sync/clipsync-github/.github/workflows/build.yml).

### Triggering Builds
- **Release Drafts**: Push a Git tag matching `v*` (e.g., `git tag v1.0.0 && git push origin v1.0.0`).
- **Pull Requests**: Every PR against `main` automatically runs sanity checks and packaging tests.
- **Manual Trigger**: Go to **Actions** -> **Build and Package ClipSync** -> **Run workflow**.

---

## 6. Icon Assets & Customization

Application icons are stored in `desktop/build/`:
- `icon.icns`: High-resolution Apple ICNS containing 16x16 up to 1024x1024 Retina icons.
- `icon.ico`: Multi-layer Windows ICO containing 16, 24, 32, 48, 64, 128, 256 pixel layers.
- `icon.png`: 512x512 PNG source graphic.

To regenerate icons from a high-resolution SVG or PNG, you can use `electron-icon-builder` or standard macOS `iconutil`.

---

## 7. Portable Quick-Launch Scripts

For development and portability without installing into `/Applications` or `Program Files`:
- **macOS**: Double-click [`start-mac.command`](file:///Applications/clip%20sync/clipsync-github/start-mac.command)
- **Windows**: Double-click [`start-windows.bat`](file:///Applications/clip%20sync/clipsync-github/start-windows.bat)
