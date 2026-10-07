import { parseMarkdown, extractHeadings } from './modules/parser.ts';
import { htmlToMarkdown } from './modules/editor.ts';
import { createPDFSnapshot, type PDFSnapshot } from './modules/pdfExport.ts';
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
    prepareForPDFExport?: () => PDFSnapshot | null;
  }
}

export interface DocumentTab {
  id: string;
  filePath: string | null;
  title: string;
  rawContent: string;
  savedContent: string;
  isEdited: boolean;
  editRevision: number;
  isEditMode: boolean;
  isSourceMode: boolean;
  scrollRatio: number;
  isReadOnly: boolean;
  hasBOM: boolean;
  lineEnding: '\n' | '\r\n';
  revision?: string;
  externalConflict?: boolean;
}

export class MoReadApp {
  public tabs: DocumentTab[] = [];
  public activeTabId: string | null = null;

  public currentSettings: any = {};
  public renderSessionId: number = 0;
  private savedBadgeTimeout: ReturnType<typeof setTimeout> | null = null;
  private fileTreeRootPath: string | null = null;
  private folderRequestId = 0;
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoSavePaused = false;
  private isComposing = false;
  private saveInFlight: Promise<boolean> | null = null;
  private scrollPositions: Record<string, number> = {};
  private draftTimeout: ReturnType<typeof setTimeout> | null = null;

  // Controllers
  public outlineController!: OutlineController;
  public searchController!: SearchController;
  public fileTreeController!: FileTreeController;

  // DOM Elements
  public docTitleEl!: HTMLElement;
  public docPathEl!: HTMLElement;
  public errorBannerEl!: HTMLElement;
  public conflictBannerEl!: HTMLElement;
  public conflictMessageEl!: HTMLElement;
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
  public tabBarEl!: HTMLElement;

  // Lightbox Elements
  public lightboxEl!: HTMLElement;
  public lightboxImgEl!: HTMLImageElement;
  public btnLightboxCloseEl!: HTMLButtonElement;

  // Status Elements
  public statusFileSizeEl!: HTMLElement;
  public statusStatsEl!: HTMLElement;
  public statusModeBtnEl!: HTMLElement;
  public statusSaveBadgeEl!: HTMLElement;

  // Header Elements
  public selectThemeEl!: HTMLSelectElement;
  public selectWidthEl!: HTMLSelectElement;
  public btnToggleEditEl!: HTMLButtonElement;
  public btnToggleSourceEl!: HTMLButtonElement;
  public btnToggleSidebarEl!: HTMLButtonElement;
  public settingsDialogEl!: HTMLDialogElement;
  public settingsFontSizeEl!: HTMLInputElement;
  public selectSaveModeEl!: HTMLSelectElement;
  public selectOpenModeEl!: HTMLSelectElement;
  public selectRemoteImagesEl!: HTMLSelectElement;

  // Draft Recovery Elements
  public draftRecoveryDialogEl!: HTMLDialogElement;
  public draftRecoveryListEl!: HTMLElement;

  // Compatibility getters/setters for legacy / test suite interface
  private _currentFilePath: string | null = null;
  private _currentRawContent = '';
  private _lastSavedContent = '';
  private _isSourceMode = false;
  private _isEdited = false;
  private _isEditMode = false;
  private _editRevision = 0;

  public get activeTab(): DocumentTab | null {
    if (!this.tabs || !this.activeTabId) return null;
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  }

  public get currentFilePath(): string | null {
    return this.activeTab ? this.activeTab.filePath : this._currentFilePath;
  }
  public set currentFilePath(val: string | null) {
    this._currentFilePath = val;
    if (this.activeTab) this.activeTab.filePath = val;
  }

  public get currentRawContent(): string {
    return this.activeTab ? this.activeTab.rawContent : this._currentRawContent;
  }
  public set currentRawContent(val: string) {
    this._currentRawContent = val;
    if (this.activeTab) this.activeTab.rawContent = val;
  }

  public get isSourceMode(): boolean {
    return this.activeTab ? this.activeTab.isSourceMode : this._isSourceMode;
  }
  public set isSourceMode(val: boolean) {
    this._isSourceMode = val;
    if (this.activeTab) this.activeTab.isSourceMode = val;
  }

  public get isEdited(): boolean {
    return this.activeTab ? this.activeTab.isEdited : this._isEdited;
  }
  public set isEdited(val: boolean) {
    this._isEdited = val;
    if (this.activeTab) this.activeTab.isEdited = val;
  }

  public get isEditMode(): boolean {
    return this.activeTab ? this.activeTab.isEditMode : this._isEditMode;
  }
  public set isEditMode(val: boolean) {
    this._isEditMode = val;
    if (this.activeTab) this.activeTab.isEditMode = val;
  }

  public get editRevision(): number {
    return this.activeTab ? this.activeTab.editRevision : this._editRevision;
  }
  public set editRevision(val: number) {
    this._editRevision = val;
    if (this.activeTab) this.activeTab.editRevision = val;
  }

  public get lastSavedContent(): string {
    return this.activeTab ? this.activeTab.savedContent : this._lastSavedContent;
  }
  public set lastSavedContent(val: string) {
    this._lastSavedContent = val;
    if (this.activeTab) this.activeTab.savedContent = val;
  }

  constructor() {
    this.initElements();
    this.initControllers();
    this.initEventListeners();
    this.initApp();
    window.moreadApp = this;
    window.prepareForPDFExport = () => this.prepareForPDFExport();
  }

  private initElements(): void {
    this.docTitleEl = document.getElementById('doc-title')!;
    this.docPathEl = document.getElementById('doc-path')!;
    this.errorBannerEl = document.getElementById('error-banner')!;
    this.conflictBannerEl = document.getElementById('conflict-banner')!;
    this.conflictMessageEl = document.getElementById('conflict-message')!;
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
    this.tabBarEl = document.getElementById('tab-bar')!;

    this.lightboxEl = document.getElementById('image-lightbox')!;
    this.lightboxImgEl = document.getElementById('lightbox-img') as HTMLImageElement;
    this.btnLightboxCloseEl = document.getElementById('btn-lightbox-close') as HTMLButtonElement;

    this.statusFileSizeEl = document.getElementById('status-file-size')!;
    this.statusStatsEl = document.getElementById('status-stats')!;
    this.statusModeBtnEl = document.getElementById('status-mode')!;
    this.statusSaveBadgeEl = document.getElementById('status-save-badge')!;

    this.selectThemeEl = document.getElementById('select-theme') as HTMLSelectElement;
    this.selectWidthEl = document.getElementById('select-reading-width') as HTMLSelectElement;
    this.btnToggleEditEl = document.getElementById('btn-toggle-edit') as HTMLButtonElement;
    this.btnToggleSourceEl = document.getElementById('btn-toggle-source') as HTMLButtonElement;
    this.btnToggleSidebarEl = document.getElementById('btn-toggle-sidebar') as HTMLButtonElement;
    this.settingsDialogEl = document.getElementById('reading-settings') as HTMLDialogElement;
    this.settingsFontSizeEl = document.getElementById('settings-font-size') as HTMLInputElement;
    this.selectSaveModeEl = document.getElementById('select-save-mode') as HTMLSelectElement;
    this.selectOpenModeEl = document.getElementById('select-open-mode') as HTMLSelectElement;
    this.selectRemoteImagesEl = document.getElementById('select-remote-images') as HTMLSelectElement;

    this.draftRecoveryDialogEl = document.getElementById('draft-recovery-dialog') as HTMLDialogElement;
    this.draftRecoveryListEl = document.getElementById('draft-recovery-list')!;

    this.markdownBodyEl.contentEditable = 'false';
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
        this.handleExternalFileChange(changedPath);
      });
      api.onMenuAction((action) => this.handleMenuAction(action));

      try {
        this.currentSettings = await api.getSettings();
        this.applySettings(this.currentSettings);
        this.renderRecentList(this.currentSettings.recentFiles || []);
        this.scrollPositions = this.currentSettings.scrollPositions || {};
        await this.checkCrashRecoveryDrafts();
      } catch (error) {
        console.error('Failed to load settings:', error);
        this.currentSettings = {
          theme: 'system',
          readingWidth: 'standard',
          fontSize: 16,
          openMode: 'read',
          saveMode: 'manual',
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
    this.btnToggleEditEl.addEventListener('click', () => this.toggleEditMode());
    this.btnToggleSourceEl.addEventListener('click', () => this.toggleSourceView());
    document.getElementById('btn-search')?.addEventListener('click', () => this.openSearch());

    // Settings actions
    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.settingsDialogEl.close());
    this.settingsFontSizeEl.addEventListener('change', () => {
      const value = Number(this.settingsFontSizeEl.value);
      if (Number.isFinite(value) && this.settingsFontSizeEl.value !== '') {
        this.setFontSize(value);
      } else {
        this.settingsFontSizeEl.value = String(this.currentSettings.fontSize || 16);
      }
    });

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

    this.selectSaveModeEl.addEventListener('change', () => {
      const saveMode = this.selectSaveModeEl.value === 'auto' ? 'auto' : 'manual';
      this.saveSetting({ saveMode });
      this.cancelAutoSave();
      this.scheduleAutoSave();
    });

    this.selectOpenModeEl.addEventListener('change', () => {
      const openMode = this.selectOpenModeEl.value === 'edit' ? 'edit' : 'read';
      this.saveSetting({ openMode });
    });

    this.selectRemoteImagesEl.addEventListener('change', () => {
      const allowRemoteImages = this.selectRemoteImagesEl.value === 'allow';
      this.saveSetting({ allowRemoteImages });
      if (this.activeTab && !this.isSourceMode) {
        this.renderActiveTabContent();
      }
    });

    document.getElementById('btn-clear-drafts')?.addEventListener('click', async () => {
      await window.electronAPI?.clearDrafts();
      this.showError('已清理所有本地崩溃恢复草稿');
      setTimeout(() => this.hideError(), 2500);
    });

    // Lightbox events
    this.btnLightboxCloseEl.addEventListener('click', () => this.closeLightbox());
    document.getElementById('lightbox-backdrop')?.addEventListener('click', () => this.closeLightbox());

    // Conflict banner events
    document.getElementById('btn-conflict-keep')?.addEventListener('click', () => {
      this.conflictBannerEl.classList.add('hidden');
      this.conflictBannerEl.style.display = 'none';
      if (this.activeTab) this.activeTab.externalConflict = false;
    });

    document.getElementById('btn-conflict-reload')?.addEventListener('click', async () => {
      if (!this.activeTab || !this.activeTab.filePath) return;
      const ok = confirm('确认放弃本地未保存修改，重新载入磁盘最新版本？');
      if (ok) {
        this.conflictBannerEl.classList.add('hidden');
        this.conflictBannerEl.style.display = 'none';
        this.activeTab.isEdited = false;
        await this.reloadTabFromDisk(this.activeTab);
      }
    });

    document.getElementById('btn-conflict-copy')?.addEventListener('click', () => {
      this.handleSaveCopy();
    });

    // Draft recovery dialog events
    document.getElementById('btn-close-drafts')?.addEventListener('click', () => {
      this.draftRecoveryDialogEl.close();
    });
    document.getElementById('btn-discard-drafts')?.addEventListener('click', async () => {
      await window.electronAPI?.clearDrafts();
      this.draftRecoveryDialogEl.close();
    });
    document.getElementById('btn-recover-drafts')?.addEventListener('click', async () => {
      await this.recoverAllDrafts();
      this.draftRecoveryDialogEl.close();
    });

    window.addEventListener('compositionstart', () => {
      this.isComposing = true;
      this.cancelAutoSave();
    });
    window.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.scheduleAutoSave();
    });

    // Sidebar tabs
    this.outlineTabBtn.addEventListener('click', () => this.switchSidebarTab('outline', true));
    this.filesTabBtn.addEventListener('click', () => this.switchSidebarTab('files', true));

    const appHeader = document.querySelector('.app-header');
    appHeader?.addEventListener('mousedown', (event) => {
      const mouseEvent = event as MouseEvent;
      const target = event.target as HTMLElement;
      if (mouseEvent.button !== 0 || target.closest('button, select, input, textarea, a, .tab-bar')) return;
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

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!this.lightboxEl.classList.contains('hidden') && this.lightboxEl.style.display !== 'none') {
          e.preventDefault();
          this.closeLightbox();
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        this.openSettings();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.toggleEditMode();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) {
          if (e.altKey) {
            this.handleSaveAs();
          } else {
            this.toggleSourceView();
          }
        } else {
          this.saveCurrentFile();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        this.handleCloseTabOrWindow();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.electronAPI?.newWindow?.();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        this.openNewEmptyTab();
        return;
      }
    });

    // WYSIWYG Editing listeners on markdown body
    bindCodeBlockEditing(this.markdownBodyEl);
    this.markdownBodyEl.addEventListener('input', (e) => this.handleEditorInput(e));
    this.markdownBodyEl.addEventListener('click', (e) => this.handleContentClick(e));

    // Input protection in read-only mode
    this.markdownBodyEl.addEventListener('beforeinput', (e) => {
      if (!this.isEditMode) {
        e.preventDefault();
      }
    });

    // Source textarea editing listeners
    this.sourceTextareaEl.addEventListener('input', () => {
      if (!this.isEditMode) return;
      this.markAsEdited();
      this.updateStatsFromText(this.sourceTextareaEl.value);
    });

    // Tab key handling in source textarea
    this.sourceTextareaEl.addEventListener('keydown', (e) => {
      if (!this.isEditMode) return;
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

  // --- Multi-Tab Management ---

  public createTab(options: Partial<DocumentTab>): DocumentTab {
    const id = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    const openMode = this.currentSettings.openMode === 'edit';
    const tab: DocumentTab = {
      id,
      filePath: options.filePath ?? null,
      title: options.title || (options.filePath ? options.filePath.split('/').pop()! : '未命名'),
      rawContent: options.rawContent ?? '',
      savedContent: options.savedContent ?? (options.rawContent ?? ''),
      isEdited: options.isEdited ?? false,
      editRevision: 0,
      isEditMode: options.isEditMode ?? openMode,
      isSourceMode: options.isSourceMode ?? false,
      scrollRatio: options.scrollRatio ?? 0,
      isReadOnly: options.isReadOnly ?? false,
      hasBOM: options.hasBOM ?? false,
      lineEnding: options.lineEnding ?? '\n',
      revision: options.revision
    };
    this.tabs.push(tab);
    return tab;
  }

  public openNewEmptyTab(): DocumentTab {
    const tab = this.createTab({
      title: '未命名',
      rawContent: '',
      savedContent: '',
      isEditMode: true
    });
    this.switchTab(tab.id);
    return tab;
  }

  public switchTab(tabId: string): void {
    if (this.activeTabId === tabId) return;

    // Save state of current active tab
    if (this.activeTab) {
      this.activeTab.scrollRatio = this.getScrollRatio();
      if (this.activeTab.isSourceMode) {
        this.activeTab.rawContent = this.sourceTextareaEl.value;
      } else if (this.activeTab.isEdited) {
        // The rendered editor owns the latest unsaved text until this tab leaves the viewport.
        this.activeTab.rawContent = htmlToMarkdown(this.markdownBodyEl);
      }
    }

    this.activeTabId = tabId;
    const tab = this.activeTab;
    if (!tab) return;

    this.renderTabBar();
    this.renderActiveTabContent();
  }

  public renderTabBar(): void {
    if (!this.tabBarEl || !this.tabs) return;
    this.tabBarEl.innerHTML = '';
    if (this.tabs.length === 0) {
      this.tabBarEl.style.display = 'none';
      return;
    }
    this.tabBarEl.style.display = 'flex';

    for (const tab of this.tabs) {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item${tab.id === this.activeTabId ? ' active' : ''}`;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', String(tab.id === this.activeTabId));

      if (tab.isEdited) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        tabEl.appendChild(dot);
      }

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      titleSpan.textContent = tab.title;
      tabEl.appendChild(titleSpan);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '✕';
      closeBtn.title = '关闭标签页 (Cmd+W)';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      tabEl.addEventListener('click', () => {
        this.switchTab(tab.id);
      });

      this.tabBarEl.appendChild(tabEl);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'tab-add-btn';
    addBtn.textContent = '+';
    addBtn.title = '新建标签页 (Cmd+T)';
    addBtn.addEventListener('click', () => {
      this.openNewEmptyTab();
    });
    this.tabBarEl.appendChild(addBtn);
  }

  public async closeTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return true;

    if (tab.isEdited) {
      const res = await window.electronAPI.confirmSaveDialog(tab.title);
      if (res.action === 'save') {
        const saved = await this.saveTab(tab);
        if (!saved) return false;
      } else if (res.action === 'cancel') {
        return false;
      }
    }

    // Delete draft
    await window.electronAPI?.deleteDraft(tab.filePath || tab.id);

    // Unwatch file
    if (tab.filePath) {
      // Keep other tabs' watchers
    }

    const index = this.tabs.findIndex((t) => t.id === tabId);
    this.tabs.splice(index, 1);

    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        const nextTab = this.tabs[Math.max(0, index - 1)];
        this.switchTab(nextTab.id);
      } else {
        this.activeTabId = null;
        this.showWelcomeScreen();
      }
    } else {
      this.renderTabBar();
    }
    return true;
  }

  public async handleCloseTabOrWindow(): Promise<void> {
    if (!this.activeTab) {
      await window.electronAPI?.closeWindow();
      return;
    }
    if (this.tabs.length <= 1) {
      await this.handleRequestClose();
    } else {
      await this.closeTab(this.activeTab.id);
    }
  }

  private renderActiveTabContent(): void {
    const tab = this.activeTab;
    if (!tab) {
      this.showWelcomeScreen();
      return;
    }

    if (this.welcomeViewEl) {
      this.welcomeViewEl.classList.add('hidden');
      this.welcomeViewEl.style.display = 'none';
    }

    // Update title & path
    if (this.docTitleEl) {
      this.docTitleEl.textContent = `${tab.title}${tab.isEdited ? ' •' : ''}`;
    }
    if (this.docPathEl) {
      this.docPathEl.textContent = tab.filePath || '';
      this.docPathEl.title = tab.filePath || '';
    }

    // Update status bar
    if (this.statusFileSizeEl) {
      const sizeKb = ((tab.rawContent.length || 0) / 1024).toFixed(1);
      this.statusFileSizeEl.textContent = `${sizeKb} KB`;
    }
    this.updateStatsFromText(tab.rawContent);

    // Update edit & source modes
    this.updateUIForMode();

    // Render content
    const renderedHtml = parseMarkdown(tab.rawContent, {
      currentFilePath: tab.filePath || undefined,
      allowRemoteImages: this.currentSettings ? this.currentSettings.allowRemoteImages : false,
      readonly: false
    });

    if (this.markdownBodyEl) {
      this.markdownBodyEl.innerHTML = renderedHtml;
    }
    if (this.sourceTextareaEl) {
      this.sourceTextareaEl.value = tab.rawContent;
    }

    // Outline and search base
    const headings = extractHeadings(tab.rawContent);
    this.outlineController?.update(headings);
    this.searchController?.setContentBase(renderedHtml);

    // Restore scroll position
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this.setScrollRatio(tab.scrollRatio || 0);
      });
    }

    // Check conflict banner
    if (this.conflictBannerEl) {
      if (tab.externalConflict) {
        this.conflictBannerEl.classList.remove('hidden');
        this.conflictBannerEl.style.display = 'flex';
      } else {
        this.conflictBannerEl.classList.add('hidden');
        this.conflictBannerEl.style.display = 'none';
      }
    }

    window.electronAPI?.setDocumentEdited(tab.isEdited);
  }

  private showWelcomeScreen(): void {
    if (this.welcomeViewEl) {
      this.welcomeViewEl.classList.remove('hidden');
      this.welcomeViewEl.style.display = 'block';
    }
    if (this.markdownScrollWrapperEl) {
      this.markdownScrollWrapperEl.classList.add('hidden');
      this.markdownScrollWrapperEl.style.display = 'none';
    }
    if (this.sourceViewEl) {
      this.sourceViewEl.classList.add('hidden');
      this.sourceViewEl.style.display = 'none';
    }
    if (this.docTitleEl) this.docTitleEl.textContent = '未打开文件';
    if (this.docPathEl) this.docPathEl.textContent = '';
    if (this.statusFileSizeEl) this.statusFileSizeEl.textContent = '-';
    if (this.statusStatsEl) this.statusStatsEl.textContent = '0 字符 · 0 行';
    this.outlineController?.update([]);
    this.renderTabBar();
    window.electronAPI?.setDocumentEdited(false);
  }

  // --- Read vs Edit Mode ---

  public updateUIForMode(): void {
    const tab = this.activeTab;
    if (!tab) return;

    if (tab.isEditMode) {
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.add('mode-edit');
        document.body.classList.remove('mode-read');
      }
      if (this.markdownBodyEl) this.markdownBodyEl.contentEditable = 'true';
      if (this.sourceTextareaEl) this.sourceTextareaEl.readOnly = false;
      if (this.btnToggleEditEl) {
        this.btnToggleEditEl.textContent = '结束编辑';
        this.btnToggleEditEl.classList.add('active');
      }
      if (this.statusModeBtnEl) this.statusModeBtnEl.textContent = tab.isSourceMode ? '[编辑源码]' : '[所见即所得]';
    } else {
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.add('mode-read');
        document.body.classList.remove('mode-edit');
      }
      if (this.markdownBodyEl) this.markdownBodyEl.contentEditable = 'false';
      if (this.sourceTextareaEl) this.sourceTextareaEl.readOnly = true;
      if (this.btnToggleEditEl) {
        this.btnToggleEditEl.textContent = '编辑';
        this.btnToggleEditEl.classList.remove('active');
      }
      if (this.statusModeBtnEl) this.statusModeBtnEl.textContent = tab.isSourceMode ? '[只读源码]' : '[阅读模式]';
    }

    if (tab.isSourceMode) {
      if (this.btnToggleSourceEl) {
        this.btnToggleSourceEl.classList.add('active');
        this.btnToggleSourceEl.textContent = '预览';
      }
      if (this.markdownScrollWrapperEl) {
        this.markdownScrollWrapperEl.classList.add('hidden');
        this.markdownScrollWrapperEl.style.display = 'none';
      }
      if (this.sourceViewEl) {
        this.sourceViewEl.classList.remove('hidden');
        this.sourceViewEl.style.display = 'block';
      }
    } else {
      if (this.btnToggleSourceEl) {
        this.btnToggleSourceEl.classList.remove('active');
        this.btnToggleSourceEl.textContent = '源码';
      }
      if (this.sourceViewEl) {
        this.sourceViewEl.classList.add('hidden');
        this.sourceViewEl.style.display = 'none';
      }
      if (this.markdownScrollWrapperEl) {
        this.markdownScrollWrapperEl.classList.remove('hidden');
        this.markdownScrollWrapperEl.style.display = 'flex';
      }
    }
  }

  public async toggleEditMode(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;

    if (!tab.isEditMode) {
      tab.isEditMode = true;
      this.updateUIForMode();
    } else {
      // Exiting Edit Mode
      if (!tab.isEdited) {
        tab.isEditMode = false;
        this.updateUIForMode();
      } else {
        // Safe Exit Confirmation: Save / Discard / Cancel
        const res = await window.electronAPI.confirmSaveDialog(tab.title);
        if (res.action === 'save') {
          const success = await this.saveCurrentFile();
          if (success) {
            tab.isEditMode = false;
            this.updateUIForMode();
          }
          // If save failed: stay in edit mode!
        } else if (res.action === 'dont-save') {
          // Discard changes and revert to savedContent
          tab.rawContent = tab.savedContent;
          tab.isEdited = false;
          tab.isEditMode = false;
          this.markAsSaved();
          this.renderActiveTabContent();
        }
        // 'cancel': remain in edit mode
      }
    }
  }

  public toggleSourceView(): void {
    const tab = this.activeTab;
    if (!tab) return;

    tab.scrollRatio = this.getScrollRatio();
    tab.isSourceMode = !tab.isSourceMode;

    if (tab.isSourceMode) {
      const markdown = htmlToMarkdown(this.markdownBodyEl);
      tab.rawContent = markdown;
      this.sourceTextareaEl.value = markdown;
      this.updateUIForMode();
      this.sourceTextareaEl.focus();
      this.updateStatsFromText(markdown);
    } else {
      const markdown = this.sourceTextareaEl.value;
      tab.rawContent = markdown;
      const renderedHtml = parseMarkdown(markdown, {
        currentFilePath: tab.filePath || undefined,
        allowRemoteImages: this.currentSettings.allowRemoteImages,
        readonly: false
      });
      this.markdownBodyEl.innerHTML = renderedHtml;
      this.outlineController.update(extractHeadings(markdown));
      this.searchController.setContentBase(renderedHtml);
      this.updateUIForMode();
      if (tab.isEditMode) this.markdownBodyEl.focus();
      this.updateStatsFromText(markdown);
    }

    requestAnimationFrame(() => {
      this.setScrollRatio(tab.scrollRatio);
    });
  }

  // --- Content Click Handling ---

  private handleContentClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // 1. Image lightbox zoom
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      this.openLightbox(img.src);
      return;
    }

    // 2. Task list item checkbox
    if (target.classList.contains('task-list-item-checkbox')) {
      if (!this.isEditMode) {
        e.preventDefault();
        return;
      }
      this.markAsEdited();
      return;
    }

    // 3. Code copy button
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

    // 4. Links: Follow directly in Read Mode, Require Cmd/Ctrl click in Edit Mode
    const anchor = target.closest('a');
    if (anchor) {
      const isModifier = e.metaKey || e.ctrlKey;
      if (!this.isEditMode || isModifier) {
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
        // Edit mode regular click: allows positioning caret
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

  // --- File Loading ---

  public async loadFile(filePath: string): Promise<void> {
    if (!window.electronAPI) return;
    this.cancelAutoSave();
    if (this.saveInFlight && !await this.saveInFlight) return;

    if (!this.tabs) this.tabs = [];

    // If current file has unsaved edits, confirm save before switching away to another file!
    if (this.isEdited && this.currentFilePath && this.currentFilePath !== filePath) {
      const fileName = this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) || '当前文档';
      const res = await window.electronAPI.confirmSaveDialog(fileName);
      if (res.action === 'save') {
        if (!await this.saveCurrentFile()) return;
      } else if (res.action === 'cancel') {
        this.scheduleAutoSave();
        return;
      } else if (res.action === 'dont-save') {
        if (this.activeTab) {
          this.activeTab.rawContent = this.activeTab.savedContent;
          this.activeTab.isEdited = false;
        }
        this.markAsSaved();
      }
    }

    // Check if document is already open in an existing tab!
    const existingTab = this.tabs.find((t) => t.filePath === filePath);
    if (existingTab) {
      this.switchTab(existingTab.id);
      if (this.fileTreeController && existingTab.filePath) {
        this.fileTreeController.setCurrentFile(existingTab.filePath);
        const parentPath = existingTab.filePath.substring(0, existingTab.filePath.lastIndexOf('/')) || '/';
        const rootPath = this.fileTreeRootPath && existingTab.filePath.startsWith(`${this.fileTreeRootPath.replace(/\/$/, '')}/`)
          ? this.fileTreeRootPath : parentPath;
        await this.loadFolderTree(rootPath, ++this.renderSessionId);
      }
      return;
    }

    const thisSessionId = ++this.renderSessionId;
    this.hideError();

    const res = await window.electronAPI.readFile(filePath);
    if (thisSessionId !== this.renderSessionId) return;

    if (!res.success || res.content === undefined) {
      this.showError(res.error || '无法打开此文件');
      return;
    }

    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    const openMode = this.currentSettings.openMode === 'edit';
    const storedScroll = this.scrollPositions[filePath] || 0;

    const tab = this.createTab({
      filePath,
      title: fileName,
      rawContent: res.content,
      savedContent: res.content,
      isEditMode: openMode,
      isReadOnly: res.stats?.isReadOnly ?? false,
      hasBOM: res.stats?.hasBOM ?? false,
      lineEnding: res.stats?.lineEnding ?? '\n',
      revision: res.stats?.revision,
      scrollRatio: storedScroll
    });

    this.switchTab(tab.id);
    this.recordRecentFile(filePath);

    // Update file tree active item
    if (this.fileTreeController) {
      this.fileTreeController.setCurrentFile(filePath);
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      const rootPath = this.fileTreeRootPath && filePath.startsWith(`${this.fileTreeRootPath.replace(/\/$/, '')}/`)
        ? this.fileTreeRootPath : parentPath;
      await this.loadFolderTree(rootPath, thisSessionId);
    }
  }

  private async reloadTabFromDisk(tab: DocumentTab): Promise<void> {
    if (!tab.filePath) return;
    const res = await window.electronAPI.readFile(tab.filePath);
    if (res.success && res.content !== undefined) {
      tab.rawContent = res.content;
      tab.savedContent = res.content;
      tab.isEdited = false;
      tab.revision = res.stats?.revision;
      tab.externalConflict = false;
      if (this.activeTabId === tab.id) {
        this.renderActiveTabContent();
        this.markAsSaved();
      }
    }
  }

  private handleExternalFileChange(changedPath: string): void {
    const tab = this.tabs.find((t) => t.filePath === changedPath);
    if (!tab) return;

    if (!tab.isEdited && !this.saveInFlight) {
      // Clean tab: reload automatically preserving scroll
      void this.reloadTabFromDisk(tab);
    } else if (!this.saveInFlight) {
      // Dirty tab: conflict detected!
      tab.externalConflict = true;
      if (this.activeTabId === tab.id) {
        this.conflictBannerEl.classList.remove('hidden');
        this.conflictBannerEl.style.display = 'flex';
      }
      this.pauseAutoSave('文件已被外部修改，自动保存已暂停；请先处理冲突。');
    }
  }

  // --- Saving & Safety ---

  public async saveCurrentFile(): Promise<boolean> {
    if (this.activeTab) {
      return this.saveTab(this.activeTab);
    }
    // Fallback for mocked or headless instances without tabs
    if (!this.currentFilePath || !window.electronAPI) return false;
    if (this.isComposing) return false;
    this.cancelAutoSave();
    if (this.saveInFlight) {
      const success = await this.saveInFlight;
      if (!success) return false;
      return this.isEdited ? this.saveCurrentFile() : true;
    }
    if (!this.isEdited) return true;

    const filePath = this.currentFilePath;
    const revision = this.editRevision;
    const baseline = this.lastSavedContent;
    const contentToSave = this.isSourceMode ? (this.sourceTextareaEl?.value ?? '') : (this.markdownBodyEl ? htmlToMarkdown(this.markdownBodyEl) : '');
    const operation = this.writeDocumentSnapshot(filePath, revision, baseline, contentToSave);
    this.saveInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.saveInFlight === operation) this.saveInFlight = null;
    }
  }

  public async saveTab(tab: DocumentTab): Promise<boolean> {
    if (!tab || !window.electronAPI) return false;
    if (this.isComposing) return false;
    this.cancelAutoSave();

    if (!tab.filePath) {
      // Untitled document: redirect to Save As
      return this.handleSaveAs();
    }

    if (tab.isReadOnly) {
      this.showError('该文件在磁盘上为只读，无法直接写入。请使用“另存为”保存副本。');
      return false;
    }

    if (this.saveInFlight) {
      const success = await this.saveInFlight;
      if (!success) return false;
      return tab.isEdited ? this.saveTab(tab) : true;
    }
    if (!tab.isEdited) return true;

    const contentToSave = tab.isSourceMode ? (this.sourceTextareaEl?.value ?? tab.rawContent) : (this.markdownBodyEl ? htmlToMarkdown(this.markdownBodyEl) : tab.rawContent);
    const revision = tab.editRevision;
    const baseline = tab.savedContent;
    const filePath = tab.filePath;

    const operation = this.writeDocumentSnapshot(filePath, revision, baseline, contentToSave, tab);
    this.saveInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.saveInFlight === operation) this.saveInFlight = null;
    }
  }

  private async writeDocumentSnapshot(filePath: string, revision: number, baseline: string, contentToSave: string, tab?: DocumentTab): Promise<boolean> {
    try {
      const disk = await window.electronAPI.readFile(filePath);
      if (!disk.success || disk.content !== baseline) {
        if (tab) tab.externalConflict = true;
        this.pauseAutoSave(disk.error || '文件已在外部修改，保存已停止；当前修改仍保留，请先处理磁盘上的新版本。');
        return false;
      }

      const fileOptions = (tab && (tab.hasBOM !== undefined || tab.lineEnding !== undefined)) ? {
        hasBOM: tab.hasBOM,
        lineEnding: tab.lineEnding
      } : undefined;

      const res = await (fileOptions
        ? window.electronAPI.writeFile(filePath, contentToSave, disk.stats?.revision, fileOptions)
        : window.electronAPI.writeFile(filePath, contentToSave, disk.stats?.revision));

      if (!res.success) {
        this.pauseAutoSave(res.error || '保存文件失败，当前修改仍保留；可使用 Cmd+S 重试。');
        return false;
      }

      if (this.currentFilePath !== filePath && tab?.filePath !== filePath) return true;
      this.lastSavedContent = contentToSave;
      if (tab) {
        tab.savedContent = contentToSave;
        tab.revision = res.stats?.revision;
        tab.externalConflict = false;
      }
      this.autoSavePaused = false;
      if (res.stats && this.statusFileSizeEl) {
        const sizeKb = (res.stats.size / 1024).toFixed(1);
        this.statusFileSizeEl.textContent = `${sizeKb} KB`;
      }

      if (revision === this.editRevision || (tab && revision === tab.editRevision)) {
        this.currentRawContent = contentToSave;
        if (tab) tab.rawContent = contentToSave;
        if (!this.isSourceMode && this.sourceTextareaEl) this.sourceTextareaEl.value = contentToSave;
        this.markAsSaved();
        this.updateStatsFromText(contentToSave);
        this.hideError();
      } else {
        this.scheduleAutoSave();
      }
      await window.electronAPI?.deleteDraft?.(filePath);
      return revision === this.editRevision || (tab ? revision === tab.editRevision : false);
    } catch (error) {
      this.pauseAutoSave(`保存失败，自动保存已暂停；当前修改仍保留：${error instanceof Error ? error.message : '请重试'}`);
      return false;
    }
  }

  public async handleSaveAs(): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab || !window.electronAPI) return false;

    const content = tab.isSourceMode ? this.sourceTextareaEl.value : htmlToMarkdown(this.markdownBodyEl);
    const res = await window.electronAPI.saveAsDialog(tab.filePath || undefined, content);
    if (!res.canceled && res.filePath) {
      tab.filePath = res.filePath;
      tab.title = res.filePath.split('/').pop() || '未命名';
      tab.savedContent = content;
      tab.rawContent = content;
      tab.isEdited = false;
      this.markAsSaved();
      this.renderTabBar();
      this.recordRecentFile(res.filePath);
      await window.electronAPI.deleteDraft(tab.id);
      return true;
    }
    return false;
  }

  public async handleSaveCopy(): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab || !window.electronAPI) return false;

    const content = tab.isSourceMode ? this.sourceTextareaEl.value : htmlToMarkdown(this.markdownBodyEl);
    const res = await window.electronAPI.saveCopyDialog(tab.filePath || undefined, content);
    if (!res.canceled && res.success) {
      this.showError(`已成功存储副本至: ${res.filePath?.split('/').pop()}`);
      setTimeout(() => this.hideError(), 2500);
      return true;
    }
    return false;
  }

  // --- Auto-Recovery Drafts ---

  private scheduleDraftSave(): void {
    if (this.draftTimeout) clearTimeout(this.draftTimeout);
    this.draftTimeout = setTimeout(async () => {
      this.draftTimeout = null;
      const tab = this.activeTab;
      if (tab && tab.isEdited) {
        const liveContent = tab.isSourceMode ? this.sourceTextareaEl.value : htmlToMarkdown(this.markdownBodyEl);
        await window.electronAPI?.saveDraft({
          id: tab.filePath || tab.id,
          filePath: tab.filePath || undefined,
          content: liveContent,
          timestamp: Date.now()
        });
      }
    }, 1500);
  }

  private async checkCrashRecoveryDrafts(): Promise<void> {
    if (!window.electronAPI?.getAllDrafts) return;
    try {
      const res = await window.electronAPI.getAllDrafts();
      if (res && res.drafts && res.drafts.length > 0) {
        this.renderDraftRecoveryList(res.drafts);
        this.draftRecoveryDialogEl.showModal();
      }
    } catch (e) {
      console.warn('Failed to inspect drafts:', e);
    }
  }

  private renderDraftRecoveryList(drafts: Array<{ id: string; filePath?: string; content: string; timestamp: number }>): void {
    this.draftRecoveryListEl.innerHTML = '';
    for (const d of drafts) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      const name = d.filePath ? d.filePath.split('/').pop()! : '未命名草稿';
      const time = new Date(d.timestamp).toLocaleString();
      li.innerHTML = `<span><strong>${name}</strong> (${time})</span><span class="recent-item-path">${d.filePath || '未关联文件'}</span>`;
      this.draftRecoveryListEl.appendChild(li);
    }
  }

  private async recoverAllDrafts(): Promise<void> {
    const res = await window.electronAPI?.getAllDrafts();
    if (!res || !res.drafts) return;
    for (const d of res.drafts) {
      const tab = this.createTab({
        filePath: d.filePath || null,
        title: d.filePath ? d.filePath.split('/').pop()! : '已恢复草稿',
        rawContent: d.content,
        savedContent: '',
        isEdited: true,
        isEditMode: true
      });
      this.switchTab(tab.id);
    }
  }

  // --- Scroll Position Memory ---

  private getScrollRatio(): number {
    const el = this.isSourceMode ? this.sourceTextareaEl : this.markdownScrollWrapperEl;
    return el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
  }

  private setScrollRatio(ratio: number): void {
    const el = this.isSourceMode ? this.sourceTextareaEl : this.markdownScrollWrapperEl;
    if (el.scrollHeight > el.clientHeight) {
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    }
  }

  // --- Image Lightbox ---

  public openLightbox(src: string): void {
    this.lightboxImgEl.src = src;
    this.lightboxEl.classList.remove('hidden');
    this.lightboxEl.style.display = 'flex';
  }

  public closeLightbox(): void {
    this.lightboxEl.classList.add('hidden');
    this.lightboxEl.style.display = 'none';
    this.lightboxImgEl.src = '';
  }

  // --- PDF Export ---

  public prepareForPDFExport(): PDFSnapshot | null {
    const tab = this.activeTab;
    if (!tab) return null;

    // Get live markdown content (including any unsaved edits)
    const liveMarkdown = tab.isSourceMode
      ? (this.sourceTextareaEl?.value ?? tab.rawContent)
      : (tab.isEdited ? htmlToMarkdown(this.markdownBodyEl) : tab.rawContent);
    return createPDFSnapshot(liveMarkdown, tab.title, {
      currentFilePath: tab.filePath || undefined,
      allowRemoteImages: this.currentSettings.allowRemoteImages === true,
      readonly: true
    });
  }

  // --- Auto-Save ---

  private cancelAutoSave(): void {
    if (this.autoSaveTimeout) clearTimeout(this.autoSaveTimeout);
    this.autoSaveTimeout = null;
  }

  private scheduleAutoSave(): void {
    this.cancelAutoSave();
    if (this.currentSettings.saveMode !== 'auto' || !this.isEdited || !this.currentFilePath || this.isComposing || this.autoSavePaused) return;
    const tab = this.activeTab;
    this.autoSaveTimeout = setTimeout(() => {
      this.autoSaveTimeout = null;
      if (this.activeTab === tab && this.currentSettings.saveMode === 'auto' && !this.isComposing && !this.autoSavePaused) {
        void this.saveCurrentFile();
      }
    }, 1000);
  }

  private pauseAutoSave(message: string): void {
    this.autoSavePaused = true;
    this.cancelAutoSave();
    this.showError(message);
  }

  // --- Search ---

  public openSearch(): void {
    this.searchController.open();
  }

  // --- Window Close Handling ---

  public async handleRequestClose(): Promise<void> {
    this.cancelAutoSave();
    if (this.saveInFlight && !await this.saveInFlight) return;

    if (this.tabs && this.tabs.length > 0) {
      const dirtyTabs = this.tabs.filter((t) => t.isEdited);
      for (const tab of dirtyTabs) {
        this.switchTab(tab.id);
        const res = await window.electronAPI?.confirmSaveDialog(tab.title);
        if (res?.action === 'save') {
          const saved = await this.saveTab(tab);
          if (!saved) return;
        } else if (res?.action === 'cancel') {
          return;
        }
      }
      await window.electronAPI?.closeWindow();
      return;
    }

    // Fallback for headless / single document instance without initialized tabs
    if (this.isEdited && this.currentFilePath) {
      const fileName = this.currentFilePath.substring(this.currentFilePath.lastIndexOf('/') + 1) || '当前文档';
      const res = await window.electronAPI?.confirmSaveDialog(fileName);
      if (res?.action === 'save') {
        const saveOk = await this.saveCurrentFile();
        if (saveOk) await window.electronAPI?.closeWindow();
      } else if (res?.action === 'dont-save') {
        this.cancelAutoSave();
        await window.electronAPI?.setDocumentEdited(false);
        await window.electronAPI?.closeWindow();
      }
      if (res?.action === 'cancel') this.scheduleAutoSave();
    } else {
      this.cancelAutoSave();
      await window.electronAPI?.closeWindow();
    }
  }

  // --- Edit Marking ---

  public markAsEdited(): void {
    if (this.activeTab) {
      this.activeTab.editRevision++;
      this.activeTab.isEdited = true;
    } else {
      this._editRevision++;
      this._isEdited = true;
    }
    this.scheduleAutoSave();
    this.scheduleDraftSave();
    window.electronAPI?.setDocumentEdited(true);

    const fileName = this.activeTab ? this.activeTab.title : (this.currentFilePath ? this.currentFilePath.split('/').pop() || '未命名' : '未命名');
    if (this.docTitleEl) {
      this.docTitleEl.textContent = `${fileName} •`;
    }
    this.renderTabBar();

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
    this.cancelAutoSave();
    if (this.activeTab) {
      this.activeTab.isEdited = false;
    } else {
      this._isEdited = false;
    }
    window.electronAPI?.setDocumentEdited(false);

    const fileName = this.activeTab ? this.activeTab.title : (this.currentFilePath ? this.currentFilePath.split('/').pop() || '未命名' : '未命名');
    if (this.docTitleEl) {
      this.docTitleEl.textContent = fileName;
    }
    this.renderTabBar();

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

  private handleEditorInput(_e: Event): void {
    if (!this.isEditMode) return;
    this.markAsEdited();
    const text = this.markdownBodyEl.innerText || '';
    this.updateStatsFromText(text);
  }

  private updateStatsFromText(text: string): void {
    if (!this.statusStatsEl) return;
    const charCount = text.length;
    const lineCount = text ? text.split('\n').length : 0;
    this.statusStatsEl.textContent = `${charCount} 字符 · ${lineCount} 行`;
  }

  // --- Sidebar & Folder Tree ---

  public async loadFolderTree(folderPath: string, renderSessionId?: number): Promise<boolean> {
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
    this.selectSaveModeEl.value = settings.saveMode === 'auto' ? 'auto' : 'manual';
    this.selectOpenModeEl.value = settings.openMode === 'edit' ? 'edit' : 'read';
    this.selectRemoteImagesEl.value = settings.allowRemoteImages ? 'allow' : 'block';
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
    if (!this.errorBannerEl) return;
    this.errorBannerEl.textContent = msg;
    this.errorBannerEl.classList.remove('hidden');
    this.errorBannerEl.style.display = 'block';
  }

  private hideError(): void {
    if (!this.errorBannerEl) return;
    this.errorBannerEl.classList.add('hidden');
    this.errorBannerEl.style.display = 'none';
  }

  public handleMenuAction(action: string): void {
    switch (action) {
      case 'new-window':
        window.electronAPI?.newWindow?.();
        break;
      case 'new-tab':
        this.openNewEmptyTab();
        break;
      case 'close-tab':
        this.handleCloseTabOrWindow();
        break;
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
      case 'toggle-edit':
        this.toggleEditMode();
        break;
      case 'toggle-source':
        this.toggleSourceView();
        break;
      case 'save':
        this.saveCurrentFile();
        break;
      case 'save-as':
        this.handleSaveAs();
        break;
      case 'save-copy':
        this.handleSaveCopy();
        break;
      case 'export-pdf':
        window.electronAPI?.exportPDF();
        break;
      case 'find':
      case 'search':
        this.openSearch();
        break;
      case 'reload':
        if (this.activeTab) this.reloadTabFromDisk(this.activeTab);
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
