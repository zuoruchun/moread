// Bridge between WebKit WKWebView (or Electron) and Frontend
export interface BridgeAPI {
  openFileDialog: () => Promise<{ canceled: boolean; filePath?: string }>;
  openFolderDialog: () => Promise<{ canceled: boolean; folderPath?: string }>;
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string; stats?: { size: number; mtime: number } }>;
  readFolder: (folderPath: string) => Promise<{ success: boolean; nodes?: any[]; error?: string }>;
  showInFolder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<void>;
  clearRecentAndSettings: () => Promise<void>;
  onOpenFile: (callback: (filePath: string) => void) => () => void;
  onOpenFolder?: (callback: (folderPath: string) => void) => () => void;
  onFileChanged: (callback: (filePath: string) => void) => () => void;
  onMenuAction: (callback: (action: string) => void) => () => void;
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        nativeAPI?: {
          postMessage: (message: any) => void;
        };
      };
    };
    handleNativeResponse?: (id: string, result: any, error?: string) => void;
    handleNativeEvent?: (eventName: string, data: any) => void;
    electronAPI: BridgeAPI;
  }
}

interface PendingCallback {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: any;
}

const pendingCallbacks = new Map<string, PendingCallback>();
const eventListeners: Record<string, Array<(data: any) => void>> = {};

export function registerGlobalHandlers() {
  const g: any = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (g) {
    g.handleNativeResponse = (id: string, result: any, error?: string) => {
      const pending = pendingCallbacks.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCallbacks.delete(id);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(result);
        }
      }
    };

    g.handleNativeEvent = (eventName: string, data: any) => {
      const list = eventListeners[eventName];
      if (list && list.length > 0) {
        list.forEach((cb) => {
          try {
            cb(data);
          } catch (e) {
            console.error(`Error in event listener for ${eventName}:`, e);
          }
        });
      }
    };
  }
}

registerGlobalHandlers();

function callNative<T = any>(action: string, payload?: any, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers?.nativeAPI) {
      reject(new Error('Native WebKit bridge is not available'));
      return;
    }

    const id = 'req_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    const timer = setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error(`Native request timed out for action: ${action}`));
    }, timeoutMs);

    pendingCallbacks.set(id, { resolve, reject, timer });

    try {
      window.webkit.messageHandlers.nativeAPI.postMessage({
        id,
        action,
        payload: payload ?? {}
      });
    } catch (err) {
      clearTimeout(timer);
      pendingCallbacks.delete(id);
      reject(err);
    }
  });
}

function addEventListener(eventName: string, callback: (data: any) => void): () => void {
  if (!eventListeners[eventName]) {
    eventListeners[eventName] = [];
  }
  eventListeners[eventName].push(callback);
  return () => {
    eventListeners[eventName] = (eventListeners[eventName] || []).filter((cb) => cb !== callback);
  };
}

export function initNativeBridge(): BridgeAPI {
  registerGlobalHandlers();
  // If running inside WKWebView (Native Swift Host)
  if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.nativeAPI) {
    const nativeAPI: BridgeAPI = {
      openFileDialog: () => callNative('dialog:open-file'),
      openFolderDialog: () => callNative('dialog:open-folder'),
      readFile: (filePath: string) => callNative('fs:read-file', { filePath }),
      readFolder: (folderPath: string) => callNative('fs:read-folder', { folderPath }),
      showInFolder: (filePath: string) => callNative('fs:show-in-folder', { filePath }),
      openExternal: (url: string) => callNative('shell:open-external', { url }),
      getSettings: () => callNative('store:get-settings'),
      saveSettings: (settings: any) => callNative('store:save-settings', settings),
      clearRecentAndSettings: () => callNative('store:clear-all'),
      onOpenFile: (cb) => addEventListener('app:open-file', cb),
      onOpenFolder: (cb) => addEventListener('app:open-folder', cb),
      onFileChanged: (cb) => addEventListener('file:changed', cb),
      onMenuAction: (cb) => addEventListener('menu:action', cb)
    };

    window.electronAPI = nativeAPI;
    return nativeAPI;
  }

  // Fallback to Electron's injected window.electronAPI or mock
  return window.electronAPI;
}

// Auto-initialize if running in browser/WKWebView
if (typeof window !== 'undefined') {
  initNativeBridge();
}
