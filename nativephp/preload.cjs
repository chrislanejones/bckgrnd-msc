// Sandboxed preload: Electron is the only privileged import. The page cannot
// invoke arbitrary IPC, access files, execute commands, or build native menus.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('BckgrndDesktop', {
  onClose(callback) {
    const listener = () => callback();
    ipcRenderer.on('bckgrnd:close-request', listener);
    return () => ipcRenderer.removeListener('bckgrnd:close-request', listener);
  },
  confirmClose() { ipcRenderer.send('bckgrnd:confirm-close'); },
  onMenu(callback) {
    const listener = (_event, data) => {
      const action = data?.event?.replace(/^\\+/, '');
      if (['bckgrnd.open', 'bckgrnd.save', 'bckgrnd.saveAs', 'bckgrnd.export', 'bckgrnd.reveal', 'bckgrnd.recovery'].includes(action)) callback(action);
    };
    ipcRenderer.on('native-event', listener);
    return () => ipcRenderer.removeListener('native-event', listener);
  },
});
