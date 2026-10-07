export interface BridgeAPI {
  rendererReady: () => Promise<void>;
  beginWindowDrag: () => Promise<void>;
  newWindow?: () => Promise<{ success: boolean }>;
  openFileDialog: () => Promise<{ canceled: boolean; filePath?: string }>;
  openFolderDialog: () => Promise<{ canceled: boolean; folderPath?: string }>;
  saveAsDialog: (currentPath?: string, content?: string) => Promise<{ canceled: boolean; filePath?: string }>;
  saveCopyDialog: (currentPath?: string, content?: string) => Promise<{ canceled: boolean; filePath?: string; success?: boolean; error?: string }>;
  exportPDF: () => Promise<{ success: boolean; error?: string }>;
  saveDraft: (draft: { id: string; filePath?: string; content: string; timestamp: number }) => Promise<{ success: boolean }>;
  getAllDrafts: () => Promise<{ drafts: Array<{ id: string; filePath?: string; content: string; timestamp: number }> }>;
  deleteDraft: (id: string) => Promise<{ success: boolean }>;
  clearDrafts: () => Promise<{ success: boolean }>;
  checkConflict: (filePath: string, baselineRevision: string) => Promise<{ conflict: boolean; currentRevision?: string; reason?: string }>;
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string; stats?: { size: number; mtime: number; revision?: string; hasBOM?: boolean; lineEnding?: '\n' | '\r\n'; isReadOnly?: boolean } }>;
  writeFile: (filePath: string, content: string, expectedRevision?: string, options?: { hasBOM?: boolean; lineEnding?: string }) => Promise<{ success: boolean; error?: string; stats?: { size: number; mtime: number; revision?: string } }>;
  setDocumentEdited: (isEdited: boolean) => Promise<{ success: boolean }>;
  confirmSaveDialog: (fileName: string) => Promise<{ action: 'save' | 'dont-save' | 'cancel' }>;
  closeWindow: () => Promise<{ success: boolean }>;
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
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingCallbacks = new Map<string, PendingCallback>();
const eventListeners: Record<string, Array<(data: any) => void>> = {};

export function registerGlobalHandlers() {
  const g: any = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (g) {
    g.handleNativeResponse = (id: string, result: any, error?: string) => {
      const pending = pendingCallbacks.get(id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
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
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          pendingCallbacks.delete(id);
          reject(new Error(`Native request timed out for action: ${action}`));
        }, timeoutMs)
      : null;

    pendingCallbacks.set(id, { resolve, reject, timer });

    try {
      window.webkit.messageHandlers.nativeAPI.postMessage({
        id,
        action,
        payload: payload ?? {}
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
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
      rendererReady: () => callNative('app:renderer-ready'),
      beginWindowDrag: () => callNative('window:begin-drag'),
      newWindow: () => callNative('window:new-window'),
      openFileDialog: () => callNative('dialog:open-file', undefined, 0),
      openFolderDialog: () => callNative('dialog:open-folder', undefined, 0),
      saveAsDialog: (currentPath?: string, content?: string) => callNative('dialog:save-as', { currentPath, content }, 0),
      saveCopyDialog: (currentPath?: string, content?: string) => callNative('dialog:save-copy', { currentPath, content }, 0),
      exportPDF: () => callNative('export:pdf', undefined, 0),
      saveDraft: (draft) => callNative('drafts:save', draft),
      getAllDrafts: () => callNative('drafts:get-all'),
      deleteDraft: (id) => callNative('drafts:delete', { id }),
      clearDrafts: () => callNative('drafts:clear-all'),
      checkConflict: (filePath, baselineRevision) => callNative('fs:check-conflict', { filePath, baselineRevision }),
      readFile: (filePath: string) => callNative('fs:read-file', { filePath }),
      writeFile: (filePath: string, content: string, expectedRevision?: string, options?: { hasBOM?: boolean; lineEnding?: string }) => callNative('fs:write-file', { filePath, content, expectedRevision, ...options }),
      setDocumentEdited: (isEdited: boolean) => callNative('window:set-edited', { isEdited }),
      confirmSaveDialog: (fileName: string) => callNative('dialog:confirm-save', { fileName }, 0),
      closeWindow: () => callNative('window:close'),
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
