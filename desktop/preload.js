const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clipsync', {
  getState: () => ipcRenderer.invoke('state:get'),
  onStateUpdate: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },
  onThemeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },
  onWindowShown: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:shown', handler);
    return () => ipcRenderer.removeListener('window:shown', handler);
  },
  activateItem: (itemId) => ipcRenderer.invoke('clipboard:activate-item', itemId),
  pinItem: (itemId) => ipcRenderer.invoke('clipboard:pin-item', itemId),
  deleteItem: (itemId) => ipcRenderer.invoke('clipboard:delete-item', itemId),
  clearAll: () => ipcRenderer.invoke('clipboard:clear-all'),
  uploadFileDialog: () => ipcRenderer.invoke('clipboard:upload-file-dialog'),
  uploadDroppedFiles: (filePaths) => ipcRenderer.invoke('clipboard:upload-dropped-files', filePaths),
  getPathForFile: (file) => {
    try {
      return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path;
    } catch {
      return file.path;
    }
  },
  saveFile: (itemId) => ipcRenderer.invoke('clipboard:save-file', itemId),
  updateConfig: (partial) => ipcRenderer.invoke('config:update', partial),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDownloads: () => ipcRenderer.invoke('shell:open-downloads'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('app:quit')
});
