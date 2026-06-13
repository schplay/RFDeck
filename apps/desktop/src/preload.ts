import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  // Expose minimal IPC methods if needed later
});
