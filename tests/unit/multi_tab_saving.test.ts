import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let MoReadApp: typeof import('../../src/renderer/main.ts').MoReadApp;
let app: any;
let api: any;
let disk: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});

beforeEach(() => {
  vi.useFakeTimers();
  disk = new Map([['/A.md', 'A baseline'], ['/B.md', 'B baseline']]);
  api = {
    readFile: vi.fn(async (path: string) => ({ success: true, content: disk.get(path) })),
    writeFile: vi.fn(async (path: string, text: string) => { disk.set(path, text); return { success: true }; }),
    confirmSaveDialog: vi.fn(async () => ({ action: 'save' })),
    setDocumentEdited: vi.fn(async () => ({ success: true })),
    deleteDraft: vi.fn(async () => ({ success: true })),
    saveDraft: vi.fn(async () => ({ success: true })),
    saveSettings: vi.fn(async () => ({}))
  };
  window.electronAPI = api;
  app = Object.assign(Object.create(MoReadApp.prototype), {
    tabs: [], activeTabId: null, currentSettings: { saveMode: 'manual' },
    sourceTextareaEl: { value: '' }, isComposing: false, saveInFlight: null,
    renderTabBar: vi.fn(), renderActiveTabContent: vi.fn(), updateUIForMode: vi.fn(),
    recordRecentFile: vi.fn(), getScrollRatio: () => 0,
    errorBannerEl: { textContent: '', style: {}, classList: { add: vi.fn(), remove: vi.fn() } },
    docTitleEl: { textContent: '' }, docPathEl: { textContent: '', title: '' },
    statusStatsEl: { textContent: '' }
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function open(path: string) {
  const tab = app.createTab({ filePath: path, rawContent: disk.get(path), isSourceMode: true, isEditMode: true });
  app.activeTabId = tab.id;
  app.sourceTextareaEl.value = tab.rawContent;
  return tab;
}

function edit(text: string) { app.sourceTextareaEl.value = text; app.markAsEdited(); }

describe('Document identity across saving and edit-mode confirmations', () => {
  function untitled() {
    const tab = app.createTab({ isSourceMode: true, isEditMode: true });
    app.activeTabId = tab.id;
    edit('new document');
    api.saveToDocuments = vi.fn(async () => ({ canceled: false, success: true, filePath: '/Documents/Moread/未命名.md' }));
    api.confirmSaveDialog.mockResolvedValue({ action: 'save-to-documents' });
    return tab;
  }

  it('saves an untitled tab to Documents on close without opening Save As', async () => {
    const a = untitled();
    a.rawContent = 'new document';
    const b = open('/B.md');
    expect(await app.closeTab(a.id)).toBe(true);
    expect(api.confirmSaveDialog).toHaveBeenCalledWith('未命名', true);
    expect(api.saveToDocuments).toHaveBeenCalledWith('未命名', 'new document', { hasBOM: false, lineEnding: '\n' });
    expect(app.tabs).toEqual([b]);
    expect(b.filePath).toBe('/B.md');
  });

  it('preserves untitled edits and its draft when Documents saving fails', async () => {
    const a = untitled();
    api.saveToDocuments.mockResolvedValue({ success: false, error: 'Documents unavailable' });
    expect(await app.closeTab(a.id)).toBe(false);
    expect(a.filePath).toBeNull();
    expect(a.isEdited).toBe(true);
    expect(app.tabs).toContain(a);
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('keeps later edits unsaved after the Documents snapshot is written', async () => {
    const a = untitled();
    let finish!: (value: any) => void;
    api.saveToDocuments.mockImplementation(() => new Promise(r => { finish = r; }));
    const save = app.handleSaveAs(a, true);
    edit('later edit');
    finish({ success: true, canceled: false, filePath: '/Documents/Moread/未命名.md' });
    expect(await save).toBe(false);
    expect(a.savedContent).toBe('new document');
    expect(a.isEdited).toBe(true);
    expect(app.sourceTextareaEl.value).toBe('later edit');
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('prepares window close after Documents saving updates the captured path', async () => {
    const a = untitled();
    expect(await app.prepareToClose()).toBe(true);
    expect(app.isPreparedToClose()).toBe(true);
    expect(a.filePath).toBe('/Documents/Moread/未命名.md');
    expect(a.isEdited).toBe(false);
  });

  it('leaves edit mode after saving an untitled document to Documents', async () => {
    const a = untitled();
    await app.toggleEditMode();
    expect(a.filePath).toBe('/Documents/Moread/未命名.md');
    expect(a.isEditMode).toBe(false);
    expect(a.isEdited).toBe(false);
  });

  it('does not create another copy when an untitled save is already pending', async () => {
    const a = untitled();
    let finish!: (value: any) => void;
    api.saveToDocuments.mockImplementation(() => new Promise(r => { finish = r; }));
    const save = app.handleSaveAs(a, true);
    expect(await app.handleSaveAs(a, true)).toBe(false);
    expect(api.saveToDocuments).toHaveBeenCalledTimes(1);
    finish({ canceled: true });
    expect(await save).toBe(false);
    expect(a.isEdited).toBe(true);
  });

  it('keeps existing documents on their original save path', async () => {
    const a = open('/A.md'); edit('existing update');
    expect(await app.handleSaveAs(a, true)).toBe(false);
    expect(await app.closeTab(a.id)).toBe(true);
    expect(api.confirmSaveDialog).toHaveBeenCalledWith('A.md', false);
    expect(disk.get('/A.md')).toBe('existing update');
  });

  it('saves the inactive dirty tab when its close button is used', async () => {
    const a = open('/A.md'); edit('A edited'); a.rawContent = app.sourceTextareaEl.value;
    const b = open('/B.md');
    expect(await app.closeTab(a.id)).toBe(true);
    expect(disk.get('/A.md')).toBe('A edited');
    expect(disk.get('/B.md')).toBe('B baseline');
    expect(app.tabs).toEqual([b]);
  });

  it('never acknowledges B edits using a delayed A save response', async () => {
    const a = open('/A.md'); edit('A edited');
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(r => { entered = r; });
    api.writeFile.mockImplementationOnce(async (path: string, text: string) => {
      disk.set(path, text); entered(); await new Promise<void>(r => { release = r; }); return { success: true };
    });
    const save = app.saveTab(a); await reached;
    const b = open('/B.md'); edit('B edited'); release();
    expect(await save).toBe(true);
    expect(a.isEdited).toBe(false);
    expect(b.isEdited).toBe(true);
    expect(b.savedContent).toBe('B baseline');
    expect(b.rawContent).toBe('B baseline');
    expect(app.sourceTextareaEl.value).toBe('B edited');
    expect(disk.get('/B.md')).toBe('B baseline');
    expect(api.setDocumentEdited).toHaveBeenLastCalledWith(true);
  });

  it('preserves a later edit while a Save As snapshot is being written', async () => {
    const a = open('/A.md'); edit('snapshot');
    let finish!: (value: any) => void;
    api.saveAsDialog = vi.fn(() => new Promise(r => { finish = r; }));
    const pending = app.handleSaveAs(); edit('later edit');
    disk.set('/new.md', 'snapshot'); finish({ canceled: false, success: true, filePath: '/new.md' });
    expect(await pending).toBe(false);
    expect(a.filePath).toBe('/new.md');
    expect(a.savedContent).toBe('snapshot');
    expect(a.isEdited).toBe(true);
    expect(app.sourceTextareaEl.value).toBe('later edit');
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('keeps failed Save As content and identity intact', async () => {
    const a = open('/A.md'); edit('keep');
    api.saveAsDialog = vi.fn(async () => ({ canceled: false, success: false, error: 'Write denied' }));
    expect(await app.handleSaveAs()).toBe(false);
    expect(a.filePath).toBe('/A.md');
    expect(a.isEdited).toBe(true);
    expect(app.errorBannerEl.textContent).toBe('Write denied');
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('saves the original tab after switching during an end-edit confirmation', async () => {
    const a = open('/A.md'); edit('A edited'); a.rawContent = 'A edited';
    let finish!: (value: any) => void;
    api.confirmSaveDialog = vi.fn(() => new Promise(r => { finish = r; }));
    const exit = app.toggleEditMode(); const b = open('/B.md'); edit('B edited');
    finish({ action: 'save' }); await exit;
    expect(disk.get('/A.md')).toBe('A edited');
    expect(disk.get('/B.md')).toBe('B baseline');
    expect(a.isEditMode).toBe(false);
    expect(b.isEditMode).toBe(true);
    expect(b.isEdited).toBe(true);
  });

  it('reports confirmation errors and permits the next end-edit click', async () => {
    const a = open('/A.md'); edit('A edited');
    api.confirmSaveDialog.mockRejectedValueOnce(new Error('Dialog unavailable'));
    await app.toggleEditMode();
    expect(a.isEditMode).toBe(true);
    expect(a.isEdited).toBe(true);
    expect(app.errorBannerEl.textContent).toContain('Dialog unavailable');
    await app.toggleEditMode();
    expect(a.isEditMode).toBe(false);
    expect(disk.get('/A.md')).toBe('A edited');
  });
});
