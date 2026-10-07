import { parseMarkdown, extractHeadings } from './modules/parser.ts';
import { htmlToMarkdown } from './modules/editor.ts';
import { bindCodeBlockEditing, readCodeBlock } from './modules/codeBlocks.ts';
import { OutlineController } from './modules/outline.ts';
import { SearchController } from './modules/search.ts';
import { FileTreeController } from './modules/fileTree.ts';
import { initNativeBridge, BridgeAPI } from './modules/bridge.ts';

// Initialize bridge (supports both WKWebView Native and Electron)
initNativeBridge();

// Type declaration for API injected by bridge / preload
declare global {
  interface Window {
    electronAPI: BridgeAPI;
    moreadApp?: MoReadApp;
  }
}

export class MoReadApp {
  public currentFilePath: string | null = null;
  public currentRawContent: string = '';
  public currentSettings: any = {};
  public renderSessionId: number = 0;
  public isSourceMode: boolean = false;
  public isEdited: boolean = false;
  private savedBadgeTimeout: ReturnType<typeof setTimeout> | null = null;
  private fileTreeRootPath: string | null = null;
  private folderRequestId = 0;

  // Controllers
  public outlineController!: OutlineController;
  public searchController!: SearchController;
  public fileTreeController!: FileTreeController;

  // DOM Elements
  public docTitleEl!: HTMLElement;
  public docPathEl!: HTMLElement;
  public errorBannerEl!: HTMLElement;
  public welcomeViewEl!: HTMLElement;
  public markdownScrollWrapperEl!: HTMLElement;
  public markdownBodyWrapperEl!: HTMLElement;
  public markdownBodyEl!: HTMLElement;
  public sourceViewEl!: HTMLElement;
  public sourceTextareaEl!: HTMLTextAreaElement;
  public sidebarEl!: HTMLElement;
  public outlineTabBtn!: HTMLButtonElement;
  public filesTabBtn!: HTMLButtonElement;
  public outlineContentEl!: HTMLElement;
  public filesContentEl!: HTMLElement;
  public recentListEl!: HTMLElement;

  // Status Elements
  public statusFileSizeEl!: HTMLElement;
  public statusStatsEl!: HTMLElement;
  public statusModeBtnEl!: HTMLElement;
  public statusSaveBadgeEl!: HTMLElement;

  // Header Elements
  public selectThemeEl!: HTMLSelectElement;
  public selectWidthEl!: HTMLSelectElement;
  public btnToggleSourceEl!: HTMLButtonElement;
  public btnToggleSidebarEl!: HTMLButtonElement;
  public settingsDialogEl!: HTMLDialogElement;
  public settingsFontSizeEl!: HTMLInputElement;

  constructor() {
    this.initElements();
    this.initControllers();
    this.initEventListeners();
    this.initApp();
    window.moreadApp = this;
  }

  private initElements(): void {
    this.docTitleEl = document.getElementById('doc-title')!;
    this.docPathEl = document.getElementById('doc-path')!;
    this.errorBannerEl = document.getElementById('error-banner')!;
    this.welcomeViewEl = document.getElementById('welcome-view')!;
    this.markdownScrollWrapperEl = document.getElementById('markdown-scroll-wrapper')!;
    this.markdownBodyWrapperEl = document.getElementById('markdown-body-wrapper')!;
    this.markdownBodyEl = document.getElementById('markdown-body')!;
    this.sourceViewEl = document.getElementById('source-view')!;
    this.sourceTextareaEl = document.getElementById('source-textarea') as HTMLTextAreaElement;
    this.sidebarEl = document.getElementById('app-sidebar')!;
    this.outlineTabBtn = document.getElementById('tab-outline') as HTMLButtonElement;
    this.filesTabBtn = document.getElementById('tab-files') as HTMLButtonElement;
    this.outlineContentEl = document.getElementById('sidebar-outline-content')!;
    this.filesContentEl = document.getElementById('sidebar-files-content')!;
    this.recentListEl = document.getElementById('recent-list')!;

    this.statusFileSizeEl = document.getElementById('status-file-size')!;
    this.statusStatsEl = document.getElementById('status-stats')!;
    this.statusModeBtnEl = document.getElementById('status-mode')!;
    this.statusSaveBadgeEl = document.getElementById('status-save-badge')!;

    this.selectThemeEl = document.getElementById('select-theme') as HTMLSelectElement;
    this.selectWidthEl = document.getElementById('select-reading-width') as HTMLSelectElement;
    this.btnToggleSourceEl = document.getElementById('btn-toggle-source') as HTMLButtonElement;
    this.btnToggleSidebarEl = document.getElementById('btn-toggle-sidebar') as HTMLButtonElement;
    this.settingsDialogEl = document.getElementById('reading-settings') as HTMLDialogElement;
    this.settingsFontSizeEl = document.getElementById('settings-font-size') as HTMLInputElement;

    this.markdownBodyEl.contentEditable = 'true';
    this.markdownBodyEl.spellcheck = false;
  }

  private initControllers(): void {
    this.outlineController = new OutlineController(
      this.outlineContentEl,
      this.markdownScrollWrapperEl
    );

    const searchBar = document.getElementById('search-bar')!;
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    const searchCount = document.getElementById('search-count')!;
    const btnSearchPrev = document.getElementById('btn-search-prev') as HTMLButtonElement;
    const btnSearchNext = document.getElementById('btn-search-next') as HTMLButtonElement;
    const btnSearchClose = document.getElementById('btn-search-close') as HTMLButtonElement;

    this.searchController = new SearchController(
      this.markdownBodyEl,
      searchBar,
      searchInput,
      searchCount,
      btnSearchPrev,
      btnSearchNext,
      btnSearchClose
    );

    this.fileTreeController = new FileTreeController(this.filesContentEl, (filePath) => {
      this.loadFile(filePath);
    });
  }

  private async initApp(): Promise<void> {
    const api = window.electronAPI;
    if (api) {
      api.onOpenFile((filePath) => this.loadFile(filePath));
      api.onOpenFolder?.(async (folderPath) => {
        if (await this.loadFolderTree(folderPath)) {
          this.switchSidebarTab('files', true);
          this.showSidebar();
          this.saveSetting({ showSidebar: true });
        }
      });
      api.onFileChanged((changedPath) => {
        if (this.currentFilePath === changedPath && !this.isEdited) {
          this.reloadCurrentFilePreservingScroll();
        }
      });
      api.onMenuAction((action) => this.handleMenuAction(action));

      try {
        this.currentSettings = await api.getSettings();
        this.applySettings(this.currentSettings);
        this.renderRecentList(this.currentSettings.recentFiles || []);
      } catch (error) {
        console.error('Failed to load settings:', error);
        this.currentSettings = {
          theme: 'system',
          readingWidth: 'standard',
          fontSize: 16,
          recentFiles: []
        };
        this.applySettings(this.currentSettings);
      } finally {
        try {
          await api.rendererReady();
        } catch (error) {
          console.error('Failed to notify native host that the renderer is ready:', error);
        }
      }
    }
  }

  private initEventListeners(): void {
    // Welcome screen actions
    document.getElementById('btn-welcome-open-file')?.addEventListener('click', () => this.triggerOpenFile());
    document.getElementById('btn-welcome-open-folder')?.addEventListener('click', () => this.triggerOpenFolder());
    document.getElementById('btn-clear-recent')?.addEventListener('click', async () => {
      if (window.electronAPI) {
        this.currentSettings = { ...this.currentSettings, recentFiles: [] };
        await window.electronAPI.saveSettings({ recentFiles: [] });
        this.renderRecentList([]);
      }
    });

    // Toolbar actions
    this.btnToggleSidebarEl.addEventListener('click', () => this.toggleSidebar());
    this.btnToggleSourceEl.addEventListener('click', () => this.toggleSourceView());
    document.getElementById('btn-search')?.addEventListener('click', () => this.searchController.open());

    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.settingsDialogEl.close());
    this.settingsFontSizeEl.addEventListener('change', () => {
      const value = Number(this.settingsFontSizeEl.value);
      if (Number.isFinite(value) && this.settingsFontSizeEl.value !== '') {
        this.setFontSize(value);
      } else {
        this.settingsFontSizeEl.value = String(this.currentSettings.fontSize || 16);
      }
    });

    // Theme and Width selects
    this.selectThemeEl.addEventListener('change', () => {
      const theme = this.selectThemeEl.value;
      this.applyTheme(theme);
      this.saveSetting({ theme });
    });

    this.selectWidthEl.addEventListener('change', () => {
      const width = this.selectWidthEl.value;
      this.applyWidth(width);
      this.saveSetting({ readingWidth: width });
    });

    // Sidebar tabs
    this.outlineTabBtn.addEventListener('click', () => this.switchSidebarTab('outline', true));
    this.filesTabBtn.addEventListener('click', () => this.switchSidebarTab('files', true));

    const appHeader = document.querySelector('.app-header');
    appHeader?.addEventListener('mousedown', (event) => {
      const mouseEvent = event as MouseEvent;
      const target = event.target as HTMLElement;
      if (mouseEvent.button !== 0 || target.closest('button, select, input, textarea, a')) return;
      window.electronAPI?.beginWindowDrag().catch((error) => {
        console.error('Failed to begin native window drag:', error);
      });
    });

    // System theme change listener
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.currentSettings.theme === 'system') {
        this.applyTheme('system');
      }
    });

    // Global keyboard shortcuts (Cmd+S for Save, Cmd+Shift+S for Mode toggle)
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        this.openSettings();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) {
          this.toggleSourceView();
        } else {
          this.saveCurrentFile();
        }
      }
    });

    // WYSIWYG Editing listeners on markdown body
    bindCodeBlockEditing(this.markdownBodyEl);
    this.markdownBodyEl.addEventListener('input', (e) => this.handleEditorInput(e));
    this.markdownBodyEl.addEventListener('click', (e) => this.handleContentClick(e));

    // Source textarea editing listeners
    this.sourceTextareaEl.addEventListener('input', () => {
      this.markAsEdited();
      this.updateStatsFromText(this.sourceTextareaEl.value);
    });

    // Tab key handling in source textarea
    this.sourceTextareaEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = this.sourceTextareaEl;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const val = textarea.value;

        if (!e.shiftKey) {
          textarea.value = val.substring(0, start) + '  ' + val.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        } else {
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          if (val.substring(lineStart, lineStart + 2) === '  ') {
            textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
            textarea.selectionStart = Math.max(lineStart, start - 2);
            textarea.selectionEnd = Math.max(lineStart, end - 2);
          }
        }
        this.markAsEdited();
        this.updateStatsFromText(this.sourceTextareaEl.value);
      }
    });
  }

  private handleContentClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // 1. Task list item checkbox toggle
    if (target.classList.contains('task-list-item-checkbox')) {
      this.markAsEdited();
      return;
    }

    // 2. Code copy button
    if (target.classList.contains('code-copy-btn')) {
      const container = target.closest('.code-block-container');
      const rawCode = container ? readCodeBlock(container) : '';
      navigator.clipboard.writeText(rawCode).then(() => {
        const originalText = target.textContent;
        target.textContent = '已复制!';
        target.classList.add('copied');
        setTimeout(() => {
          target.textContent = originalText;
          target.classList.remove('copied');
        }, 1500);
      });
      return;
    }

    // 3. Links: require Cmd/Ctrl click to follow, preserving text cursor on simple click
    const anchor = target.closest('a');
    if (anchor) {
      const isModifier = e.metaKey || e.ctrlKey;
      if (isModifier) {
        e.preventDefault();
        const href = anchor.getAttribute('href') || '';
        if (href.startsWith('#')) {
          const id = href.slice(1);
          this.outlineController.scrollToHeading(id);
        } else if (href.startsWith('http://') || href.startsWith('https://')) {
          window.electronAPI?.openExternal(href);
        } else if (href.endsWith('.md') || href.endsWith('.markdown') || href.includes('.md#') || href.includes('.markdown#')) {
          this.handleRelativeDocLink(href);
        }
      } else {
        // Prevent accidental page navigation while clicking inside link to edit
        e.preventDefault();
      }
    }
  }

  private handleRelativeDocLink(href: string): void {
    if (!this.currentFilePath) return;
    const [relPath, anchor] = href.split('#');
    const currentDir = this.currentFilePath.substring(0, this.currentFilePath.lastIndexOf('/'));
    const targetPath = relPath.startsWith('/') ? relPath : `${currentDir}/${relPath}`;

    this.loadFile(targetPath).then(() => {
      if (anchor) {
        setTimeout(() => this.outlineController.scrollToHeading(anchor), 150);
      }
    });
  }

  public async loadFile(filePath: string): Promise<void> {
    if (!window.electronAPI) return;

    if (this.isEdited && this.currentFilePath && this.currentFilePath !== filePath) {
      const fileName = this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) || '当前文档';
      const res = await window.electronAPI.confirmSaveDialog(fileName);
      if (res.action === 'save') {
        await this.saveCurrentFile();
      } else if (res.action === 'cancel') {
        return;
      }
    }

    const thisSessionId = ++this.renderSessionId;
    this.hideError();

    const res = await window.electronAPI.readFile(filePath);

    if (thisSessionId !== this.renderSessionId) return;

    if (!res.success || res.content === undefined) {
      this.showError(res.error || '无法打开此文件');
      return;
    }

    this.currentFilePath = filePath;
    this.currentRawContent = res.content;
    this.markAsSaved();
    this.recordRecentFile(filePath);

    // Update title and path
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    this.docTitleEl.textContent = fileName;
    this.docPathEl.textContent = filePath;
    this.docPathEl.title = filePath;

    // Update status bar
    const sizeKb = ((res.stats?.size || 0) / 1024).toFixed(1);
    this.statusFileSizeEl.textContent = `${sizeKb} KB`;

    this.updateStatsFromText(res.content);

    // Render Markdown with readonly: false for interactive checkboxes
    const renderedHtml = parseMarkdown(res.content, {
      currentFilePath: filePath,
      allowRemoteImages: this.currentSettings.allowRemoteImages,
      readonly: false
    });

    if (thisSessionId !== this.renderSessionId) return;

    this.markdownBodyEl.innerHTML = renderedHtml;
    this.sourceTextareaEl.value = res.content;

    // Extract headings and update outline
    const headings = extractHeadings(res.content);
    this.outlineController.update(headings);

    // Update search base
    this.searchController.setContentBase(renderedHtml);

    // Update views visibility
    this.welcomeViewEl.classList.add('hidden');
    this.welcomeViewEl.style.display = 'none';

    if (this.isSourceMode) {
      this.sourceViewEl.classList.remove('hidden');
      this.sourceViewEl.style.display = 'block';
      this.markdownScrollWrapperEl.classList.add('hidden');
      this.markdownScrollWrapperEl.style.display = 'none';
      if (this.statusModeBtnEl) this.statusModeBtnEl.textContent = '[源码模式]';
    } else {
      this.markdownScrollWrapperEl.classList.remove('hidden');
      this.markdownScrollWrapperEl.style.display = 'flex';
      this.sourceViewEl.classList.add('hidden');
      this.sourceViewEl.style.display = 'none';
      if (this.statusModeBtnEl) this.statusModeBtnEl.textContent = '[所见即所得]';
    }

    // Scroll to top
    this.markdownScrollWrapperEl.scrollTop = 0;

    // Update file tree active item
    this.fileTreeController.setCurrentFile(filePath);
    const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    const rootPath = this.fileTreeRootPath && filePath.startsWith(`${this.fileTreeRootPath.replace(/\/$/, '')}/`)
      ? this.fileTreeRootPath : parentPath;
    await this.loadFolderTree(rootPath, thisSessionId);
  }

  private async loadFolderTree(folderPath: string, renderSessionId?: number): Promise<boolean> {
    const requestId = ++this.folderRequestId;
    try {
      const result = await window.electronAPI.readFolder(folderPath);
      if (requestId !== this.folderRequestId ||
          (renderSessionId !== undefined && renderSessionId !== this.renderSessionId)) return false;
      if (!result.success || !result.nodes) throw new Error(result.error || '无法读取目录');
      this.fileTreeRootPath = folderPath;
      const currentPath = this.currentFilePath?.startsWith(`${folderPath.replace(/\/$/, '')}/`)
        ? this.currentFilePath : null;
      this.fileTreeController.update(result.nodes, currentPath);
      return true;
    } catch (error) {
      if (requestId !== this.folderRequestId ||
          (renderSessionId !== undefined && renderSessionId !== this.renderSessionId)) return false;
      const path = this.currentFilePath;
      this.fileTreeRootPath = null;
      this.fileTreeController.update(path ? [{ name: path.split('/').pop()!, path, isDirectory: false }] : [], path);
      const note = document.createElement('div');
      note.className = 'file-tree-empty';
      const detail = error instanceof Error ? error.message : '请重新打开文件夹';
      note.textContent = `无法读取文件夹，当前仅显示已打开的文件：${detail}`;
      this.filesContentEl.appendChild(note);
      return false;
    }
  }

  private async reloadCurrentFilePreservingScroll(): Promise<void> {
    if (!this.currentFilePath) return;

    const scrollEl = this.markdownScrollWrapperEl;
    const currentScrollRatio = scrollEl.scrollHeight > 0 ? scrollEl.scrollTop / scrollEl.scrollHeight : 0;

    await this.loadFile(this.currentFilePath);

    requestAnimationFrame(() => {
      scrollEl.scrollTop = currentScrollRatio * scrollEl.scrollHeight;
    });
  }

  public async triggerOpenFile(): Promise<void> {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openFileDialog();
    if (!res.canceled && res.filePath) {
      this.loadFile(res.filePath);
    }
  }

  public async triggerOpenFolder(): Promise<void> {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openFolderDialog();
    if (!res.canceled && res.folderPath) {
      if (await this.loadFolderTree(res.folderPath)) {
        this.switchSidebarTab('files', true);
        this.showSidebar();
        this.saveSetting({ showSidebar: true });
      }
    }
  }

  public toggleSidebar(): void {
    if (this.sidebarEl.classList.contains('collapsed')) {
      this.showSidebar();
      this.saveSetting({ showSidebar: true });
    } else {
      this.hideSidebar();
      this.saveSetting({ showSidebar: false });
    }
  }

  public showSidebar(): void {
    this.sidebarEl.classList.remove('collapsed');
    this.btnToggleSidebarEl.classList.add('active');
    this.btnToggleSidebarEl.setAttribute('aria-expanded', 'true');
  }

  public hideSidebar(): void {
    this.sidebarEl.classList.add('collapsed');
    this.btnToggleSidebarEl.classList.remove('active');
    this.btnToggleSidebarEl.setAttribute('aria-expanded', 'false');
  }

  public toggleOutline(): void {
    if (this.sidebarEl.classList.contains('collapsed')) {
      this.switchSidebarTab('outline', true);
      this.showSidebar();
      this.saveSetting({ showSidebar: true });
    } else if (this.outlineTabBtn.classList.contains('active')) {
      this.hideSidebar();
      this.saveSetting({ showSidebar: false });
    } else {
      this.switchSidebarTab('outline', true);
    }
  }

  public switchSidebarTab(tab: 'outline' | 'files', persist = false): void {
    this.outlineTabBtn.setAttribute('aria-selected', String(tab === 'outline'));
    this.filesTabBtn.setAttribute('aria-selected', String(tab === 'files'));
    if (persist) this.saveSetting({ sidebarTab: tab });
    if (tab === 'outline') {
      this.outlineTabBtn.classList.add('active');
      this.filesTabBtn.classList.remove('active');
      this.outlineContentEl.classList.remove('hidden');
      this.outlineContentEl.style.display = 'block';
      this.filesContentEl.classList.add('hidden');
      this.filesContentEl.style.display = 'none';
    } else {
      this.filesTabBtn.classList.add('active');
      this.outlineTabBtn.classList.remove('active');
      this.filesContentEl.classList.remove('hidden');
      this.filesContentEl.style.display = 'block';
      this.outlineContentEl.classList.add('hidden');
      this.outlineContentEl.style.display = 'none';
    }
  }

  public toggleSourceView(): void {
    this.isSourceMode = !this.isSourceMode;
    if (this.isSourceMode) {
      // Switching from WYSIWYG to Source Mode
      const markdown = htmlToMarkdown(this.markdownBodyEl);
      this.currentRawContent = markdown;
      this.sourceTextareaEl.value = markdown;

      this.btnToggleSourceEl.classList.add('active');
      this.btnToggleSourceEl.textContent = '预览';
      if (this.statusModeBtnEl) {
        this.statusModeBtnEl.textContent = '[源码模式]';
      }

      this.markdownScrollWrapperEl.classList.add('hidden');
      this.markdownScrollWrapperEl.style.display = 'none';
      this.sourceViewEl.classList.remove('hidden');
      this.sourceViewEl.style.display = 'block';
      this.sourceTextareaEl.focus();

      this.updateStatsFromText(markdown);
    } else {
      // Switching from Source to WYSIWYG Mode
      const markdown = this.sourceTextareaEl.value;
      this.currentRawContent = markdown;

      const renderedHtml = parseMarkdown(markdown, {
        currentFilePath: this.currentFilePath || undefined,
        allowRemoteImages: this.currentSettings.allowRemoteImages,
        readonly: false
      });

      this.markdownBodyEl.innerHTML = renderedHtml;
      this.outlineController.update(extractHeadings(markdown));
      this.searchController.setContentBase(renderedHtml);

      this.btnToggleSourceEl.classList.remove('active');
      this.btnToggleSourceEl.textContent = '源码';
      if (this.statusModeBtnEl) {
        this.statusModeBtnEl.textContent = '[所见即所得]';
      }

      this.sourceViewEl.classList.add('hidden');
      this.sourceViewEl.style.display = 'none';
      this.markdownScrollWrapperEl.classList.remove('hidden');
      this.markdownScrollWrapperEl.style.display = 'flex';
      this.markdownBodyEl.focus();

      this.updateStatsFromText(markdown);
    }
  }

  public async saveCurrentFile(): Promise<boolean> {
    if (!this.currentFilePath || !window.electronAPI) return false;

    let contentToSave = '';
    if (this.isSourceMode) {
      contentToSave = this.sourceTextareaEl.value;
      this.currentRawContent = contentToSave;
    } else {
      contentToSave = htmlToMarkdown(this.markdownBodyEl);
      this.currentRawContent = contentToSave;
      this.sourceTextareaEl.value = contentToSave;
    }

    const res = await window.electronAPI.writeFile(this.currentFilePath, contentToSave);
    if (res.success) {
      this.markAsSaved();
      if (res.stats) {
        const sizeKb = (res.stats.size / 1024).toFixed(1);
        this.statusFileSizeEl.textContent = `${sizeKb} KB`;
      }
      this.updateStatsFromText(contentToSave);
      return true;
    } else {
      this.showError(res.error || '保存文件失败');
      return false;
    }
  }

  public async handleRequestClose(): Promise<void> {
    if (this.isEdited && this.currentFilePath) {
      const fileName = this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) || '当前文档';
      const res = await window.electronAPI.confirmSaveDialog(fileName);
      if (res.action === 'save') {
        const saveOk = await this.saveCurrentFile();
        if (saveOk) {
          await window.electronAPI.closeWindow();
        }
      } else if (res.action === 'dont-save') {
        await window.electronAPI.setDocumentEdited(false);
        await window.electronAPI.closeWindow();
      }
      // 'cancel': keep window open
    } else {
      await window.electronAPI.closeWindow();
    }
  }

  public markAsEdited(): void {
    if (this.isEdited) return;
    this.isEdited = true;
    window.electronAPI?.setDocumentEdited(true);

    const fileName = this.currentFilePath ? this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) : '未命名';
    this.docTitleEl.textContent = `${fileName} •`;

    if (this.savedBadgeTimeout) {
      clearTimeout(this.savedBadgeTimeout);
      this.savedBadgeTimeout = null;
    }
    if (this.statusSaveBadgeEl) {
      this.statusSaveBadgeEl.textContent = '[未保存]';
      this.statusSaveBadgeEl.className = 'status-save-badge unsaved';
      this.statusSaveBadgeEl.style.display = 'inline';
    }
  }

  public markAsSaved(): void {
    this.isEdited = false;
    window.electronAPI?.setDocumentEdited(false);

    const fileName = this.currentFilePath ? this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) : '未命名';
    this.docTitleEl.textContent = fileName;

    if (this.statusSaveBadgeEl) {
      this.statusSaveBadgeEl.textContent = '[已保存]';
      this.statusSaveBadgeEl.className = 'status-save-badge saved';
      this.statusSaveBadgeEl.style.display = 'inline';

      if (this.savedBadgeTimeout) clearTimeout(this.savedBadgeTimeout);
      this.savedBadgeTimeout = setTimeout(() => {
        if (this.statusSaveBadgeEl) {
          this.statusSaveBadgeEl.style.display = 'none';
        }
      }, 2500);
    }
  }

  private handleEditorInput(e: Event): void {
    this.markAsEdited();

    const text = this.markdownBodyEl.innerText || '';
    this.updateStatsFromText(text);
  }

  private updateStatsFromText(text: string): void {
    const charCount = text.length;
    const lineCount = text ? text.split('\n').length : 0;
    this.statusStatsEl.textContent = `${charCount} 字符 · ${lineCount} 行`;
  }

  public changeFontSize(delta: number): void {
    this.setFontSize(Number(this.currentSettings.fontSize || 16) + delta);
  }

  private setFontSize(value: number): void {
    const fontSize = Math.max(12, Math.min(28, Math.round(value)));
    this.markdownBodyEl.style.fontSize = `${fontSize}px`;
    this.settingsFontSizeEl.value = String(fontSize);
    this.saveSetting({ fontSize });
  }

  public openSettings(): void {
    if (!this.settingsDialogEl.open) this.settingsDialogEl.showModal();
  }

  public applyTheme(theme: string): void {
    let effective = theme;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      effective = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effective);
    this.selectThemeEl.value = theme;
  }

  public applyWidth(width: string): void {
    this.markdownBodyWrapperEl.className = `markdown-body-wrapper width-${width}`;
    this.selectWidthEl.value = width;
  }

  private applySettings(settings: any): void {
    if (!settings) return;
    this.applyTheme(settings.theme || 'system');
    this.applyWidth(settings.readingWidth || 'standard');
    if (settings.fontSize) {
      this.markdownBodyEl.style.fontSize = `${settings.fontSize}px`;
      this.settingsFontSizeEl.value = String(settings.fontSize);
    }
    this.switchSidebarTab(settings.sidebarTab === 'files' ? 'files' : 'outline');
    if (settings.showSidebar) {
      this.showSidebar();
    } else {
      this.hideSidebar();
    }
  }

  private saveSetting(update: any): void {
    this.currentSettings = { ...this.currentSettings, ...update };
    window.electronAPI?.saveSettings(this.currentSettings).catch((error) => {
      console.error('Failed to save settings:', error);
    });
  }

  private recordRecentFile(filePath: string): void {
    const existing = Array.isArray(this.currentSettings.recentFiles)
      ? this.currentSettings.recentFiles.filter((path: unknown): path is string => typeof path === 'string')
      : [];
    const recentFiles = [filePath, ...existing.filter((path: string) => path !== filePath)].slice(0, 8);
    this.currentSettings = { ...this.currentSettings, recentFiles, lastOpenedFile: filePath };
    this.renderRecentList(recentFiles);
    window.electronAPI?.saveSettings({ recentFiles, lastOpenedFile: filePath }).catch((error) => {
      console.error('Failed to update recent files:', error);
    });
  }

  private renderRecentList(recentFiles: string[]): void {
    this.recentListEl.innerHTML = '';
    const container = document.getElementById('recent-container')!;

    if (!recentFiles || recentFiles.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';

    for (const file of recentFiles.slice(0, 8)) {
      const li = document.createElement('li');
      li.className = 'recent-item';

      const fileName = file.substring(file.lastIndexOf('/') + 1);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = fileName;
      nameSpan.style.fontWeight = '500';

      const pathSpan = document.createElement('span');
      pathSpan.className = 'recent-item-path';
      pathSpan.textContent = file;

      li.appendChild(nameSpan);
      li.appendChild(pathSpan);

      li.addEventListener('click', () => this.loadFile(file));
      this.recentListEl.appendChild(li);
    }
  }

  private showError(msg: string): void {
    this.errorBannerEl.textContent = msg;
    this.errorBannerEl.classList.remove('hidden');
    this.errorBannerEl.style.display = 'block';
  }

  private hideError(): void {
    this.errorBannerEl.classList.add('hidden');
    this.errorBannerEl.style.display = 'none';
  }

  private handleMenuAction(action: string): void {
    switch (action) {
      case 'open-file':
        this.triggerOpenFile();
        break;
      case 'open-folder':
        this.triggerOpenFolder();
        break;
      case 'toggle-sidebar':
        this.toggleSidebar();
        break;
      case 'toggle-outline':
        this.toggleOutline();
        break;
      case 'toggle-source':
        this.toggleSourceView();
        break;
      case 'find':
      case 'search':
        this.searchController.open();
        break;
      case 'reload':
        this.reloadCurrentFilePreservingScroll();
        break;
      case 'zoom-in':
        this.changeFontSize(1);
        break;
      case 'zoom-out':
        this.changeFontSize(-1);
        break;
      case 'zoom-reset':
        this.setFontSize(16);
        break;
      case 'settings':
        this.openSettings();
        break;
      case 'save':
        this.saveCurrentFile();
        break;
      case 'request-close':
        this.handleRequestClose();
        break;
      case 'reveal-in-finder':
        if (this.currentFilePath) {
          window.electronAPI?.showInFolder(this.currentFilePath);
        }
        break;
      case 'recent-cleared':
        this.renderRecentList([]);
        break;
      case 'all-cleared':
        location.reload();
        break;
    }
  }
}

// Bootstrap app on DOM loaded
window.addEventListener('DOMContentLoaded', () => {
  new MoReadApp();
});
