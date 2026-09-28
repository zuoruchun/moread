// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provide global window mock in Node test runner
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}

import { initNativeBridge } from '../../src/renderer/modules/bridge.ts';

describe('Native WebKit Bridge', () => {
  let mockPostMessage: any;

  beforeEach(() => {
    mockPostMessage = vi.fn();
    (window as any).webkit = {
      messageHandlers: {
        nativeAPI: {
          postMessage: mockPostMessage
        }
      }
    };
    initNativeBridge();
  });

  it('correctly initializes window.electronAPI with native implementation', () => {
    expect(window.electronAPI).toBeDefined();
    expect(typeof window.electronAPI.openFileDialog).toBe('function');
    expect(typeof window.electronAPI.readFile).toBe('function');
    expect(typeof window.electronAPI.onOpenFile).toBe('function');
    expect(typeof window.electronAPI.rendererReady).toBe('function');
    expect(typeof window.electronAPI.beginWindowDrag).toBe('function');
  });

  it('sends renderer readiness and native window drag actions', () => {
    const readyPromise = window.electronAPI.rendererReady();
    const dragPromise = window.electronAPI.beginWindowDrag();

    expect(mockPostMessage.mock.calls[0][0].action).toBe('app:renderer-ready');
    expect(mockPostMessage.mock.calls[1][0].action).toBe('window:begin-drag');
    window.handleNativeResponse!(mockPostMessage.mock.calls[0][0].id, { success: true });
    window.handleNativeResponse!(mockPostMessage.mock.calls[1][0].id, { success: true });
    return Promise.all([readyPromise, dragPromise]);
  });

  it('sends message to nativeAPI and resolves when handleNativeResponse is called', async () => {
    const promise = window.electronAPI.readFile('/path/to/test.md');

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const sentData = mockPostMessage.mock.calls[0][0];
    expect(sentData.action).toBe('fs:read-file');
    expect(sentData.payload.filePath).toBe('/path/to/test.md');
    expect(sentData.id).toMatch(/^req_/);

    // Simulate native response
    window.handleNativeResponse!(sentData.id, {
      success: true,
      content: '# Hello',
      stats: { size: 7, mtime: 1000 }
    });

    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.content).toBe('# Hello');
  });

  it('rejects with error when native returns an error', async () => {
    const promise = window.electronAPI.readFile('/non/existent.md');
    const sentData = mockPostMessage.mock.calls[0][0];

    window.handleNativeResponse!(sentData.id, null, 'File not found');

    await expect(promise).rejects.toThrow('File not found');
  });

  it('keeps file dialogs pending while the user browses', async () => {
    vi.useFakeTimers();
    try {
      const promise = window.electronAPI.openFileDialog();
      const sentData = mockPostMessage.mock.calls[0][0];

      await vi.advanceTimersByTimeAsync(60_000);
      window.handleNativeResponse!(sentData.id, {
        canceled: false,
        filePath: '/path/to/slow-selection.md'
      });

      await expect(promise).resolves.toEqual({
        canceled: false,
        filePath: '/path/to/slow-selection.md'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches app:open-file event to registered callback', () => {
    const cb = vi.fn();
    const unsubscribe = window.electronAPI.onOpenFile(cb);

    window.handleNativeEvent!('app:open-file', '/path/to/opened.md');
    expect(cb).toHaveBeenCalledWith('/path/to/opened.md');

    unsubscribe();
    window.handleNativeEvent!('app:open-file', '/path/to/opened2.md');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('dispatches file:changed and menu:action events', () => {
    const fileChangedCb = vi.fn();
    const menuActionCb = vi.fn();

    window.electronAPI.onFileChanged(fileChangedCb);
    window.electronAPI.onMenuAction(menuActionCb);

    window.handleNativeEvent!('file:changed', '/path/to/modified.md');
    expect(fileChangedCb).toHaveBeenCalledWith('/path/to/modified.md');

    window.handleNativeEvent!('menu:action', 'toggle-outline');
    expect(menuActionCb).toHaveBeenCalledWith('toggle-outline');
  });
});
