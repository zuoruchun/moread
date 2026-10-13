import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let MoReadApp: typeof import('../../src/renderer/main.ts').MoReadApp;
let app: any;
let api: any;
let disk: Map<string, string>;
let drafts: Map<string, any>;

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.useFakeTimers();
  disk = new Map([['/A.md', 'A baseline'], ['/B.md', 'B baseline'], ['/C.md', 'C baseline']]);
  drafts = new Map();
  api = {
    readFile: vi.fn(async (path: string) => ({ success: disk.has(path), content: disk.get(path) })),
    writeFile: vi.fn(async (path: string, text: string) => { disk.set(path, text); return { success: true }; }),
    confirmSaveDialog: vi.fn(async () => ({ action: 'dont-save' })),
    setDocumentEdited: vi.fn(async () => ({ success: true })),
    closeWindow: vi.fn(async () => ({ success: true })),
    unwatchFile: vi.fn(async () => ({ success: true })),
    deleteDraft: vi.fn(async (id: string) => { drafts.delete(id); return { success: true }; }),
    saveDraft: vi.fn(async (draft: any) => { drafts.set(draft.id, draft); return { success: true }; }),
    getAllDrafts: vi.fn(async () => ({ drafts: [...drafts.values()] }))
  };
  window.electronAPI = api;
  app = Object.assign(Object.create(MoReadApp.prototype), {
    tabs: [], activeTabId: null, currentSettings: { saveMode: 'manual' },
    sourceTextareaEl: { value: '', focus: vi.fn(), scrollHeight: 1, clientHeight: 1, scrollTop: 0 },
    markdownBodyEl: {}, searchController: { refresh: vi.fn() }, isComposing: false, saveInFlight: null, renderSessionId: 0, scrollPositions: {},
    renderTabBar: vi.fn(), updateUIForMode: vi.fn(),
    renderActiveTabContent: vi.fn(() => { app.sourceTextareaEl.value = app.activeTab.rawContent; app.updateDocumentEdited(); }),
    recordRecentFile: vi.fn(), getScrollRatio: () => 0.5, setScrollRatio: vi.fn(),
    errorBannerEl: { textContent: '', style: {}, classList: { add: vi.fn(), remove: vi.fn() } },
    docTitleEl: { textContent: '' }, docPathEl: { textContent: '', title: '' },
    statusStatsEl: { textContent: '' }
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function open(path: string) {
  const tab = app.createTab({ filePath: path, rawContent: disk.get(path), isSourceMode: true, isEditMode: true });
  app.switchTab(tab.id);
  return tab;
}

function edit(text: string) { app.sourceTextareaEl.value = text; app.markAsEdited(); }

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Draft identity, persistence and recovery', () => {
  it('saves both tabs after editing and switching inside the debounce interval', async () => {
    const a = open('/A.md'); edit('A edited');
    const b = open('/B.md'); edit('B edited');
    await vi.advanceTimersByTimeAsync(1500);
    expect(drafts.get(a.draftId)).toMatchObject({ filePath: '/A.md', content: 'A edited', savedContent: 'A baseline' });
    expect(drafts.get(b.draftId)).toMatchObject({ filePath: '/B.md', content: 'B edited', savedContent: 'B baseline' });
    expect(a.draftId).not.toBe(b.draftId);
  });

  it('does not persist an incomplete composition, then stores committed text', async () => {
    const a = open('/A.md'); app.isComposing = true; edit('正在组词');
    await vi.advanceTimersByTimeAsync(1500);
    expect(drafts.size).toBe(0);
    app.isComposing = false; edit('已经完成');
    await vi.advanceTimersByTimeAsync(1500);
    expect(drafts.get(a.draftId).content).toBe('已经完成');
  });

  it('cancels pending draft writes when the document is saved', async () => {
    const a = open('/A.md'); edit('saved');
    expect(await app.saveTab(a)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(drafts.size).toBe(0);
  });

  it('orders deletion after a draft write already in flight', async () => {
    const a = open('/A.md'); edit('saved');
    const gate = deferred();
    api.saveDraft.mockImplementationOnce(async (draft: any) => {
      await gate.promise; drafts.set(draft.id, draft); return { success: true };
    });
    await vi.advanceTimersByTimeAsync(1500);
    const save = app.saveTab(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.deleteDraft).not.toHaveBeenCalled();
    gate.resolve({});
    expect(await save).toBe(true);
    expect(drafts.size).toBe(0);
  });

  it('preserves a later edit made while a successful save deletes its old draft', async () => {
    const a = open('/A.md'); edit('snapshot');
    const started = deferred(); const gate = deferred();
    api.deleteDraft.mockImplementationOnce(async () => { started.resolve({}); await gate.promise; return { success: true }; });
    const save = app.saveTab(a); await started.promise;
    edit('later edit'); gate.resolve({});
    expect(await save).toBe(false);
    expect(a.isEdited).toBe(true);
    expect(disk.get('/A.md')).toBe('snapshot');
    await vi.advanceTimersByTimeAsync(1500);
    expect(drafts.get(a.draftId).content).toBe('later edit');
  });

  it('restores a named draft with its original baseline and encoding, then saves normally', async () => {
    drafts.set('old-draft', { id: 'old-draft', filePath: '/A.md', content: 'recovered', savedContent: 'A baseline', hasBOM: true, lineEnding: '\r\n', timestamp: 1 });
    await app.recoverAllDrafts();
    const a = app.activeTab;
    expect(a.savedContent).toBe('A baseline');
    expect(a.externalConflict).toBe(false);
    a.isSourceMode = true;
    expect(await app.saveTab(a)).toBe(true);
    expect(disk.get('/A.md')).toBe('recovered');
    expect(api.writeFile).toHaveBeenCalledWith('/A.md', 'recovered', undefined, { hasBOM: true, lineEnding: '\r\n' });
    expect(drafts.size).toBe(0);
  });

  it('does not overwrite a disk revision changed since the recovered draft baseline', async () => {
    drafts.set('old', { id: 'old', filePath: '/A.md', content: 'recovered', savedContent: 'older baseline', timestamp: 1 });
    await app.recoverAllDrafts();
    const a = app.activeTab; a.isSourceMode = true;
    expect(a.externalConflict).toBe(true);
    expect(await app.saveTab(a)).toBe(false);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(disk.get('/A.md')).toBe('A baseline');
    expect(drafts.has('old')).toBe(true);
  });

  it('recovers a legacy draft without a baseline as an independent unsaved document', async () => {
    drafts.set('/A.md', { id: '/A.md', filePath: '/A.md', content: 'legacy content', timestamp: 1 });
    await app.recoverAllDrafts();
    expect(app.activeTab.filePath).toBeNull();
    expect(app.activeTab.rawContent).toBe('legacy content');
    expect(app.activeTab.isEdited).toBe(true);
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it('keeps an existing tab intact when its named draft is recovered', async () => {
    const existing = open('/A.md'); edit('current edits');
    drafts.set('old', { id: 'old', filePath: '/A.md', content: 'recovered', savedContent: 'A baseline', timestamp: 1 });
    await app.recoverAllDrafts();
    expect(existing.rawContent).toBe('current edits');
    expect(app.activeTab.filePath).toBeNull();
    expect(app.activeTab.rawContent).toBe('recovered');
  });

  it('creates separate draft identities for two tabs referencing the same path', async () => {
    const a = open('/A.md'); edit('first window contents');
    const b = open('/A.md'); edit('second window contents');
    await vi.advanceTimersByTimeAsync(1500);
    expect(drafts.size).toBe(2);
    expect(drafts.get(a.draftId).content).toBe('first window contents');
    expect(drafts.get(b.draftId).content).toBe('second window contents');
  });

  it('renders untrusted draft names and paths solely as text nodes', () => {
    const createElement = (tag: string) => ({
      tag, className: '', textContent: '', children: [] as any[],
      set innerHTML(value: string) { if (value) throw new Error('Untrusted HTML inserted'); },
      appendChild(child: any) { this.children.push(child); }
    });
    vi.stubGlobal('document', { createElement });
    app.draftRecoveryListEl = createElement('ul');
    const path = '/x<img src=x onerror="window.injected=1">.md';
    app.renderDraftRecoveryList([{ id: 'x', filePath: path, content: '', timestamp: 1 }]);
    const item = app.draftRecoveryListEl.children[0];
    expect(item.children[0].children[0].textContent).toBe(path.slice(1));
    expect(item.children[1].textContent).toBe(path);
  });
});

describe('Tab and window close approval', () => {
  it('shares a tab close request and does not remove a second tab by a stale array index', async () => {
    const a = open('/A.md'); edit('edited'); const b = open('/B.md');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const first = app.closeTab(a.id); const second = app.closeTab(a.id);
    gate.resolve({ action: 'dont-save' });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(api.confirmSaveDialog).toHaveBeenCalledTimes(1);
    expect(app.tabs).toEqual([b]);
    expect(api.unwatchFile).toHaveBeenCalledWith('/A.md');
    expect(api.setDocumentEdited).toHaveBeenLastCalledWith(false);
  });

  it('keeps a watcher when another tab still references that file', async () => {
    const a = open('/A.md'); open('/A.md');
    expect(await app.closeTab(a.id)).toBe(true);
    expect(api.unwatchFile).not.toHaveBeenCalled();
  });

  it('rejects a stale discard decision after new edits', async () => {
    const a = open('/A.md'); edit('old edit');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const close = app.closeTab(a.id); edit('new edit');
    gate.resolve({ action: 'dont-save' });
    expect(await close).toBe(false);
    expect(app.tabs).toContain(a);
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('does not end edit mode using a stale discard decision', async () => {
    const a = open('/A.md'); edit('old edit');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const close = app.toggleEditMode(); edit('new edit');
    gate.resolve({ action: 'dont-save' }); await close;
    expect(a.isEditMode).toBe(true);
    expect(a.isEdited).toBe(true);
    expect(app.sourceTextareaEl.value).toBe('new edit');
  });

  it('rejects window close when a formerly clean tab acquires new edits', async () => {
    const a = open('/A.md'); edit('A edits'); const b = open('/B.md');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const close = app.prepareToClose(); edit('B new edit');
    gate.resolve({ action: 'dont-save' });
    expect(await close).toBe(false);
    expect(a.isEdited).toBe(true); expect(b.isEdited).toBe(true);
    expect(api.closeWindow).not.toHaveBeenCalled();
  });

  it('rejects a pending close if a new tab is opened during confirmation', async () => {
    open('/A.md'); edit('edit');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const close = app.prepareToClose(); open('/B.md');
    gate.resolve({ action: 'dont-save' });
    expect(await close).toBe(false);
  });

  it('retains discarded drafts for a later cancellation in another window and invalidates approval on editing', async () => {
    const a = open('/A.md'); edit('recoverable'); await vi.advanceTimersByTimeAsync(1500);
    expect(await app.prepareToClose()).toBe(true);
    expect(app.isPreparedToClose()).toBe(true);
    expect(drafts.get(a.draftId).content).toBe('recoverable');
    edit('new edit'); expect(app.isPreparedToClose()).toBe(false);
  });

  it('handles repeated window requests and rejected native dialogs without losing edits', async () => {
    const a = open('/A.md'); edit('keep');
    const gate = deferred(); api.confirmSaveDialog.mockReturnValueOnce(gate.promise);
    const first = app.prepareToClose(); const second = app.prepareToClose();
    gate.reject(new Error('Dialog unavailable'));
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(api.confirmSaveDialog).toHaveBeenCalledTimes(1);
    expect(a.isEdited).toBe(true);
    expect(await app.prepareToClose()).toBe(true);
  });

  it('resumes automatic saving when another window cancels application quit', async () => {
    open('/A.md'); app.currentSettings.saveMode = 'auto'; edit('still editing');
    expect(await app.prepareToClose()).toBe(true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(disk.get('/A.md')).toBe('A baseline');
    app.cancelClosePreparation();
    expect(app.isPreparedToClose()).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(disk.get('/A.md')).toBe('still editing');
  });
});

describe('Opening and rerendering without losing document state', () => {
  it('retains all concurrent file opens even when responses arrive out of order', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    api.readFile.mockImplementation((path: string) => { const gate = deferred(); gates.set(path, gate); return gate.promise; });
    const pending = ['/A.md', '/B.md', '/C.md'].map(path => app.loadFile(path));
    for (const path of ['/C.md', '/A.md', '/B.md']) {
      gates.get(path)!.resolve({ success: true, content: disk.get(path) });
      await Promise.resolve();
    }
    await Promise.all(pending);
    expect(app.tabs.map((tab: any) => tab.filePath).sort()).toEqual(['/A.md', '/B.md', '/C.md']);
    expect(app.activeTab.filePath).toBe('/C.md');
  });

  it('deduplicates simultaneous opens of the same path', async () => {
    const gate = deferred(); api.readFile.mockReturnValueOnce(gate.promise);
    const first = app.loadFile('/A.md'); const second = app.loadFile('/A.md');
    gate.resolve({ success: true, content: 'A baseline' }); await Promise.all([first, second]);
    expect(api.readFile).toHaveBeenCalledTimes(1);
    expect(app.tabs).toHaveLength(1);
  });

  it('retains the original dirty tab when opening another document', async () => {
    const a = open('/A.md'); edit('unsaved A');
    await app.loadFile('/B.md');
    expect(a.isEdited).toBe(true); expect(a.rawContent).toBe('unsaved A');
    expect(app.tabs).toHaveLength(2);
    expect(api.confirmSaveDialog).not.toHaveBeenCalled();
    expect(api.setDocumentEdited).toHaveBeenLastCalledWith(true);
  });

  it('preserves original Markdown syntax when viewing source without editing', () => {
    const raw = '<!-- retained -->\n\n[link][ref]\n\n[ref]: https://example.com\n';
    const a = open('/A.md'); a.rawContent = raw; a.isSourceMode = false; a.isEditMode = false;
    app.toggleSourceView();
    expect(a.rawContent).toBe(raw); expect(app.sourceTextareaEl.value).toBe(raw);
    expect(a.isEdited).toBe(false);
  });

  it('caches rendered edits before changing image rendering and defers changes during composition', () => {
    const a = open('/A.md'); a.isSourceMode = false; a.isEdited = true;
    app.markdownBodyEl = '<h1>Unsaved rendered edit</h1>';
    app.renderActiveTabContent.mockClear(); app.isComposing = true;
    app.refreshRemoteImages();
    expect(app.renderActiveTabContent).not.toHaveBeenCalled();
    app.isComposing = false; app.refreshRemoteImages();
    expect(a.rawContent).toBe('# Unsaved rendered edit\n');
    expect(a.scrollRatio).toBe(0.5); expect(a.isEdited).toBe(true);
  });
});
