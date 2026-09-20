const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onTabletOrder: (callback) => ipcRenderer.on('tablet-order', (_event, value) => callback(value)),
    updateSettings: (settings) => ipcRenderer.send('update-settings', settings),
    updateMenu: (menu) => ipcRenderer.send('update-menu', menu)
});
