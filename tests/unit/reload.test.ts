import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let MoReadApp: typeof import('../../src/renderer/main.ts').MoReadApp;
let app: any;
let tab: any;
let api: any;

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});

beforeEach(() => {
  tab = { id: 'one', filePath: '/one.md', rawContent: 'original', savedContent: 'original',
    revision: 'r1', editRevision: 0, isEdited: false, scrollRatio: 0 };
  api = { readFile: vi.fn(async () => ({ success: true, content: 'external', stats: { revision: 'r2' } })) };
  window.electronAPI = api;
  app = Object.assign(Object.create(MoReadApp.prototype), {
    tabs: [tab], activeTabId: tab.id, reloadRequests: new WeakMap(), saveInFlight: null,
    renderActiveTabContent: vi.fn(), markAsSaved: vi.fn(), pauseAutoSave: vi.fn(), showError: vi.fn(),
    getScrollRatio: vi.fn(() => 0.7),
    conflictBannerEl: { classList: { add: vi.fn(), remove: vi.fn() }, style: {} }
  });
});

function pendingRead() {
  let resolve!: (value: any) => void;
  api.readFile.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const done = app.reloadTabFromDisk(tab);
  return { done, finish: (content = 'external') => resolve({ success: true, content, stats: { revision: 'r2' } }) };
}

describe('Disk reload safety and reading position', () => {
  it('ignores identical content and refreshes its metadata revision without rendering', async () => {
    api.readFile.mockResolvedValue({ success: true, content: 'original', stats: { revision: 'metadata-r2' } });
    await app.reloadTabFromDisk(tab);
    expect(app.renderActiveTabContent).not.toHaveBeenCalled();
    expect(app.markAsSaved).not.toHaveBeenCalled();
    expect(tab.revision).toBe('metadata-r2');
  });

  it('captures the latest scroll after the asynchronous read finishes', async () => {
    const read = pendingRead();
    app.getScrollRatio.mockReturnValue(0.85);
    read.finish(); await read.done;
    expect(tab.scrollRatio).toBe(0.85);
    expect(tab.rawContent).toBe('external');
    expect(app.renderActiveTabContent).toHaveBeenCalledOnce();
  });

  it('reloads an inactive tab without changing the visible tab or its saved position', async () => {
    app.activeTabId = 'two'; tab.scrollRatio = 0.45;
    await app.reloadTabFromDisk(tab);
    expect(tab.scrollRatio).toBe(0.45);
    expect(tab.rawContent).toBe('external');
    expect(app.renderActiveTabContent).not.toHaveBeenCalled();
  });

  it('protects edits made during an automatic read and reports a real conflict', async () => {
    const read = pendingRead();
    tab.isEdited = true; tab.editRevision++; tab.rawContent = 'local';
    read.finish(); await read.done;
    expect(tab.rawContent).toBe('local'); expect(tab.savedContent).toBe('original');
    expect(tab.externalConflict).toBe(true); expect(app.pauseAutoSave).toHaveBeenCalledOnce();
  });

  it('does not pause autosave for metadata-only notifications on dirty tabs', async () => {
    tab.isEdited = true; tab.rawContent = 'local';
    api.readFile.mockResolvedValue({ success: true, content: 'original', stats: { revision: 'r2' } });
    await app.reloadTabFromDisk(tab);
    expect(tab.rawContent).toBe('local'); expect(tab.isEdited).toBe(true);
    expect(app.pauseAutoSave).not.toHaveBeenCalled(); expect(tab.revision).toBe('r2');
  });

  it('rejects an older result arriving after a newer reload', async () => {
    const first = pendingRead();
    await app.reloadTabFromDisk(tab);
    first.finish('stale'); await first.done;
    expect(tab.rawContent).toBe('external'); expect(app.renderActiveTabContent).toHaveBeenCalledOnce();
  });

  it('rejects an older result even when the newer read fails', async () => {
    const first = pendingRead();
    api.readFile.mockResolvedValueOnce({ success: false, error: 'missing' });
    await app.reloadTabFromDisk(tab);
    first.finish('stale'); await first.done;
    expect(tab.rawContent).toBe('original'); expect(app.showError).toHaveBeenCalledWith('missing');
  });

  it('ignores results after the tab closes', async () => {
    const read = pendingRead(); app.tabs = []; read.finish(); await read.done;
    expect(tab.rawContent).toBe('original');
  });

  it('ignores results after Save As changes the tab path', async () => {
    const read = pendingRead(); tab.filePath = '/renamed.md'; read.finish(); await read.done;
    expect(tab.rawContent).toBe('original');
  });

  it('ignores reads concurrent with saving', async () => {
    const read = pendingRead(); app.saveInFlight = Promise.resolve(true); read.finish(); await read.done;
    expect(tab.rawContent).toBe('original');
  });

  it('ignores reads predating a completed save', async () => {
    const read = pendingRead(); tab.revision = 'saved-r3'; read.finish(); await read.done;
    expect(tab.revision).toBe('saved-r3'); expect(tab.rawContent).toBe('original');
  });

  it('explicitly discards old edits only after a successful read', async () => {
    tab.isEdited = true; tab.rawContent = 'local';
    await app.reloadTabFromDisk(tab, true);
    expect(tab.rawContent).toBe('external'); expect(tab.isEdited).toBe(false);
  });

  it('re-renders explicit discard even if rawContent lags behind edited DOM', async () => {
    tab.isEdited = true;
    api.readFile.mockResolvedValue({ success: true, content: 'original', stats: { revision: 'r2' } });
    await app.reloadTabFromDisk(tab, true);
    expect(app.renderActiveTabContent).toHaveBeenCalledOnce();
  });

  it('protects new edits made after confirming discard', async () => {
    let finish!: (value: any) => void;
    api.readFile.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    tab.isEdited = true;
    const done = app.reloadTabFromDisk(tab, true);
    tab.editRevision++; tab.rawContent = 'new local';
    finish({ success: true, content: 'external' }); await done;
    expect(tab.rawContent).toBe('new local'); expect(tab.isEdited).toBe(true);
  });

  it('keeps local edits when reading fails or the bridge rejects', async () => {
    tab.isEdited = true; tab.rawContent = 'local';
    api.readFile.mockResolvedValueOnce({ success: false, error: 'not found' });
    await app.reloadTabFromDisk(tab, true);
    api.readFile.mockRejectedValueOnce(new Error('timeout'));
    await app.reloadTabFromDisk(tab, true);
    expect(tab.rawContent).toBe('local'); expect(tab.isEdited).toBe(true);
    expect(app.showError).toHaveBeenCalledTimes(2);
  });
});
