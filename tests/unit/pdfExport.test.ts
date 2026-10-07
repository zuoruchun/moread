import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPDFSnapshot } from '../../src/renderer/modules/pdfExport.ts';

describe('Isolated PDF snapshot', () => {
  it('contains formatted code and math, without application chrome or scripts', () => {
    const snapshot = createPDFSnapshot('# 中文\n\n```python\nprint("hello")\n```\n\n$$x^2$$', '<unsafe>.md', {});
    expect(snapshot.html).toContain('hljs-string');
    expect(snapshot.html).toContain('mjx-container');
    expect(snapshot.html).toContain('&lt;unsafe&gt;.md');
    expect(snapshot.html).not.toMatch(/<button|<textarea|<script|id="app"/);
    expect(snapshot.html).toContain('min-height: 0');
  });

  it('blocks remote images even for untitled documents; enabled images load eagerly', () => {
    const content = '![private](https://example.invalid/private.png)';
    const blocked = createPDFSnapshot(content, '未命名', { allowRemoteImages: false });
    expect(blocked.html).toContain('远程图片已拦截');
    expect(blocked.html).not.toContain('<img');
    const enabled = createPDFSnapshot(content, '未命名', { allowRemoteImages: true });
    expect(enabled.html).toContain('loading="eager"');
    expect(enabled.html).toContain('img-src data: mored: https: http:');
  });

  it('resolves local images relative to the snapshot file, including spaces and Chinese names', () => {
    const snapshot = createPDFSnapshot('![local](<图 片.png>)', 'a.md', { currentFilePath: '/tmp/测试/a.md' });
    expect(snapshot.filePath).toBe('/tmp/测试/a.md');
    expect(snapshot.html).toContain(encodeURIComponent('/tmp/测试/图 片.png'));
  });
});

let MoReadApp: typeof import('../../src/renderer/main.ts').MoReadApp;
beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ MoReadApp } = await import('../../src/renderer/main.ts'));
});

describe('PDF export preserves editor state', () => {
  it('exports live source without changing the tab, saved state or editor DOM', () => {
    const tab = { id: '1', title: 'draft.md', filePath: '/tmp/draft.md', rawContent: 'old', savedContent: 'old', isEdited: true, isSourceMode: true };
    const app = Object.assign(Object.create(MoReadApp.prototype), {
      tabs: [tab], activeTabId: '1', currentSettings: { allowRemoteImages: false },
      sourceTextareaEl: { value: '# UNSAVED' }, markdownBodyEl: { innerHTML: 'do not touch' }
    });
    const before = JSON.stringify(tab);
    const result = app.prepareForPDFExport();
    expect(result.html).toContain('UNSAVED');
    expect(JSON.stringify(tab)).toBe(before);
    expect(app.markdownBodyEl.innerHTML).toBe('do not touch');
    expect(app.sourceTextareaEl.value).toBe('# UNSAVED');
  });

  it('uses original Markdown for an unedited rendered document and rejects the welcome screen', () => {
    const app = Object.assign(Object.create(MoReadApp.prototype), {
      tabs: [{ id: '1', title: 'read.md', filePath: null, rawContent: '# ORIGINAL', isEdited: false, isSourceMode: false }],
      activeTabId: '1', currentSettings: {}, markdownBodyEl: null
    });
    expect(app.prepareForPDFExport().html).toContain('ORIGINAL');
    app.activeTabId = null;
    expect(app.prepareForPDFExport()).toBeNull();
  });
});
