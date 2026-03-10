import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onNewPost(cb: (post: unknown) => void) {
    const handler = (_: Electron.IpcRendererEvent, post: unknown) => cb(post);
    ipcRenderer.on('post:new', handler);
    return () => {
      ipcRenderer.removeListener('post:new', handler);
    };
  },

  onConfigUpdate(cb: (display: unknown) => void) {
    const handler = (_: Electron.IpcRendererEvent, display: unknown) =>
      cb(display);
    ipcRenderer.on('config:update', handler);
    return () => {
      ipcRenderer.removeListener('config:update', handler);
    };
  },

  getConfig(): Promise<unknown> {
    return ipcRenderer.invoke('config:get');
  },

  // Notify the main process that a post has been fully handled by the
  // renderer — either admitted to the visible stack or skipped by the
  // overflow guard. main.ts uses this to track pendingInRenderer so pump()
  // doesn't trigger a premature fetch while posts are still being measured.
  postConsumed(): void {
    ipcRenderer.send('post:consumed');
  },
});