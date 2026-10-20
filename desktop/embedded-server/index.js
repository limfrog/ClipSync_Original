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

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cors = require('cors');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4580;
const BASE_STORAGE_DIR = process.env.CLIPSYNC_DATA_DIR || __dirname;
const DATA_DIR = path.join(BASE_STORAGE_DIR, 'data');
const UPLOADS_DIR = path.join(BASE_STORAGE_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_ITEMS_PER_ROOM = 100;
const MAX_ROOMS = 5000;

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Null-prototype map to prevent prototype pollution (__proto__, constructor, toString, etc.)
let roomsHistory = Object.create(null);
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) {
          roomsHistory[k] = v;
        }
      }
    }
  }
} catch (err) {
  console.error('Failed to read history.json, starting fresh:', err.message);
  roomsHistory = Object.create(null);
}

// Convert user-provided syncKey into an isolated, collision-free internal room ID
function normalizeSyncKey(rawKey) {
  const cleaned = String(rawKey || 'default').trim();
  return cleaned || 'default';
}

function getRoomId(syncKey) {
  const norm = normalizeSyncKey(syncKey).toUpperCase();
  const digest = crypto.createHash('sha256').update(`clipsync-room:${norm}`).digest('hex');
  return `room_${digest.slice(0, 32)}`;
}

function getRoomToken(roomId) {
  return crypto.createHash('sha256').update(`token:${roomId}`).digest('hex').slice(0, 16);
}

// Atomic & debounced history writer to prevent multi-user write race conditions or file corruption
let saveTimer = null;
function flushHistorySync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const tmpFile = `${HISTORY_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(roomsHistory, null, 2), 'utf-8');
    fs.renameSync(tmpFile, HISTORY_FILE);
  } catch (err) {
    console.error('Failed to save history.json atomically:', err.message);
  }
}

function saveHistory() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushHistorySync();
  }, 120);
}

process.on('exit', () => {
  if (saveTimer) flushHistorySync();
});

function getRoomItems(syncKey) {
  const roomId = getRoomId(syncKey);
  if (!Object.prototype.hasOwnProperty.call(roomsHistory, roomId)) {
    // Prevent unbounded room growth if abused
    const roomKeys = Object.keys(roomsHistory);
    if (roomKeys.length >= MAX_ROOMS) {
      const oldestRoom = roomKeys[0];
      const evictedItems = roomsHistory[oldestRoom] || [];
      delete roomsHistory[oldestRoom];
      evictedItems.forEach((it) => cleanupFileIfUnused(it.fileId));
    }
    roomsHistory[roomId] = [];
  }
  return roomsHistory[roomId];
}

// Delete uploaded file from disk if no clipboard item across any room references it anymore
function cleanupFileIfUnused(fileId) {
  if (!fileId) return;
  const safeId = path.basename(fileId);
  for (const items of Object.values(roomsHistory)) {
    if (Array.isArray(items) && items.some((i) => i.fileId === safeId)) {
      return; // Still referenced
    }
  }
  const filePath = path.join(UPLOADS_DIR, safeId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Failed to delete unused file:', err.message);
  }
}

function computeHash(type, content) {
  return crypto
    .createHash('sha256')
    .update(`${type}:${content || ''}`)
    .digest('hex')
    .slice(0, 24);
}

function isUrlString(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (/\s/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function addOrPromoteItem(syncKey, itemPayload) {
  const roomId = getRoomId(syncKey);
  const list = getRoomItems(syncKey);

  const hash =
    itemPayload.hash ||
    computeHash(
      itemPayload.type,
      itemPayload.text || itemPayload.imageDataUrl || itemPayload.fileId || ''
    );

  // Check if an identical item already exists in this room
  const existingIdx = list.findIndex((it) => it.hash === hash);
  const now = new Date().toISOString();

  if (existingIdx !== -1) {
    const existing = list[existingIdx];
    const oldFileId = existing.fileId;
    existing.updatedAt = now;
    existing.sourceDevice = itemPayload.sourceDevice || existing.sourceDevice;
    existing.sourcePlatform = itemPayload.sourcePlatform || existing.sourcePlatform;
    if (itemPayload.fileId) {
      existing.type = itemPayload.type || existing.type;
      existing.fileId = itemPayload.fileId;
      existing.fileName = itemPayload.fileName || existing.fileName;
      existing.text = itemPayload.text || existing.fileName || existing.text;
      existing.fileSize = itemPayload.fileSize ?? existing.fileSize;
      existing.mimeType = itemPayload.mimeType || existing.mimeType;
      existing.downloadUrl = itemPayload.downloadUrl || existing.downloadUrl;
      existing.imageDataUrl = itemPayload.imageDataUrl ?? existing.imageDataUrl;
    }
    list.splice(existingIdx, 1);
    list.unshift(existing);
    if (oldFileId && itemPayload.fileId && oldFileId !== itemPayload.fileId) {
      cleanupFileIfUnused(oldFileId);
    }
    saveHistory();
    return { item: existing, isDuplicate: true };
  }

  const newItem = {
    id: crypto.randomUUID(),
    roomId,
    hash,
    type: itemPayload.type, // 'text' | 'url' | 'image' | 'file'
    text: itemPayload.text || '',
    isUrl: itemPayload.type === 'url' || isUrlString(itemPayload.text),
    imageDataUrl: itemPayload.imageDataUrl || null,
    fileId: itemPayload.fileId || null,
    fileName: itemPayload.fileName || null,
    fileSize: itemPayload.fileSize || null,
    mimeType: itemPayload.mimeType || null,
    downloadUrl: itemPayload.downloadUrl || null,
    sourceDevice: itemPayload.sourceDevice || 'Unknown Device',
    sourcePlatform: itemPayload.sourcePlatform || 'unknown',
    pinned: Boolean(itemPayload.pinned),
    createdAt: now,
    updatedAt: now
  };

  if (newItem.isUrl && newItem.type === 'text') {
    newItem.type = 'url';
  }

  list.unshift(newItem);

  // Trim unpinned items if exceeding MAX_ITEMS_PER_ROOM and clean up evicted files
  if (list.length > MAX_ITEMS_PER_ROOM) {
    const pinned = list.filter((i) => i.pinned);
    const unpinned = list.filter((i) => !i.pinned);
    const keepCount = Math.max(10, MAX_ITEMS_PER_ROOM - pinned.length);
    const keptUnpinned = unpinned.slice(0, keepCount);
    const evictedUnpinned = unpinned.slice(keepCount);

    roomsHistory[roomId] = [...pinned, ...keptUnpinned].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    evictedUnpinned.forEach((evicted) => cleanupFileIfUnused(evicted.fileId));
  }

  saveHistory();
  return { item: newItem, isDuplicate: false };
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '25mb' }));

// Safely decode Korean filenames across macOS (NFD/UTF-8) and Windows (NFC/CP949/UTF-8)
function decodeRawOriginalName(rawName) {
  if (!rawName) return 'file';
  let str = String(rawName);
  try {
    // Check if string consists only of Latin-1 byte values (0x00..0xFF) with high bytes present
    let hasHighLatin1 = false;
    let hasAbove255 = false;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 0xff) hasAbove255 = true;
      else if (code >= 0x80) hasHighLatin1 = true;
    }
    if (hasHighLatin1 && !hasAbove255) {
      const rawBuf = Buffer.from(str, 'latin1');
      try {
        str = new TextDecoder('utf-8', { fatal: true }).decode(rawBuf);
      } catch {
        str = new TextDecoder('euc-kr').decode(rawBuf);
      }
    }
  } catch {}
  try {
    if (/%[0-9A-Fa-f]{2}/.test(str)) {
      str = decodeURIComponent(str);
    }
  } catch {}
  return str.normalize('NFC');
}

function resolveUploadedFileName(req, file) {
  const encodedHeaderOrField =
    (req.body && req.body.fileNameEncoded) ||
    (req.query && req.query.fileNameEncoded) ||
    req.headers['x-file-name-encoded'];

  if (encodedHeaderOrField) {
    try {
      return decodeURIComponent(String(encodedHeaderOrField)).normalize('NFC');
    } catch {}
  }
  return decodeRawOriginalName(file && file.originalname);
}

// Automatically convert CP949/EUC-KR or NFD text/CSV files to NFC UTF-8 so both Mac and Windows open them without garbled Korean
function normalizeTextFileIfNeeded(filePath, fileName) {
  try {
    const ext = path.extname(fileName || '').toLowerCase();
    const textExts = new Set(['.txt', '.csv', '.log', '.md', '.srt', '.smi']);
    if (!textExts.has(ext)) return;

    const stat = fs.statSync(filePath);
    if (stat.size === 0 || stat.size > 20 * 1024 * 1024) return;

    const buf = fs.readFileSync(filePath);
    // Skip if file contains null bytes (UTF-16 or binary)
    if (buf.includes(0x00)) return;

    let decodedText = null;
    let wasCp949 = false;
    try {
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      // Not valid UTF-8 -> try Windows CP949 / EUC-KR
      try {
        decodedText = new TextDecoder('euc-kr', { fatal: true }).decode(buf);
        wasCp949 = true;
      } catch {
        return;
      }
    }

    if (decodedText !== null) {
      // Strip existing BOM if present, normalize NFD -> NFC
      const cleanText = decodedText.replace(/^\uFEFF/, '').normalize('NFC');
      // Add UTF-8 BOM for .csv or converted CP949 .txt so Windows Excel/Notepad & macOS both read UTF-8 cleanly
      const needsBom = ext === '.csv' || wasCp949 || buf[0] === 0xef;
      const finalContent = (needsBom ? '\uFEFF' : '') + cleanText;
      fs.writeFileSync(filePath, Buffer.from(finalContent, 'utf-8'));
    }
  } catch (err) {
    console.error('Text file encoding normalization skipped:', err.message);
  }
}

// Configure multer for file & binary uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const fileId = crypto.randomUUID();
    const safeOriginal = resolveUploadedFileName(req, file);
    const ext = path.extname(safeOriginal);
    cb(null, `${fileId}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected WebSocket clients: Map<WebSocket, { roomId, syncKey, deviceName, platform, clientId }>
const clients = new Map();

function broadcastToRoom(syncKey, messageObj, excludeClientId = null) {
  const targetRoomId = getRoomId(syncKey);
  const payload = JSON.stringify(messageObj);
  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState === 1 && meta.roomId === targetRoomId) {
      if (excludeClientId && meta.clientId === excludeClientId) continue;
      ws.send(payload);
    }
  }
}

function getRoomConnectedDevices(syncKey) {
  const targetRoomId = getRoomId(syncKey);
  const devices = [];
  for (const [, meta] of clients.entries()) {
    if (meta.roomId === targetRoomId) {
      devices.push({
        clientId: meta.clientId,
        deviceName: meta.deviceName,
        platform: meta.platform,
        connectedAt: meta.connectedAt
      });
    }
  }
  return devices;
}

function broadcastPresence(syncKey) {
  const devices = getRoomConnectedDevices(syncKey);
  broadcastToRoom(syncKey, {
    event: 'presence:update',
    devices
  });
}

wss.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const syncKey = normalizeSyncKey(reqUrl.searchParams.get('syncKey'));
  const roomId = getRoomId(syncKey);
  const deviceName = (reqUrl.searchParams.get('deviceName') || 'Unknown Device').slice(0, 80);
  const platform = (reqUrl.searchParams.get('platform') || 'unknown').slice(0, 20);
  const clientId = reqUrl.searchParams.get('clientId') || crypto.randomUUID();

  clients.set(ws, {
    roomId,
    syncKey,
    deviceName,
    platform,
    clientId,
    connectedAt: new Date().toISOString()
  });

  // Send initial history & presence isolated to this room
  ws.send(
    JSON.stringify({
      event: 'init',
      clientId,
      syncKey,
      items: getRoomItems(syncKey),
      devices: getRoomConnectedDevices(syncKey)
    })
  );

  broadcastPresence(syncKey);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const meta = clients.get(ws);
      if (!meta) return;

      if (msg.event === 'clipboard:push' && msg.item) {
        const { item } = addOrPromoteItem(meta.syncKey, {
          ...msg.item,
          sourceDevice: msg.item.sourceDevice || meta.deviceName,
          sourcePlatform: msg.item.sourcePlatform || meta.platform
        });
        broadcastToRoom(meta.syncKey, {
          event: 'clipboard:new',
          item,
          originClientId: meta.clientId
        });
      } else if (msg.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta) {
      broadcastPresence(meta.syncKey);
    }
  });
});

// ================= REST API ENDPOINTS =================

// Health & network info
app.get('/api/network-info', (_req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
  res.json({
    ok: true,
    port: PORT,
    hostname: os.hostname(),
    primaryIp,
    localUrl: `http://${primaryIp}:${PORT}`,
    ips
  });
});

// List clipboard history for a syncKey room
app.get('/api/items', (req, res) => {
  const syncKey = normalizeSyncKey(req.query.syncKey || req.headers['x-sync-key']);
  const typeFilter = (req.query.type || 'all').toString();
  const query = (req.query.q || '').toString().toLowerCase().trim();

  let items = getRoomItems(syncKey);
  if (typeFilter && typeFilter !== 'all') {
    if (typeFilter === 'text') {
      items = items.filter((i) => i.type === 'text' || i.type === 'url');
    } else {
      items = items.filter((i) => i.type === typeFilter);
    }
  }
  if (query) {
    items = items.filter(
      (i) =>
        (i.text && i.text.toLowerCase().includes(query)) ||
        (i.fileName && i.fileName.toLowerCase().includes(query)) ||
        (i.sourceDevice && i.sourceDevice.toLowerCase().includes(query))
    );
  }

  res.json({
    ok: true,
    syncKey,
    devices: getRoomConnectedDevices(syncKey),
    items
  });
});

// Create / push a new clipboard item (text, url, or base64 image)
app.post('/api/items', (req, res) => {
  const syncKey = normalizeSyncKey(
    req.body.syncKey || req.query.syncKey || req.headers['x-sync-key']
  );

  const { type = 'text', text = '', imageDataUrl = null, sourceDevice, sourcePlatform, clientId } =
    req.body || {};

  if (type === 'image' && !imageDataUrl) {
    return res.status(400).json({ ok: false, error: 'Missing imageDataUrl for image item' });
  }
  if ((type === 'text' || type === 'url') && !String(text).trim()) {
    return res.status(400).json({ ok: false, error: 'Empty text content' });
  }

  const normalizedText = String(text).normalize('NFC');
  const { item, isDuplicate } = addOrPromoteItem(syncKey, {
    type,
    text: normalizedText,
    imageDataUrl,
    sourceDevice: sourceDevice || 'API Client',
    sourcePlatform: sourcePlatform || 'web'
  });

  broadcastToRoom(syncKey, {
    event: 'clipboard:new',
    item,
    originClientId: clientId || null
  });

  res.json({ ok: true, item, isDuplicate });
});

// Upload a file or image file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded' });
  }

  const syncKey = normalizeSyncKey(
    req.body.syncKey || req.query.syncKey || req.headers['x-sync-key']
  );
  const roomId = getRoomId(syncKey);
  const roomToken = getRoomToken(roomId);

  const originalName = resolveUploadedFileName(req, req.file);
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const storedFileName = req.file.filename;

  // Normalize text/CSV files (CP949/EUC-KR or macOS NFD -> NFC UTF-8)
  normalizeTextFileIfNeeded(req.file.path, originalName);
  const finalSize = fs.statSync(req.file.path).size;

  const downloadUrl = `/api/files/${encodeURIComponent(storedFileName)}/${encodeURIComponent(
    originalName
  )}?roomToken=${encodeURIComponent(roomToken)}`;

  // Check if user wants this treated as an inline clipboard image or file
  const isImageMime = mimeType.startsWith('image/') && finalSize <= 15 * 1024 * 1024;
  const isImage = req.body.asImage === 'true' || (isImageMime && req.body.asFile !== 'true');

  let imageDataUrl = null;
  if (isImage || isImageMime) {
    const fileBuf = fs.readFileSync(req.file.path);
    imageDataUrl = `data:${mimeType};base64,${fileBuf.toString('base64')}`;
  }

  const fileHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(req.file.path))
    .digest('hex')
    .slice(0, 24);

  const { item } = addOrPromoteItem(syncKey, {
    type: isImage ? 'image' : 'file',
    hash: fileHash,
    text: originalName,
    imageDataUrl,
    fileId: storedFileName,
    fileName: originalName,
    fileSize: finalSize,
    mimeType,
    downloadUrl,
    sourceDevice: req.body.sourceDevice || 'File Upload',
    sourcePlatform: req.body.sourcePlatform || 'web'
  });

  broadcastToRoom(syncKey, {
    event: 'clipboard:new',
    item,
    originClientId: req.body.clientId || null
  });

  res.json({ ok: true, item });
});

// Download stored file (with room ownership verification & UTF-8 RFC 5987 filename header)
app.get('/api/files/:fileId/:fileName?', (req, res) => {
  const safeFileId = path.basename(req.params.fileId);
  const filePath = path.join(UPLOADS_DIR, safeFileId);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  // Verify room access via roomToken or syncKey
  const providedToken = req.query.roomToken ? String(req.query.roomToken) : null;
  const providedSyncKey = req.query.syncKey || req.headers['x-sync-key'];

  let authorized = false;
  let matchedItem = null;
  if (providedSyncKey) {
    const items = getRoomItems(providedSyncKey);
    matchedItem = items.find((i) => i.fileId === safeFileId) || null;
    if (matchedItem) {
      authorized = true;
    }
  }
  if (!authorized && providedToken) {
    for (const [rId, items] of Object.entries(roomsHistory)) {
      if (getRoomToken(rId) === providedToken) {
        matchedItem = items.find((i) => i.fileId === safeFileId) || null;
        if (matchedItem) {
          authorized = true;
          break;
        }
      }
    }
  }

  if (!authorized) {
    return res.status(403).json({ ok: false, error: 'Unauthorized room access for this file' });
  }

  const rawDownloadName =
    (matchedItem && matchedItem.fileName) ||
    decodeRawOriginalName(req.params.fileName || safeFileId);
  const downloadName = rawDownloadName.normalize('NFC');
  const encodedName = encodeURIComponent(downloadName);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
  );
  res.sendFile(filePath);
});

// Activate / promote an existing history item and sync to all devices' active clipboard
app.post('/api/items/:id/activate', (req, res) => {
  const syncKey = normalizeSyncKey(
    req.body.syncKey || req.query.syncKey || req.headers['x-sync-key']
  );
  const list = getRoomItems(syncKey);
  const idx = list.findIndex((i) => i.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'Item not found' });
  }
  const item = list[idx];
  item.updatedAt = new Date().toISOString();
  list.splice(idx, 1);
  list.unshift(item);
  saveHistory();

  broadcastToRoom(syncKey, {
    event: 'clipboard:new',
    item,
    originClientId: req.body.clientId || null,
    activatedFromHistory: true
  });

  res.json({ ok: true, item });
});

// Toggle pin on an item
app.patch('/api/items/:id/pin', (req, res) => {
  const syncKey = normalizeSyncKey(
    req.body.syncKey || req.query.syncKey || req.headers['x-sync-key']
  );
  const list = getRoomItems(syncKey);
  const item = list.find((i) => i.id === req.params.id);
  if (!item) {
    return res.status(404).json({ ok: false, error: 'Item not found' });
  }
  item.pinned = typeof req.body.pinned === 'boolean' ? req.body.pinned : !item.pinned;
  saveHistory();

  broadcastToRoom(syncKey, {
    event: 'clipboard:updated',
    item
  });

  res.json({ ok: true, item });
});

// Delete a single item (and clean up its uploaded file on disk)
app.delete('/api/items/:id', (req, res) => {
  const syncKey = normalizeSyncKey(req.query.syncKey || req.headers['x-sync-key']);
  const list = getRoomItems(syncKey);
  const idx = list.findIndex((i) => i.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'Item not found' });
  }
  const [removed] = list.splice(idx, 1);
  cleanupFileIfUnused(removed.fileId);
  saveHistory();

  broadcastToRoom(syncKey, {
    event: 'clipboard:deleted',
    id: removed.id
  });

  res.json({ ok: true, id: removed.id });
});

// Clear unpinned items in room (and clean up their uploaded files on disk)
app.delete('/api/items', (req, res) => {
  const syncKey = normalizeSyncKey(req.query.syncKey || req.headers['x-sync-key']);
  const roomId = getRoomId(syncKey);
  const list = getRoomItems(syncKey);
  const unpinned = list.filter((i) => !i.pinned);
  roomsHistory[roomId] = list.filter((i) => i.pinned);
  unpinned.forEach((removed) => cleanupFileIfUnused(removed.fileId));
  saveHistory();

  broadcastToRoom(syncKey, {
    event: 'clipboard:cleared',
    items: roomsHistory[roomId]
  });

  res.json({ ok: true, items: roomsHistory[roomId] });
});

// ================= iOS SHORTCUTS & COMPANION ENDPOINTS =================

// GET /api/ios/latest - Designed for 1-step Apple Shortcuts ("Get Contents of URL" -> "Copy to Clipboard")
app.get('/api/ios/latest', (req, res) => {
  const syncKey = normalizeSyncKey(req.query.syncKey || req.headers['x-sync-key']);
  const format = (req.query.format || 'raw').toString(); // 'raw' | 'json'
  const list = getRoomItems(syncKey);

  if (list.length === 0) {
    if (format === 'json') {
      return res.json({ ok: false, empty: true });
    }
    return res.status(200).type('text/plain; charset=utf-8').send('');
  }

  const latest = list[0];
  if (format === 'json') {
    return res.json({ ok: true, item: latest });
  }

  if (latest.type === 'image' && latest.imageDataUrl) {
    const matches = latest.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', 'inline; filename="clipboard.png"');
      return res.send(buffer);
    }
  }

  if (latest.type === 'file' && latest.fileId) {
    const filePath = path.join(UPLOADS_DIR, path.basename(latest.fileId));
    if (fs.existsSync(filePath)) {
      return res.download(filePath, latest.fileName || 'file');
    }
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(latest.text || '');
});

// POST /api/ios/push - Designed for 1-step Apple Shortcuts from iPhone ("Get Clipboard" -> "Get Contents of URL (POST)")
app.post('/api/ios/push', upload.single('file'), (req, res) => {
  const syncKey = normalizeSyncKey(
    req.query.syncKey || (req.body && req.body.syncKey) || req.headers['x-sync-key']
  );
  const roomId = getRoomId(syncKey);
  const roomToken = getRoomToken(roomId);

  if (req.file) {
    const originalName = resolveUploadedFileName(req, req.file);
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const storedFileName = req.file.filename;
    normalizeTextFileIfNeeded(req.file.path, originalName);
    const finalSize = fs.statSync(req.file.path).size;
    const downloadUrl = `/api/files/${encodeURIComponent(storedFileName)}/${encodeURIComponent(
      originalName
    )}?roomToken=${encodeURIComponent(roomToken)}`;
    const isImage = mimeType.startsWith('image/');
    let imageDataUrl = null;
    if (isImage && finalSize <= 15 * 1024 * 1024) {
      imageDataUrl = `data:${mimeType};base64,${fs.readFileSync(req.file.path).toString('base64')}`;
    }
    const { item } = addOrPromoteItem(syncKey, {
      type: isImage ? 'image' : 'file',
      text: originalName,
      imageDataUrl,
      fileId: storedFileName,
      fileName: originalName,
      fileSize: finalSize,
      mimeType,
      downloadUrl,
      sourceDevice: req.query.device || 'iPhone',
      sourcePlatform: 'ios'
    });
    broadcastToRoom(syncKey, { event: 'clipboard:new', item });
    return res.json({ ok: true, item });
  }

  const textContent =
    typeof req.body === 'string'
      ? req.body
      : req.body && (req.body.text || req.body.content || req.body.clipboard || '');

  if (!String(textContent).trim()) {
    return res.status(400).json({ ok: false, error: 'Empty clipboard content from iOS' });
  }

  const normText = String(textContent).normalize('NFC');
  const { item } = addOrPromoteItem(syncKey, {
    type: isUrlString(normText) ? 'url' : 'text',
    text: normText,
    sourceDevice: req.query.device || (req.body && req.body.sourceDevice) || 'iPhone',
    sourcePlatform: 'ios'
  });

  broadcastToRoom(syncKey, { event: 'clipboard:new', item });
  return res.json({ ok: true, item });
});

// Serve static iOS Web App / PWA
app.use(express.static(PUBLIC_DIR));

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use by an active relay instance.`);
  } else {
    console.error('Relay server error:', err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
  console.log(`====================================================`);
  console.log(`🚀 ClipSync Relay Server running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${primaryIp}:${PORT}`);
  console.log(`   iOS PWA: http://${primaryIp}:${PORT}`);
  console.log(`====================================================`);
});
