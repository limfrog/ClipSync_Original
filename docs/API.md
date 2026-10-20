# ClipSync REST & WebSocket API Specification

ClipSync provides a real-time bi-directional synchronization bridge between Desktop apps (macOS, Windows, Linux), Mobile devices (iOS, Android), and Web browsers. All clipboard data and file transfers are room-isolated using a 12-character `syncKey` (e.g. `CS-XXXX-XXXX`).

---

## 1. Authentication & Room Isolation

Rooms are isolated using a SHA-256 hash derived from the user's `syncKey`:
```
roomId = "room_" + sha256("clipsync-room:" + syncKey.toUpperCase())[0..32]
roomToken = sha256("token:" + roomId)[0..16]
```
Clients must provide their `syncKey` in either:
1. URL Query parameter: `?syncKey=CS-XXXX-XXXX`
2. HTTP Header: `x-sync-key: CS-XXXX-XXXX`
3. JSON Body: `{"syncKey": "CS-XXXX-XXXX", ...}`

---

## 2. REST API Endpoints

### 2.1 System & Network Info
- **Endpoint**: `GET /api/network-info`
- **Description**: Returns server status, port, primary local IP, and available network interfaces. Useful for QR code generation and mobile pairing.
- **Response**:
```json
{
  "ok": true,
  "port": 4580,
  "hostname": "MacBook-Pro.local",
  "primaryIp": "192.168.1.15",
  "localUrl": "http://192.168.1.15:4580",
  "ips": [
    { "name": "en0", "address": "192.168.1.15" }
  ]
}
```

---

### 2.2 List Clipboard Items
- **Endpoint**: `GET /api/items`
- **Query Parameters**:
  - `syncKey` (string, required): Active room sync key.
  - `type` (string, optional): Filter by `all` (default), `text`, `url`, `image`, or `file`.
  - `q` (string, optional): Case-insensitive text search query.
- **Response**:
```json
{
  "ok": true,
  "syncKey": "CS-5N36-2592",
  "devices": [
    { "clientId": "uuid-1", "deviceName": "Mac Studio", "platform": "darwin" }
  ],
  "items": [
    {
      "id": "c1f7a28e-8a0a-47d0-a335-5133c94d07b4",
      "roomId": "room_3b4f...",
      "type": "text",
      "text": "Copied content",
      "sourceDevice": "Mac Studio",
      "sourcePlatform": "darwin",
      "pinned": false,
      "createdAt": "2026-10-20T11:45:00.000Z",
      "updatedAt": "2026-10-20T11:45:00.000Z"
    }
  ]
}
```

---

### 2.3 Push New Clipboard Item
- **Endpoint**: `POST /api/items`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "syncKey": "CS-5N36-2592",
  "type": "text", // "text" | "url" | "image"
  "text": "Hello from API",
  "imageDataUrl": null, // "data:image/png;base64,..." if type is "image"
  "sourceDevice": "Work PC",
  "sourcePlatform": "win32",
  "clientId": "optional-origin-client-id"
}
```
- **Response**:
```json
{
  "ok": true,
  "item": { /* Item object */ },
  "isDuplicate": false
}
```

---

### 2.4 Upload File or Image
- **Endpoint**: `POST /api/upload`
- **Content-Type**: `multipart/form-data`
- **Form Fields**:
  - `file`: The binary file (Max size: 100 MB).
  - `syncKey`: Room sync key.
  - `asImage`: `"true"` to force inline clipboard image rendering.
  - `asFile`: `"true"` to force downloadable file representation.
  - `fileNameEncoded`: URL-encoded filename (preserves UTF-8 / Korean characters without HTTP header corruption).
  - `sourceDevice`: Device name.
  - `sourcePlatform`: `"darwin"` | `"win32"` | `"ios"` | `"android"` | `"web"`.
  - `clientId`: Client identifier for self-broadcast skipping.
- **Response**:
```json
{
  "ok": true,
  "item": {
    "id": "e89b27...",
    "type": "file",
    "text": "보고서.xlsx",
    "fileId": "uuid.xlsx",
    "fileName": "보고서.xlsx",
    "fileSize": 15420,
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "downloadUrl": "/api/files/uuid.xlsx/%EB%B3%B4%EA%B3%A0%EC%84%9C.xlsx?roomToken=...",
    "sourceDevice": "Mac Studio",
    "sourcePlatform": "darwin"
  }
}
```

---

### 2.5 Download Stored File
- **Endpoint**: `GET /api/files/:fileId/:fileName`
- **Query Parameters**:
  - `roomToken` (string): Cryptographic token derived from room ID, OR
  - `syncKey` (string): Room sync key for authorization.
- **Headers Returned**:
  - `Content-Disposition: attachment; filename="<utf8-encoded>"; filename*=UTF-8''<utf8-encoded>`
- **Response**: Binary stream of the requested file.

---

### 2.6 Activate / Promote Item
- **Endpoint**: `POST /api/items/:id/activate`
- **Description**: Moves an item to the top of the history list and triggers an active clipboard copy on all connected clients.
- **Response**: `{ "ok": true, "item": { ... } }`

---

### 2.7 Pin / Unpin Item
- **Endpoint**: `PATCH /api/items/:id/pin`
- **Request Body**: `{"syncKey": "CS-XXXX-XXXX", "pinned": true}` (or omit `pinned` to toggle)
- **Response**: `{ "ok": true, "item": { ... } }`

---

### 2.8 Delete Item
- **Endpoint**: `DELETE /api/items/:id?syncKey=CS-XXXX-XXXX`
- **Description**: Deletes a single item and unlinks its associated physical file on disk.
- **Response**: `{ "ok": true, "id": "<id>" }`

---

### 2.9 Clear History
- **Endpoint**: `DELETE /api/items?syncKey=CS-XXXX-XXXX`
- **Description**: Deletes all unpinned items in the room and purges orphan files from disk. Pinned items are preserved.
- **Response**: `{ "ok": true, "items": [ /* remaining pinned items */ ] }`

---

## 3. Apple iOS Shortcuts Integration

ClipSync includes lightweight 1-step endpoints specifically crafted for iOS Shortcuts:

### 3.1 Pull Latest Clipboard (iOS -> macOS / Windows)
- **Endpoint**: `GET /api/ios/latest?syncKey=CS-XXXX-XXXX&format=raw`
- **Shortcut Action**: "Get Contents of URL" -> "Copy to Clipboard"
- **Behavior**:
  - If latest item is text: returns UTF-8 plain text (`text/plain`).
  - If latest item is image: returns raw binary image with proper MIME type.
  - If latest item is file: triggers binary download.

### 3.2 Push Current Clipboard (iOS -> macOS / Windows)
- **Endpoint**: `POST /api/ios/push?syncKey=CS-XXXX-XXXX&device=iPhone`
- **Shortcut Action**: "Get Clipboard" -> "Get Contents of URL" (Method: POST, Request Body: Clipboard)
- **Behavior**:
  - Accepts raw text body or `multipart/form-data` file/photo upload.
  - Automatically broadcasts to all connected desktop devices within milliseconds.

---

## 4. WebSocket Protocol

WebSocket connection endpoint:
```
ws://<server-ip>:4580/ws?syncKey=CS-5N36-2592&deviceName=MacBook&platform=darwin&clientId=<uuid>
```

### 4.1 Server to Client Events

#### `init`
Sent immediately upon successful WebSocket handshake.
```json
{
  "event": "init",
  "clientId": "uuid-...",
  "syncKey": "CS-5N36-2592",
  "items": [ /* room clipboard items */ ],
  "devices": [ /* active connected devices */ ]
}
```

#### `presence:update`
Sent when a device joins or disconnects.
```json
{
  "event": "presence:update",
  "devices": [
    { "clientId": "uuid-1", "deviceName": "Mac Studio", "platform": "darwin", "connectedAt": "..." },
    { "clientId": "uuid-2", "deviceName": "Windows PC", "platform": "win32", "connectedAt": "..." }
  ]
}
```

#### `clipboard:new`
Sent when a new clipboard item or file is uploaded.
```json
{
  "event": "clipboard:new",
  "item": { /* Item object */ },
  "originClientId": "uuid-1",
  "activatedFromHistory": false
}
```

#### `clipboard:updated`
Sent when an item's state changes (e.g. pinned / unpinned).
```json
{
  "event": "clipboard:updated",
  "item": { /* Item object */ }
}
```

#### `clipboard:deleted`
Sent when an item is removed.
```json
{
  "event": "clipboard:deleted",
  "id": "item-uuid"
}
```

#### `clipboard:cleared`
Sent when history is cleared.
```json
{
  "event": "clipboard:cleared",
  "items": [ /* remaining pinned items */ ]
}
```

### 4.2 Client to Server Events

#### `clipboard:push`
```json
{
  "event": "clipboard:push",
  "item": {
    "type": "text",
    "text": "Hello World"
  }
}
```

#### `ping`
```json
{ "event": "ping" }
```
Server responds with: `{ "event": "pong", "ts": 1729424800000 }`
