// Shim for Express 4.x compatibility with mime v2/v3 hoisted in Electron
try {
  const send = require('send');
  if (send && send.mime) {
    if (!send.mime.charsets) {
      send.mime.charsets = { lookup: () => 'UTF-8' };
    }
    if (!send.mime.lookup && typeof send.mime.getType === 'function') {
      send.mime.lookup = send.mime.getType.bind(send.mime);
    }
  }
} catch {}
try {
  const mime = require('mime');
  if (mime) {
    if (!mime.charsets) {
      mime.charsets = { lookup: () => 'UTF-8' };
    }
    if (!mime.lookup && typeof mime.getType === 'function') {
      mime.lookup = mime.getType.bind(mime);
    }
  }
} catch {}

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  nativeImage,
  globalShortcut,
  ipcMain,
  shell,
  dialog,
  nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { pathToFileURL, fileURLToPath } = require('url');
const { execFileSync, execFile } = require('child_process');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const BUILD_NUMBER = '20261020.7';

let isQuitting = false;
let isFileDialogOpen = false;
let clipboardPollTimer = null;

// Prevent uncaught exceptions from popping up native blocking crash dialogs during shutdown
process.on('uncaughtException', (err) => {
  console.error('Main process uncaughtException:', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Main process unhandledRejection:', reason);
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!isQuitting) {
      showPopoverWindow();
    }
  });
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'clipsync-config.json');
const DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'ClipSync');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function generateRandomSyncKey() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // unambiguous alphanumeric
  const part = () =>
    Array.from(crypto.randomBytes(4))
      .map((b) => chars[b % chars.length])
      .join('');
  return `CS-${part()}-${part()}`;
}

const defaultConfig = {
  serverUrl: 'http://localhost:4580',
  syncKey: '',
  deviceName: `${os.hostname().replace(/\.local$/i, '')} (${process.platform === 'darwin' ? 'Mac' : 'Windows'})`,
  autoSync: true,
  autoLaunch: true,
  autoDownloadFiles: true,
  alwaysOnTop: false,
  shortcut: 'CommandOrControl+Shift+V',
  theme: 'system' // 'system' | 'dark' | 'light'
};

function applyAutoLaunchSetting(enabled) {
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden']
      });
    }
  } catch (err) {
    console.error('Failed to update auto-launch setting:', err.message);
  }
}

function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write config:', err.message);
  }
}

function loadConfig() {
  let loaded = { ...defaultConfig };
  let needsSave = false;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      loaded = { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    } else {
      needsSave = true;
    }
  } catch (err) {
    console.error('Failed to read config:', err.message);
    needsSave = true;
  }

  // Ensure every user gets a unique personal Sync Key instead of colliding on 'default'
  if (!loaded.syncKey || loaded.syncKey === 'default') {
    loaded.syncKey = generateRandomSyncKey();
    needsSave = true;
  }

  if (needsSave) {
    saveConfig(loaded);
  }
  return loaded;
}

let config = loadConfig();
let currentContextMenu = null;
let tray = null;
let mainWindow = null;
let wsClient = null;
let wsReconnectTimer = null;
let isConnected = false;
let connectedDevices = [];
let cachedItems = [];
let networkInfo = { localUrl: config.serverUrl, ips: [] };
const myClientId = crypto.randomUUID();

function isWindowAlive() {
  try {
    return Boolean(mainWindow && !mainWindow.isDestroyed());
  } catch {
    return false;
  }
}

// Track last known local clipboard signature to prevent sync loops
let lastClipboardSignature = '';
let ignoreClipboardUntil = 0;

// Create a crisp PNG icon buffer programmatically for Tray (works on macOS Template & Windows)
function createClipboardPngBuffer(size = 32, isMacTemplate = false) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4), 0);

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const rowOffset = y * (1 + width * 4) + 1;
    const idx = rowOffset + x * 4;
    rawData[idx] = r;
    rawData[idx + 1] = g;
    rawData[idx + 2] = b;
    rawData[idx + 3] = a;
  }

  const scale = size / 32;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / scale;
      const ny = y / scale;

      // Board outline: x in [6..25], y in [6..28]
      const inBoardOuter = nx >= 6 && nx <= 25 && ny >= 6 && ny <= 28;
      const inBoardInner = nx >= 8.5 && nx <= 22.5 && ny >= 8.5 && ny <= 25.5;
      // Top clip: x in [11..20], y in [3..8]
      const inClip = nx >= 11 && nx <= 20 && ny >= 3 && ny <= 8;
      // Lines inside board
      const inLine1 = nx >= 10.5 && nx <= 20.5 && ny >= 13 && ny <= 15;
      const inLine2 = nx >= 10.5 && nx <= 20.5 && ny >= 17.5 && ny <= 19.5;
      const inLine3 = nx >= 10.5 && nx <= 17 && ny >= 22 && ny <= 24;

      const isForeground =
        inClip || (inBoardOuter && !inBoardInner) || inLine1 || inLine2 || inLine3;

      if (isForeground) {
        if (isMacTemplate) {
          setPixel(x, y, 0, 0, 0, 255);
        } else {
          setPixel(x, y, 99, 102, 241, 255);
        }
      } else if (!isMacTemplate && inBoardInner) {
        setPixel(x, y, 19, 28, 49, 230);
      }
    }
  }

  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
    }
    return (c ^ -1) >>> 0;
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcVal = crc32(Buffer.concat([typeBuf, data]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function createTrayIcon() {
  const isMac = process.platform === 'darwin';
  if (isMac) {
    const buf1x = createClipboardPngBuffer(18, true);
    const buf2x = createClipboardPngBuffer(36, true);
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1.0, width: 18, height: 18, buffer: buf1x });
    img.addRepresentation({ scaleFactor: 2.0, width: 36, height: 36, buffer: buf2x });
    img.setTemplateImage(true);
    return img;
  } else {
    const buf = createClipboardPngBuffer(32, false);
    return nativeImage.createFromBuffer(buf);
  }
}

let localRelayStarted = false;
function ensureLocalRelayServer() {
  try {
    const u = new URL(config.serverUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      if (localRelayStarted) return;
      localRelayStarted = true;
      process.env.CLIPSYNC_DATA_DIR = path.join(app.getPath('userData'), 'relay-storage');
      const bundledScript = path.join(__dirname, 'embedded-server/index.js');
      const devScript = path.resolve(__dirname, '../server/index.js');
      if (fs.existsSync(bundledScript)) {
        console.log('Starting bundled ClipSync Relay Server...');
        require(bundledScript);
      } else if (fs.existsSync(devScript)) {
        console.log('Starting local ClipSync Relay Server...');
        require(devScript);
      }
    }
  } catch (err) {
    console.error('Relay check error:', err.message);
  }
}

// HTTP JSON helper with robust timeout and safe fallback
function apiRequest(method, endpoint, bodyObj = null, timeoutMs = 3500) {
  return new Promise((resolve) => {
    try {
      const target = new URL(endpoint, config.serverUrl);
      const lib = target.protocol === 'https:' ? https : http;
      const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf-8') : null;
      const req = lib.request(
        target,
        {
          method,
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'x-sync-key': config.syncKey,
            ...(payload ? { 'Content-Length': payload.length } : {})
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve({ ok: res.statusCode < 400, raw });
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'Request timeout' });
      });
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// Automatically zip a directory or .app bundle into a temporary zip file
function createZipFromDirectory(dirPath) {
  return new Promise((resolve, reject) => {
    try {
      const dirName = path.basename(dirPath);
      const tempZip = path.join(
        os.tmpdir(),
        `clipsync_${dirName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.zip`
      );
      if (process.platform === 'darwin') {
        // macOS ditto preserves Mac bundle metadata, code signatures, and resource forks
        execFile(
          '/usr/bin/ditto',
          ['-c', '-k', '--sequesterRsrc', '--keepParent', dirPath, tempZip],
          { timeout: 45000 },
          (err) => {
            if (err) return reject(err);
            resolve({ zipPath: tempZip, originalName: `${dirName}.zip` });
          }
        );
      } else if (process.platform === 'win32') {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -LiteralPath '${dirPath.replace(/'/g, "''")}' -DestinationPath '${tempZip.replace(/'/g, "''")}' -Force`
          ],
          { timeout: 45000 },
          (err) => {
            if (err) return reject(err);
            resolve({ zipPath: tempZip, originalName: `${dirName}.zip` });
          }
        );
      } else {
        reject(new Error('Directory upload not supported on this platform'));
      }
    } catch (err) {
      reject(err);
    }
  });
}

// Multipart file & folder upload helper
async function uploadFileToServer(filePath, asFile = false) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('File does not exist');
  }

  const stat = fs.statSync(filePath);
  let uploadPath = filePath;
  let isTempZip = false;
  let finalFileName = path.basename(filePath).normalize('NFC');

  if (stat.isDirectory()) {
    const zipped = await createZipFromDirectory(filePath);
    uploadPath = zipped.zipPath;
    finalFileName = zipped.originalName.normalize('NFC');
    isTempZip = true;
  }

  return new Promise((resolve, reject) => {
    try {
      const fileNameEncoded = encodeURIComponent(finalFileName);
      const safeHeaderFileName = finalFileName.replace(/["\\\r\n]/g, '_');
      const boundary = '----ClipSyncBoundary' + crypto.randomBytes(8).toString('hex');
      const target = new URL('/api/upload', config.serverUrl);
      const lib = target.protocol === 'https:' ? https : http;

      const ext = path.extname(finalFileName).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
        '.txt': 'text/plain; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8'
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      const fields = {
        syncKey: config.syncKey,
        sourceDevice: config.deviceName,
        sourcePlatform: process.platform,
        clientId: myClientId,
        asFile: asFile ? 'true' : 'false',
        fileNameEncoded
      };

      const preParts = [];
      for (const [k, v] of Object.entries(fields)) {
        preParts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
            'utf-8'
          )
        );
      }
      preParts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeHeaderFileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
          'utf-8'
        )
      );
      const fileBuf = fs.readFileSync(uploadPath);
      const postPart = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
      const bodyBuffer = Buffer.concat([...preParts, fileBuf, postPart]);

      const req = lib.request(
        target,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuffer.length,
            'x-file-name-encoded': fileNameEncoded
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (isTempZip) {
              try { fs.unlinkSync(uploadPath); } catch {}
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', (err) => {
        if (isTempZip) {
          try { fs.unlinkSync(uploadPath); } catch {}
        }
        reject(err);
      });
      req.write(bodyBuffer);
      req.end();
    } catch (err) {
      if (isTempZip) {
        try { fs.unlinkSync(uploadPath); } catch {}
      }
      reject(err);
    }
  });
}

// Download remote file to ~/Downloads/ClipSync
function downloadRemoteFile(downloadUrl, fileName) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      }
      const target = new URL(downloadUrl, config.serverUrl);
      const lib = target.protocol === 'https:' ? https : http;
      let rawName = fileName || 'downloaded-file';
      if (/%[0-9A-Fa-f]{2}/.test(rawName)) {
        try {
          rawName = decodeURIComponent(rawName);
        } catch {}
      }
      const safeName = path
        .basename(rawName)
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      let destPath = path.join(DOWNLOAD_DIR, safeName);

      // If destination file is locked by a PDF viewer on Windows, test opening or pick an available filename
      try {
        if (fs.existsSync(destPath)) {
          const fd = fs.openSync(destPath, 'r+');
          fs.closeSync(fd);
        }
      } catch {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        destPath = path.join(DOWNLOAD_DIR, `${base}_${Date.now().toString().slice(-4)}${ext}`);
      }

      const req = lib.get(
        target,
        {
          headers: {
            'x-sync-key': config.syncKey
          }
        },
        (res) => {
          if (res.statusCode >= 400) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const fileStream = fs.createWriteStream(destPath);
          fileStream.on('error', (err) => {
            reject(err);
          });
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close(() => resolve(destPath));
          });
        }
      );
      req.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

let isPollingClipboard = false;
let isApplyingClipboard = false;
let lastAppliedItem = null;
let lastAppliedLocalPath = null;
const macFileRefCache = new Map();

// Detect if TeamViewer (or another remote desktop agent) just wrote a broken /tmp/.CB... placeholder to the Mac clipboard
function isTeamViewerOrTempClipboard() {
  try {
    if (process.platform === 'darwin') {
      const tvBuf = clipboard.readBuffer('com.teamviewer.TVClipboard');
      if (tvBuf && tvBuf.length > 0) return true;
      const rawUrl =
        clipboard.read('public.file-url') ||
        clipboard.readBuffer('public.file-url').toString('utf8') ||
        '';
      if (rawUrl.includes('/tmp/.') || rawUrl.includes('/private/tmp/.')) return true;
      const plist =
        clipboard.read('NSFilenamesPboardType') ||
        clipboard.readBuffer('NSFilenamesPboardType').toString('utf8') ||
        '';
      if (plist.includes('/tmp/.') || plist.includes('/private/tmp/.')) return true;
    }
  } catch {}
  return false;
}

// Put a local file onto the native OS system clipboard so Cmd+V (Finder) and Ctrl+V (Explorer) paste the actual file
function writeFileToNativeClipboard(localPath) {
  if (process.platform === 'darwin') {
    const fileUrl = pathToFileURL(localPath).href;
    const isImgFile = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(localPath);
    try {
      execFileSync(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import("AppKit");
           const p = $.NSProcessInfo.processInfo.environment.objectForKey("CLIPSYNC_FILE").js;
           const isImg = $.NSProcessInfo.processInfo.environment.objectForKey("CLIPSYNC_IS_IMG").js === "1";
           const pb = $.NSPasteboard.generalPasteboard;
           pb.clearContents;
           const u = $.NSURL.fileURLWithPath(p);
           pb.writeObjects($.NSArray.arrayWithObject(u));
           pb.setPropertyListForType($.NSArray.arrayWithObject(p), "NSFilenamesPboardType");
           if (isImg) {
             const img = $.NSImage.alloc.initWithContentsOfFile(p);
             if (img && img.TIFFRepresentation) {
               pb.setDataForType(img.TIFFRepresentation, "public.tiff");
             }
           }`
        ],
        {
          env: {
            ...process.env,
            CLIPSYNC_FILE: localPath,
            CLIPSYNC_IS_IMG: isImgFile ? '1' : '0'
          },
          timeout: 2500,
          stdio: 'ignore'
        }
      );
      return;
    } catch {
      clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf-8'));
    }
  } else if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Sta',
          '-Command',
          'Set-Clipboard -LiteralPath $env:CLIPSYNC_FILE'
        ],
        {
          env: { ...process.env, CLIPSYNC_FILE: localPath },
          timeout: 3500,
          windowsHide: true,
          stdio: 'ignore'
        }
      );
      return;
    } catch {
      clipboard.writeText(localPath.normalize('NFC'));
    }
  } else {
    clipboard.writeText(localPath.normalize('NFC'));
  }
}

// If TeamViewer's clipboard sync overwrites the Mac clipboard with /tmp/.CB... right after ClipSync receives a file,
// automatically restore ClipSync's clean local file onto the clipboard.
function guardAgainstTeamViewerOverwrite() {
  if (process.platform !== 'darwin') return;
  for (const delayMs of [350, 850, 1600, 2800]) {
    setTimeout(() => {
      try {
        if (!isApplyingClipboard && isTeamViewerOrTempClipboard()) {
          if (lastAppliedLocalPath && fs.existsSync(lastAppliedLocalPath)) {
            ignoreClipboardUntil = Date.now() + 2000;
            writeFileToNativeClipboard(lastAppliedLocalPath);
          } else if (lastAppliedItem && lastAppliedItem.type === 'image' && lastAppliedItem.imageDataUrl) {
            const img = nativeImage.createFromDataURL(lastAppliedItem.imageDataUrl);
            if (!img.isEmpty()) {
              ignoreClipboardUntil = Date.now() + 2000;
              clipboard.writeImage(img);
            }
          }
        }
      } catch {}
    }, delayMs);
  }
}

// Write an item into the local OS system clipboard (and trigger macOS -> iOS Universal Clipboard!)
async function applyItemToSystemClipboard(item) {
  if (!item) return { ok: false };
  isApplyingClipboard = true;
  try {
    ignoreClipboardUntil = Date.now() + 3000;
    lastAppliedItem = item;

    if (item.type === 'image' && item.imageDataUrl) {
      const img = nativeImage.createFromDataURL(item.imageDataUrl);
      if (!img.isEmpty()) {
        const sig = computeSignature('image', item.imageDataUrl);
        lastClipboardSignature = sig;
        lastAppliedLocalPath = null;
        clipboard.writeImage(img);
        ignoreClipboardUntil = Date.now() + 2000;
        guardAgainstTeamViewerOverwrite();
        return { ok: true, mode: 'image' };
      }
    }

    if (item.type === 'file' && item.downloadUrl) {
      const localPath = await downloadRemoteFile(item.downloadUrl, item.fileName);
      ignoreClipboardUntil = Date.now() + 3000;
      lastAppliedLocalPath = localPath;
      writeFileToNativeClipboard(localPath);
      const osReportedPaths = readCopiedFilePathsFromOS();
      const sigKey =
        osReportedPaths.length > 0
          ? osReportedPaths.map((p) => p.normalize('NFC')).sort().join('|')
          : localPath.normalize('NFC');
      lastClipboardSignature = computeSignature('file', sigKey);
      ignoreClipboardUntil = Date.now() + 2500;
      guardAgainstTeamViewerOverwrite();
      return { ok: true, mode: 'file', localPath };
    }

    const textToWrite = (item.text || '').normalize('NFC');
    lastClipboardSignature = computeSignature('text', textToWrite);
    lastAppliedLocalPath = null;
    clipboard.writeText(textToWrite);
    ignoreClipboardUntil = Date.now() + 1800;
    return { ok: true, mode: 'text' };
  } catch (err) {
    console.error('Failed to apply item to system clipboard:', err.message);
    return { ok: false, error: err.message };
  } finally {
    isApplyingClipboard = false;
  }
}

function computeSignature(kind, data) {
  return crypto
    .createHash('sha256')
    .update(`${kind}:${data || ''}`)
    .digest('hex')
    .slice(0, 24);
}

// Detect whether the current OS clipboard holds a Finder/Explorer file or folder entry
// so we never mistake a Finder file icon (like the 1024x1024 PDF icon) for a copied screenshot image!
function hasFilePasteboardIndicator() {
  try {
    if (process.platform === 'darwin') {
      if (isTeamViewerOrTempClipboard()) return true;
      const rawUrl =
        clipboard.read('public.file-url') ||
        clipboard.readBuffer('public.file-url').toString('utf8');
      if (rawUrl && rawUrl.trim().startsWith('file://')) return true;
      const plist =
        clipboard.read('NSFilenamesPboardType') ||
        clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
      if (plist && plist.includes('<string>')) return true;
    } else if (process.platform === 'win32') {
      const buf = clipboard.readBuffer('FileNameW');
      if (buf && buf.length > 2) return true;
    }
  } catch {}
  return false;
}

function isValidCopyPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.startsWith('/tmp/.') || p.startsWith('/private/tmp/.')) return false;
  try {
    if (!fs.existsSync(p)) return false;
    const stat = fs.statSync(p);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

// Read copied file and folder paths from macOS Finder or Windows Explorer clipboard if present
function readCopiedFilePathsFromOS() {
  const paths = [];
  try {
    if (process.platform === 'darwin') {
      // Ignore TeamViewer / remote-desktop temporary placeholder files (/tmp/.CB...)
      if (isTeamViewerOrTempClipboard()) {
        return [];
      }

      // 1. Check NSFilenamesPboardType XML plist first (both string and buffer reads)
      const plist =
        clipboard.read('NSFilenamesPboardType') ||
        clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
      if (plist && plist.includes('<string>')) {
        const matches = plist.matchAll(/<string>([^<]+)<\/string>/g);
        for (const match of matches) {
          if (match && match[1]) {
            const unescaped = match[1]
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'");
            if (isValidCopyPath(unescaped) && !paths.includes(unescaped)) {
              paths.push(unescaped);
            }
          }
        }
        if (paths.length > 0) return paths;
      }

      // 2. Check public.file-url (including macOS Finder file:///.file/id=... reference URLs)
      const rawFileUrl = (
        clipboard.read('public.file-url') ||
        clipboard.readBuffer('public.file-url').toString('utf8') ||
        ''
      ).trim();

      if (rawFileUrl && rawFileUrl.startsWith('file://')) {
        if (!rawFileUrl.startsWith('file:///.file/id=')) {
          let decoded = '';
          try {
            decoded = fileURLToPath(rawFileUrl);
          } catch {
            decoded = decodeURIComponent(rawFileUrl.replace(/^file:\/\//, ''));
          }
          if (isValidCopyPath(decoded) && !paths.includes(decoded)) {
            paths.push(decoded);
          }
        } else {
          // Resolve macOS File Reference URL (file:///.file/id=...) via fast Foundation NSURL lookup (no slow AppKit import!)
          const plainHint = (clipboard.readText() || '').trim();
          const cacheKey = `${rawFileUrl}::${plainHint}`;
          if (macFileRefCache.has(cacheKey)) {
            const cachedList = macFileRefCache.get(cacheKey);
            const validList = (Array.isArray(cachedList) ? cachedList : [cachedList]).filter(
              isValidCopyPath
            );
            if (validList.length > 0) return validList;
          }
          try {
            const resolvedPath = execFileSync(
              '/usr/bin/osascript',
              [
                '-l',
                'JavaScript',
                '-e',
                `const raw = $.NSProcessInfo.processInfo.environment.objectForKey("CLIPSYNC_FURL").js;
                 const u = $.NSURL.URLWithString(raw);
                 u && u.filePathURL ? ObjC.unwrap(u.filePathURL.path) : "";`
              ],
              {
                env: { ...process.env, CLIPSYNC_FURL: rawFileUrl },
                encoding: 'utf8',
                timeout: 2500
              }
            ).trim();
            const valid = [resolvedPath].filter(isValidCopyPath);
            if (macFileRefCache.size > 100) macFileRefCache.clear();
            if (valid.length > 0) {
              macFileRefCache.set(cacheKey, valid);
              return valid;
            }
          } catch {}
        }
      }

      // 3. Fallback: Query NSPasteboard NSURL objects via JXA if indicator is present but paths empty
      if (paths.length === 0 && hasFilePasteboardIndicator()) {
        try {
          const res = execFileSync(
            '/usr/bin/osascript',
            [
              '-l',
              'JavaScript',
              '-e',
              `ObjC.import("AppKit");
               const pb = $.NSPasteboard.generalPasteboard;
               const classes = $.NSArray.arrayWithObject($.NSURL.class);
               const urls = pb.readObjectsForClassesOptions(classes, $());
               const count = urls ? ObjC.unwrap(urls.count) : 0;
               const list = [];
               for (let i = 0; i < count; i++) {
                 const item = urls.objectAtIndex(i);
                 if (item && item.isFileURL) {
                   const p = item.filePathURL ? ObjC.unwrap(item.filePathURL.path) : ObjC.unwrap(item.path);
                   if (p) list.push(p);
                 }
               }
               JSON.stringify(list);`
            ],
            { timeout: 2500, encoding: 'utf8' }
          ).trim();
          if (res) {
            const parsed = JSON.parse(res);
            if (Array.isArray(parsed)) {
              for (const p of parsed) {
                if (isValidCopyPath(p) && !paths.includes(p)) {
                  paths.push(p);
                }
              }
            }
          }
        } catch {}
      }
    } else if (process.platform === 'win32') {
      const buf = clipboard.readBuffer('FileNameW');
      if (buf && buf.length > 2) {
        // FileNameW is a null-terminated UTF-16LE string; split at first \0 to discard trailing buffer garbage
        let filePath = buf.toString('utf16le').split('\0')[0].trim();
        if (filePath && isValidCopyPath(filePath)) {
          // Convert any Windows 8.3 short path (e.g. DOCUME~1.PDF) to its full long filename
          try {
            if (fs.realpathSync && typeof fs.realpathSync.native === 'function') {
              filePath = fs.realpathSync.native(filePath);
            }
          } catch {}
          paths.push(filePath);
        }
      }
    }
  } catch {
    // Ignore pasteboard read errors
  }
  return paths;
}

function readCopiedFilePathFromOS() {
  const paths = readCopiedFilePathsFromOS();
  return paths.length > 0 ? paths[0] : null;
}

// Initialize current clipboard signature on startup so we don't re-push old startup content unnecessarily
function seedInitialClipboardSignature() {
  try {
    const copiedFiles = readCopiedFilePathsFromOS();
    if (copiedFiles.length > 0) {
      const sigKey = copiedFiles.map((p) => p.normalize('NFC')).sort().join('|');
      lastClipboardSignature = computeSignature('file', sigKey);
      return;
    }
    if (hasFilePasteboardIndicator()) {
      return;
    }
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      lastClipboardSignature = computeSignature('image', img.toDataURL());
      return;
    }
    const txt = clipboard.readText();
    if (txt) {
      lastClipboardSignature = computeSignature('text', txt.normalize('NFC'));
    }
  } catch {}
}

// Poll OS clipboard for new copies on Windows / macOS
async function pollSystemClipboard() {
  if (!config.autoSync) return;
  if (isPollingClipboard || isApplyingClipboard) return;

  // If TeamViewer overwrote the Mac clipboard with its broken /tmp/.CB... path, restore ClipSync's file immediately
  if (process.platform === 'darwin' && isTeamViewerOrTempClipboard()) {
    if (lastAppliedLocalPath && fs.existsSync(lastAppliedLocalPath)) {
      ignoreClipboardUntil = Date.now() + 2000;
      writeFileToNativeClipboard(lastAppliedLocalPath);
    }
    return;
  }

  if (Date.now() < ignoreClipboardUntil) return;

  isPollingClipboard = true;
  try {
    // 1. Check if files or folders were copied in Finder / Explorer
    const copiedFiles = readCopiedFilePathsFromOS();
    if (copiedFiles.length > 0) {
      const sigKey = copiedFiles.map((p) => p.normalize('NFC')).sort().join('|');
      const sig = computeSignature('file', sigKey);
      if (sig !== lastClipboardSignature) {
        let allSucceeded = true;
        for (const filePath of copiedFiles) {
          try {
            const res = await uploadFileToServer(filePath, true);
            if (res && res.item) {
              upsertCachedItem(res.item);
            } else {
              allSucceeded = false;
            }
          } catch {
            allSucceeded = false;
          }
        }
        if (allSucceeded) {
          lastClipboardSignature = sig;
        }
      }
      return;
    }

    // Never fall through to readImage()/readText() if the clipboard contains a Finder/Explorer file or folder
    // (Prevents macOS Finder's 1024x1024 PDF file icon from being uploaded as a screenshot image!)
    if (hasFilePasteboardIndicator()) {
      return;
    }

    // 2. Check if an image/screenshot is in clipboard
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const dataUrl = img.toDataURL();
      const sig = computeSignature('image', dataUrl);
      if (sig !== lastClipboardSignature) {
        const res = await apiRequest('POST', '/api/items', {
          syncKey: config.syncKey,
          type: 'image',
          text: `클립보드 이미지 (${img.getSize().width}×${img.getSize().height})`,
          imageDataUrl: dataUrl,
          sourceDevice: config.deviceName,
          sourcePlatform: process.platform,
          clientId: myClientId
        });
        if (res && res.ok) {
          lastClipboardSignature = sig;
          if (res.item) upsertCachedItem(res.item);
        }
      }
      return;
    }

    // 3. Check if text/URL is in clipboard
    const rawText = clipboard.readText();
    if (rawText && rawText.trim().length > 0) {
      const text = rawText.normalize('NFC');
      const sig = computeSignature('text', text);
      if (sig !== lastClipboardSignature) {
        const res = await apiRequest('POST', '/api/items', {
          syncKey: config.syncKey,
          type: 'text',
          text,
          sourceDevice: config.deviceName,
          sourcePlatform: process.platform,
          clientId: myClientId
        });
        if (res && res.ok) {
          lastClipboardSignature = sig;
          if (res.item) upsertCachedItem(res.item);
        }
      }
    }
  } catch (err) {
    // Silent poll error if server is temporarily unreachable
  } finally {
    isPollingClipboard = false;
  }
}

function sendStateToRenderer() {
  if (isQuitting) return;
  try {
    if (isWindowAlive() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('state:update', {
        isConnected,
        config,
        devices: connectedDevices,
        items: cachedItems,
        networkInfo,
        isDark: nativeTheme.shouldUseDarkColors,
        shortcutDisplay: formatShortcutForDisplay(config.shortcut)
      });
    }
  } catch {}
}

function upsertCachedItem(item) {
  if (!item || !item.id) return;
  cachedItems = [item, ...cachedItems.filter((i) => i.id !== item.id)];
  sendStateToRenderer();
}

async function refreshItemsFromServer() {
  try {
    const res = await apiRequest(
      'GET',
      `/api/items?syncKey=${encodeURIComponent(config.syncKey)}`,
      null,
      2500
    );
    if (res && res.ok && Array.isArray(res.items)) {
      cachedItems = res.items;
      if (Array.isArray(res.devices)) {
        connectedDevices = res.devices;
      }
      isConnected = true;
      sendStateToRenderer();
    }
  } catch {}
}

async function refreshNetworkInfo() {
  try {
    const info = await apiRequest('GET', '/api/network-info');
    if (info && info.ok) {
      networkInfo = info;
    }
  } catch {}
}

function connectWebSocket() {
  if (isQuitting) return;
  if (wsClient) {
    const oldWs = wsClient;
    wsClient = null;
    try {
      oldWs.removeAllListeners();
      oldWs.on('error', () => {});
      oldWs.close();
    } catch {}
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  try {
    const base = new URL(config.serverUrl);
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${base.host}/ws?syncKey=${encodeURIComponent(
      config.syncKey
    )}&deviceName=${encodeURIComponent(config.deviceName)}&platform=${encodeURIComponent(
      process.platform
    )}&clientId=${encodeURIComponent(myClientId)}`;

    const socket = new WebSocket(wsUrl);
    wsClient = socket;

    socket.on('open', async () => {
      if (isQuitting || wsClient !== socket) return;
      isConnected = true;
      await refreshNetworkInfo();
      await refreshItemsFromServer();
      sendStateToRenderer();
      updateTrayMenu();
    });

    socket.on('message', async (raw) => {
      if (isQuitting || wsClient !== socket) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'init') {
          cachedItems = msg.items || [];
          connectedDevices = msg.devices || [];
          isConnected = true;
          sendStateToRenderer();
        } else if (msg.event === 'presence:update') {
          connectedDevices = msg.devices || [];
          sendStateToRenderer();
          updateTrayMenu();
        } else if (msg.event === 'clipboard:new' && msg.item) {
          upsertCachedItem(msg.item);

          // If this clipboard item came from another device (or was activated from history),
          // automatically write it to our system clipboard!
          // On macOS, this also automatically feeds Apple Universal Clipboard (Handoff) for iPhone!
          if (config.autoSync && msg.originClientId !== myClientId) {
            await applyItemToSystemClipboard(msg.item);
          }
        } else if (msg.event === 'clipboard:updated' && msg.item) {
          cachedItems = cachedItems.map((i) => (i.id === msg.item.id ? msg.item : i));
          sendStateToRenderer();
        } else if (msg.event === 'clipboard:deleted') {
          cachedItems = cachedItems.filter((i) => i.id !== msg.id);
          sendStateToRenderer();
        } else if (msg.event === 'clipboard:cleared') {
          cachedItems = msg.items || [];
          sendStateToRenderer();
        }
      } catch (err) {
        console.error('WS message parse error:', err.message);
      }
    });

    socket.on('close', () => {
      if (isQuitting || wsClient !== socket) return;
      isConnected = false;
      sendStateToRenderer();
      updateTrayMenu();
      wsReconnectTimer = setTimeout(connectWebSocket, 2000);
    });

    socket.on('error', () => {
      if (wsClient === socket) {
        isConnected = false;
      }
    });
  } catch (err) {
    if (!isQuitting) {
      wsReconnectTimer = setTimeout(connectWebSocket, 2500);
    }
  }
}

let registeredShortcut = null;

function formatShortcutForDisplay(sc) {
  const raw = sc || config.shortcut || 'CommandOrControl+Shift+V';
  const isMac = process.platform === 'darwin';
  return raw
    .replace(/CommandOrControl/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/CmdOrCtrl/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/Option/gi, isMac ? '⌥' : 'Alt')
    .replace(/Shift/gi, isMac ? '⇧' : 'Shift')
    .replace(/\+/g, isMac ? ' ' : ' + ')
    .trim();
}

function applyThemeSetting(theme) {
  const chosen = ['system', 'dark', 'light'].includes(theme) ? theme : 'system';
  config.theme = chosen;
  nativeTheme.themeSource = chosen;
  if (isQuitting) return;
  try {
    if (isWindowAlive() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      const isDark = nativeTheme.shouldUseDarkColors;
      mainWindow.setBackgroundColor(isDark ? '#09090b' : '#f8fafc');
      mainWindow.webContents.send('theme:changed', {
        theme: chosen,
        isDark
      });
    }
  } catch {}
}

function applyShortcutSetting(newShortcut) {
  try {
    const sc = (newShortcut || 'CommandOrControl+Shift+V').trim();
    if (registeredShortcut) {
      try {
        globalShortcut.unregister(registeredShortcut);
      } catch {}
    }
    const success = globalShortcut.register(sc, () => {
      togglePopoverWindow();
    });
    if (success) {
      registeredShortcut = sc;
      config.shortcut = sc;
      saveConfig(config);
      return { ok: true, shortcut: sc, display: formatShortcutForDisplay(sc) };
    } else {
      if (registeredShortcut) {
        globalShortcut.register(registeredShortcut, () => togglePopoverWindow());
      }
      return {
        ok: false,
        error: '해당 단축키는 시스템에서 이미 사용 중이거나 등록할 수 없습니다.'
      };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function applyWindowPinState() {
  if (!isWindowAlive()) return;
  try {
    const pinned = Boolean(config.alwaysOnTop);
    if (process.platform === 'darwin') {
      if (pinned) {
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mainWindow.setAlwaysOnTop(true, 'floating');
      } else {
        mainWindow.setVisibleOnAllWorkspaces(false);
        mainWindow.setAlwaysOnTop(false);
      }
    } else {
      mainWindow.setAlwaysOnTop(pinned);
    }
  } catch {}
}

function createWindow() {
  if (isQuitting) return;
  const isDark = nativeTheme.shouldUseDarkColors;
  const { screen } = require('electron');
  const workArea = screen.getPrimaryDisplay().workArea;
  const targetHeight = Math.min(760, Math.max(650, workArea.height - 30));

  mainWindow = new BrowserWindow({
    width: 400,
    height: targetHeight,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    transparent: false,
    backgroundColor: isDark ? '#09090b' : '#f8fafc',
    alwaysOnTop: Boolean(config.alwaysOnTop),
    skipTaskbar: true,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  applyWindowPinState();
  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  mainWindow.on('show', () => {
    sendStateToRenderer();
    try {
      if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:shown');
      }
    } catch {}
    refreshItemsFromServer().catch(() => {});
  });

  mainWindow.on('focus', () => {
    sendStateToRenderer();
    try {
      if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:shown');
      }
    } catch {}
  });

  // Intercept Cmd+W / Alt+F4 so closing the popover hides it instead of destroying the BrowserWindow
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      try {
        mainWindow.hide();
      } catch {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('blur', () => {
    try {
      if (
        !isQuitting &&
        !config.alwaysOnTop &&
        !isFileDialogOpen &&
        isWindowAlive() &&
        mainWindow.isVisible()
      ) {
        mainWindow.hide();
      }
    } catch {}
  });
}

function togglePopoverWindow() {
  if (isQuitting) return;
  try {
    if (!isWindowAlive()) {
      createWindow();
    }
    if (isWindowAlive() && mainWindow.isVisible()) {
      mainWindow.hide();
      return;
    }
    showPopoverWindow();
  } catch {}
}

function showPopoverWindow() {
  if (isQuitting) return;
  try {
    if (!isWindowAlive()) {
      createWindow();
    }
    if (!isWindowAlive()) return;
    applyWindowPinState();
    const trayBounds = tray && !tray.isDestroyed() ? tray.getBounds() : null;
    const winBounds = mainWindow.getBounds();
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;

    if (trayBounds && trayBounds.width > 0) {
      let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
      let y =
        process.platform === 'darwin'
          ? Math.round(trayBounds.y + trayBounds.height + 6)
          : Math.round(trayBounds.y - winBounds.height - 6);

      // Clamp to workArea
      x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - winBounds.width - 8));
      y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - winBounds.height - 8));
      mainWindow.setPosition(x, y, false);
    } else {
      mainWindow.center();
    }

    mainWindow.show();
    mainWindow.focus();
    sendStateToRenderer();
    try {
      if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:shown');
      }
    } catch {}
    refreshItemsFromServer().then(() => sendStateToRenderer()).catch(() => {});
  } catch {}
}

function performQuit() {
  if (isQuitting) return;
  isQuitting = true;
  try {
    if (clipboardPollTimer) {
      clearInterval(clipboardPollTimer);
      clipboardPollTimer = null;
    }
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (wsClient) {
      const oldWs = wsClient;
      wsClient = null;
      try {
        oldWs.removeAllListeners();
        oldWs.on('error', () => {});
        oldWs.close();
      } catch {}
    }
    try {
      globalShortcut.unregisterAll();
    } catch {}
    if (tray && !tray.isDestroyed()) {
      try {
        tray.removeAllListeners();
        tray.destroy();
      } catch {}
      tray = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.removeAllListeners();
        mainWindow.destroy();
      } catch {}
      mainWindow = null;
    }
  } catch {}
  try {
    app.quit();
  } catch {}
  setTimeout(() => {
    app.exit(0);
  }, 80);
}

function updateTrayMenu() {
  if (isQuitting || !tray || tray.isDestroyed()) return;
  try {
    const statusLabel = isConnected
      ? `상태: 동기화 활성 (연결 기기 ${connectedDevices.length}대)`
      : '상태: 서버 연결 대기 중';
    const shortcutLabel = formatShortcutForDisplay(config.shortcut);

    currentContextMenu = Menu.buildFromTemplate([
      { label: 'ClipSync', enabled: false },
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      {
        label: `클립보드 히스토리 열기${shortcutLabel ? ` (${shortcutLabel})` : ''}`,
        click: () => showPopoverWindow()
      },
      {
        label: '실시간 클립보드 동기화',
        type: 'checkbox',
        checked: Boolean(config.autoSync),
        click: (menuItem) => {
          config.autoSync = menuItem.checked;
          saveConfig(config);
          sendStateToRenderer();
        }
      },
      {
        label: '시스템 로그인 시 자동 실행',
        type: 'checkbox',
        checked: Boolean(config.autoLaunch),
        click: (menuItem) => {
          config.autoLaunch = menuItem.checked;
          saveConfig(config);
          applyAutoLaunchSetting(config.autoLaunch);
          sendStateToRenderer();
        }
      },
      {
        label: '수신 파일 폴더 열기',
        click: () => shell.openPath(DOWNLOAD_DIR)
      },
      { type: 'separator' },
      {
        label: 'ClipSync 종료',
        click: () => performQuit()
      }
    ]);

    tray.setToolTip(`ClipSync — ${statusLabel}`);
  } catch {}
}

// ================= IPC HANDLERS FOR RENDERER =================

ipcMain.handle('state:get', async () => {
  refreshNetworkInfo().catch(() => {});
  await refreshItemsFromServer().catch(() => {});
  const targetIosUrl = `${
    networkInfo && networkInfo.localUrl ? networkInfo.localUrl : config.serverUrl
  }/?syncKey=${encodeURIComponent(config.syncKey)}`;
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(targetIosUrl, {
      margin: 1,
      width: 200,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
  } catch {}

  return {
    isConnected,
    config,
    devices: connectedDevices,
    items: cachedItems,
    networkInfo,
    iosUrl: targetIosUrl,
    qrDataUrl,
    downloadDir: DOWNLOAD_DIR,
    appInfo: {
      name: 'ClipSync',
      version: app.getVersion(),
      build: BUILD_NUMBER,
      buildNumber: BUILD_NUMBER,
      platform: process.platform,
      platformLabel: process.platform === 'darwin' ? 'macOS (arm64)' : 'Windows (x64)'
    },
    isDark: nativeTheme.shouldUseDarkColors,
    shortcutDisplay: formatShortcutForDisplay(config.shortcut)
  };
});

// User clicked an item in the tray history list -> load into OS clipboard + broadcast to room
ipcMain.handle('clipboard:activate-item', async (_event, itemId) => {
  const item = cachedItems.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: 'Item not found' };

  const localRes = await applyItemToSystemClipboard(item);
  try {
    const res = await apiRequest('POST', `/api/items/${encodeURIComponent(itemId)}/activate`, {
      syncKey: config.syncKey,
      clientId: myClientId
    });
    if (res && res.item) {
      upsertCachedItem(res.item);
    }
  } catch {}
  return { ok: true, ...localRes };
});

ipcMain.handle('clipboard:pin-item', async (_event, itemId) => {
  const res = await apiRequest('PATCH', `/api/items/${encodeURIComponent(itemId)}/pin`, {
    syncKey: config.syncKey
  });
  if (res && res.item) {
    cachedItems = cachedItems.map((i) => (i.id === res.item.id ? res.item : i));
    sendStateToRenderer();
  }
  return res;
});

ipcMain.handle('clipboard:delete-item', async (_event, itemId) => {
  lastClipboardSignature = '';
  cachedItems = cachedItems.filter((i) => i.id !== itemId);
  sendStateToRenderer();
  return apiRequest(
    'DELETE',
    `/api/items/${encodeURIComponent(itemId)}?syncKey=${encodeURIComponent(config.syncKey)}`
  );
});

ipcMain.handle('clipboard:clear-all', async () => {
  lastClipboardSignature = '';
  cachedItems = cachedItems.filter((i) => i.pinned);
  sendStateToRenderer();
  const res = await apiRequest(
    'DELETE',
    `/api/items?syncKey=${encodeURIComponent(config.syncKey)}`
  );
  if (res && Array.isArray(res.items)) {
    cachedItems = res.items;
    sendStateToRenderer();
  }
  return res;
});

ipcMain.handle('clipboard:upload-file-dialog', async () => {
  const parentWin = isWindowAlive() ? mainWindow : undefined;
  isFileDialogOpen = true;
  try {
    const res = await dialog.showOpenDialog(parentWin, {
      title: '클립보드로 공유할 파일 또는 이미지 선택',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const uploaded = [];
    for (const fp of res.filePaths) {
      const r = await uploadFileToServer(fp, false);
      if (r && r.item) {
        upsertCachedItem(r.item);
      }
      uploaded.push(r);
    }
    return { ok: true, uploaded };
  } finally {
    isFileDialogOpen = false;
  }
});

ipcMain.handle('clipboard:upload-dropped-files', async (_event, filePaths) => {
  if (!Array.isArray(filePaths)) return { ok: false };
  const uploaded = [];
  for (const fp of filePaths) {
    if (fp && fs.existsSync(fp)) {
      const r = await uploadFileToServer(fp, false);
      if (r && r.item) {
        upsertCachedItem(r.item);
      }
      uploaded.push(r);
    }
  }
  return { ok: true, uploaded };
});

ipcMain.handle('clipboard:save-file', async (_event, itemId) => {
  const item = cachedItems.find((i) => i.id === itemId);
  if (!item || !item.downloadUrl) return { ok: false };
  const localPath = await downloadRemoteFile(item.downloadUrl, item.fileName);
  shell.showItemInFolder(localPath);
  return { ok: true, localPath };
});

ipcMain.handle('config:update', async (_event, partial) => {
  let shortcutResult = { ok: true };
  const needsWsReconnect =
    (partial.serverUrl && partial.serverUrl !== config.serverUrl) ||
    (partial.syncKey && partial.syncKey !== config.syncKey) ||
    (partial.deviceName && partial.deviceName !== config.deviceName);

  if (partial.theme) {
    applyThemeSetting(partial.theme);
  }
  if (partial.shortcut && partial.shortcut !== config.shortcut) {
    shortcutResult = applyShortcutSetting(partial.shortcut);
  }
  config = { ...config, ...partial };
  saveConfig(config);
  if (typeof partial.autoLaunch === 'boolean') {
    applyAutoLaunchSetting(config.autoLaunch);
  }
  if (typeof partial.alwaysOnTop === 'boolean') {
    applyWindowPinState();
  }
  if (needsWsReconnect) {
    ensureLocalRelayServer();
    connectWebSocket();
  }
  updateTrayMenu();
  sendStateToRenderer();
  return {
    ok: true,
    config,
    shortcutResult,
    isDark: nativeTheme.shouldUseDarkColors,
    shortcutDisplay: formatShortcutForDisplay(config.shortcut)
  };
});

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('shell:open-downloads', async () => {
  await shell.openPath(DOWNLOAD_DIR);
});

ipcMain.handle('window:hide', () => {
  try {
    if (isWindowAlive()) mainWindow.hide();
  } catch {}
});

ipcMain.handle('app:quit', () => {
  performQuit();
});

// ================= APP LIFECYCLE =================

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', (e) => {
  if (!isQuitting) {
    e.preventDefault();
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'build/icon.png'));
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
      }
    } catch {}
    app.dock.hide();
  }

  applyThemeSetting(config.theme || 'system');
  nativeTheme.on('updated', () => {
    if (isQuitting) return;
    if (!config.theme || config.theme === 'system') {
      applyThemeSetting('system');
    }
    sendStateToRenderer();
  });

  applyAutoLaunchSetting(config.autoLaunch);
  ensureLocalRelayServer();
  seedInitialClipboardSignature();

  tray = new Tray(createTrayIcon());
  tray.on('click', () => {
    if (!isQuitting) {
      togglePopoverWindow();
    }
  });
  tray.on('right-click', () => {
    if (!isQuitting && currentContextMenu && tray && !tray.isDestroyed()) {
      tray.popUpContextMenu(currentContextMenu);
    }
  });

  createWindow();
  updateTrayMenu();

  // Connect to Relay Server (give embedded server 400ms if just started)
  setTimeout(() => {
    if (!isQuitting) connectWebSocket();
  }, 400);

  // Start clipboard watcher loop
  clipboardPollTimer = setInterval(pollSystemClipboard, 650);

  // Register global shortcut
  applyShortcutSetting(config.shortcut || 'CommandOrControl+Shift+V');

  // Only show popover on manual launch (stay hidden in tray if auto-started on login)
  const loginSettings = app.isPackaged ? app.getLoginItemSettings() : {};
  const launchedHidden =
    process.argv.includes('--hidden') ||
    Boolean(loginSettings.wasOpenedAtLogin) ||
    Boolean(loginSettings.wasOpenedAsHidden);

  if (!launchedHidden) {
    setTimeout(() => {
      if (!isQuitting) showPopoverWindow();
    }, 700);
  }
});

app.on('will-quit', () => {
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch {}
});
