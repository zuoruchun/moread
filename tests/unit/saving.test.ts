import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let MoReadApp: typeof import('../../src/renderer/main.ts').MoReadApp;
let app: any;
let disk: string;
let api: any;

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});

beforeEach(() => {
  vi.useFakeTimers();
  disk = '# Original\n';
  api = {
    readFile: vi.fn(async () => ({ success: true, content: disk, stats: { size: disk.length, revision: 'disk-revision' } })),
    writeFile: vi.fn(async (_path: string, content: string) => {
      disk = content;
      return { success: true, stats: { size: content.length } };
    }),
    setDocumentEdited: vi.fn(async () => ({ success: true })),
    confirmSaveDialog: vi.fn(async () => ({ action: 'save' })),
    closeWindow: vi.fn(async () => ({ success: true }))
  };
  window.electronAPI = api;
  app = Object.assign(Object.create(MoReadApp.prototype), {
    currentFilePath: '/fixture.md', currentRawContent: disk, lastSavedContent: disk,
    currentSettings: { saveMode: 'manual' }, isSourceMode: true, isEdited: false,
    isComposing: false, editRevision: 0, autoSavePaused: false,
    autoSaveTimeout: null, saveInFlight: null, savedBadgeTimeout: null,
    sourceTextareaEl: { value: disk }, docTitleEl: { textContent: '' },
    statusFileSizeEl: { textContent: '' }, statusStatsEl: { textContent: '' },
    statusSaveBadgeEl: { textContent: '', className: '', style: {} },
    errorBannerEl: { textContent: '', style: {}, classList: { add: vi.fn(), remove: vi.fn() } }
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function edit(value: string) {
  app.sourceTextareaEl.value = value;
  app.markAsEdited();
}

describe('Manual and automatic saving', () => {
  it('keeps manual mode unsaved until explicitly saved and skips unmodified files', async () => {
    expect(await app.saveCurrentFile()).toBe(true);
    expect(api.writeFile).not.toHaveBeenCalled();
    edit('# Edited\n');
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(await app.saveCurrentFile()).toBe(true);
    expect(disk).toBe('# Edited\n');
    expect(app.isEdited).toBe(false);
    expect(api.writeFile).toHaveBeenCalledWith('/fixture.md', '# Edited\n', 'disk-revision');
  });

  it('debounces edits and saves only the latest content after one idle second', async () => {
    app.currentSettings.saveMode = 'auto';
    edit('first');
    await vi.advanceTimersByTimeAsync(700);
    edit('second');
    await vi.advanceTimersByTimeAsync(999);
    expect(api.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(disk).toBe('second');
    expect(app.isEdited).toBe(false);
  });

  it('cancels a pending automatic write when switching back to manual saving', async () => {
    app.currentSettings.saveMode = 'auto';
    edit('pending');
    app.currentSettings.saveMode = 'manual';
    app.cancelAutoSave();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(app.isEdited).toBe(true);
  });

  it('does not save incomplete composition, then saves after composition ends', async () => {
    app.currentSettings.saveMode = 'auto';
    app.isComposing = true;
    edit('中文');
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.writeFile).not.toHaveBeenCalled();
    app.isComposing = false;
    app.scheduleAutoSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk).toBe('中文');
  });

  it('retains edits after failure, pauses automatic retries, and permits manual retry', async () => {
    app.currentSettings.saveMode = 'auto';
    api.writeFile.mockResolvedValueOnce({ success: false, error: 'Permission denied' });
    edit('keep me');
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.isEdited).toBe(true);
    expect(app.errorBannerEl.textContent).toBe('Permission denied');
    expect(app.autoSavePaused).toBe(true);
    edit('keep latest');
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(await app.saveCurrentFile()).toBe(true);
    expect(disk).toBe('keep latest');
    expect(app.autoSavePaused).toBe(false);
  });

  it('catches bridge errors without losing local edits or issuing automatic retries', async () => {
    app.currentSettings.saveMode = 'auto';
    api.readFile.mockRejectedValueOnce(new Error('Timed out'));
    edit('local');
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.isEdited).toBe(true);
    expect(app.errorBannerEl.textContent).toContain('Timed out');
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('does not overwrite a file changed or deleted externally', async () => {
    app.currentSettings.saveMode = 'auto';
    edit('local');
    disk = 'external';
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(app.isEdited).toBe(true);
    expect(disk).toBe('external');
    api.readFile.mockResolvedValueOnce({ success: false, error: 'File missing' });
    expect(await app.saveCurrentFile()).toBe(false);
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('does not acknowledge edits made while an older save is in flight', async () => {
    let complete!: () => void;
    api.writeFile.mockImplementationOnce(async (_path: string, content: string) => {
      await new Promise<void>(resolve => { complete = resolve; });
      disk = content;
      return { success: true };
    });
    edit('snapshot');
    const pending = app.saveCurrentFile();
    await Promise.resolve();
    edit('newer');
    complete();
    expect(await pending).toBe(false);
    expect(app.isEdited).toBe(true);
    expect(app.sourceTextareaEl.value).toBe('newer');
    expect(await app.saveCurrentFile()).toBe(true);
    expect(disk).toBe('newer');
  });

  it('serializes duplicate save requests without duplicate writes', async () => {
    edit('once');
    expect(await Promise.all([app.saveCurrentFile(), app.saveCurrentFile()])).toEqual([true, true]);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it('blocks file switching and closing after a failed requested save', async () => {
    edit('unsaved');
    api.writeFile.mockResolvedValue({ success: false, error: 'Permission denied' });
    await app.loadFile('/next.md');
    expect(app.currentFilePath).toBe('/fixture.md');
    expect(api.readFile).toHaveBeenCalledTimes(1);
    await app.handleRequestClose();
    expect(api.closeWindow).not.toHaveBeenCalled();
    expect(app.isEdited).toBe(true);
  });
});
