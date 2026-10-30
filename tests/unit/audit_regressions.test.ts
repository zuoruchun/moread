import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let MoReadApp: any, app: any, api: any, disk: Map<string, string>;
beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  disk = new Map([['/A.md', 'A baseline'], ['/B.md', 'B baseline']]);
  api = {
    readFile: vi.fn(async (path: string) => ({ success: true, content: disk.get(path), stats: { hasBOM: false, lineEnding: '\n' } })),
    writeFile: vi.fn(async (path: string, text: string) => { disk.set(path, text); return { success: true }; }),
    setDocumentEdited: vi.fn(async () => ({ success: true })),
    deleteDraft: vi.fn(async () => ({ success: true })), saveDraft: vi.fn(async () => ({ success: true }))
  };
  window.electronAPI = api;
  app = Object.assign(Object.create(MoReadApp.prototype), {
    tabs: [], activeTabId: null, currentSettings: { saveMode: 'auto' },
    sourceTextareaEl: { value: '' }, isComposing: false, saveInFlight: null,
    reloadRequests: new WeakMap(), renderTabBar: vi.fn(), updateUIForMode: vi.fn(),
    renderActiveTabContent: vi.fn(() => { app.sourceTextareaEl.value = app.activeTab.rawContent; }),
    recordRecentFile: vi.fn(), getScrollRatio: () => 0,
    errorBannerEl: { textContent: '', style: {}, classList: { add: vi.fn(), remove: vi.fn() } },
    conflictBannerEl: { style: {}, classList: { add: vi.fn(), remove: vi.fn() } },
    docTitleEl: { textContent: '' }, docPathEl: { textContent: '', title: '' }, statusStatsEl: { textContent: '' }
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function open(path: string) {
  const tab = app.createTab({ filePath: path, rawContent: disk.get(path), isSourceMode: true, isEditMode: true });
  app.switchTab(tab.id); return tab;
}
function edit(text: string) { app.sourceTextareaEl.value = text; app.markAsEdited(); }

describe('Current audit: cross-tab autosave and reload metadata', () => {
  it('saves the outgoing edited tab when switching away', async () => {
    const a = open('/A.md'); const b = open('/B.md'); app.switchTab(a.id);
    edit('A edited'); await vi.advanceTimersByTimeAsync(500); app.switchTab(b.id);
    await vi.advanceTimersByTimeAsync(2000); app.switchTab(a.id); await vi.advanceTimersByTimeAsync(2000);
    expect(disk.get('/A.md')).toBe('A edited');
    expect(a.isEdited).toBe(false); expect(api.writeFile).toHaveBeenCalled();
  });
  it('keeps foreground autosave running after a background conflict', async () => {
    app.currentSettings.saveMode = 'manual';
    const a = open('/A.md'); edit('A edited'); const b = open('/B.md');
    app.currentSettings.saveMode = 'auto'; edit('B edited');
    disk.set('/A.md', 'A external'); await app.reloadTabFromDisk(a); await vi.advanceTimersByTimeAsync(2000);
    expect(app.autoSavePaused).toBe(false); expect(a.autoSavePaused).toBe(true);
    expect(disk.get('/B.md')).toBe('B edited'); expect(b.isEdited).toBe(false);
  });
  it('uses current encoding metadata after external reload', async () => {
    const a = open('/A.md');
    disk.set('/A.md', 'A external');
    api.readFile.mockImplementation(async (path: string) => ({ success: true, content: disk.get(path), stats: { hasBOM: true, lineEnding: '\r\n' } }));
    await app.reloadTabFromDisk(a);
    edit('A after reload'); expect(await app.saveTab(a)).toBe(true);
    expect(api.writeFile.mock.calls[0][3]).toEqual({ hasBOM: true, lineEnding: '\r\n' });
  });
});
