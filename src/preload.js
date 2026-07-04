const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('folderAPI', {
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  getFiles: (folderPath) => ipcRenderer.invoke('folder:get-files', folderPath),
  getWatchedFolders: () => ipcRenderer.invoke('config:get-watched-folders'),
  startWatching: () => ipcRenderer.invoke('watcher:start'),

  onFolderChanged: (callback) => {
    const listener = (_event, changeInfo) => {
      callback(changeInfo);
    };

    ipcRenderer.on('folder:changed', listener);

    return () => {
      ipcRenderer.off('folder:changed', listener);
    };
  },
});