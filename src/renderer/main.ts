import { parseMarkdown, extractHeadings } from './modules/parser.ts';
import { htmlToMarkdown } from './modules/editor.ts';
import { createPDFSnapshot, type PDFSnapshot } from './modules/pdfExport.ts';
import { bindCodeBlockEditing, readCodeBlock } from './modules/codeBlocks.ts';
import { bindMathEditing, setMathEditingEnabled } from './modules/mathEditing.ts';
import { bindMarkdownPaste } from './modules/paste.ts';
import { OutlineController } from './modules/outline.ts';
import { SearchController } from './modules/search.ts';
import { FileTreeController } from './modules/fileTree.ts';
import { initNativeBridge, BridgeAPI, type RecoveryDraft } from './modules/bridge.ts';

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
  draftId: string;
  recoveredDraftId?: string;
  recoveredDraft?: RecoveryDraft;
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
  saveState?: 'saving' | 'failed';
  autoSavePaused?: boolean;
  draftSavedRevision?: number;
  draftBackupFailed?: boolean;
}

export class MoReadApp {
  public tabs: DocumentTab[] = [];
  public activeTabId: string | null = null;

  public currentSettings: any = {};
  public renderSessionId: number = 0;
  private fallbackSaveState?: 'saving' | 'failed';
  private recoveryDrafts: RecoveryDraft[] = [];
  private selectedDraftIds = new Set<string>();
  private recoveryRequestId = 0;
  private recoveryBusy = false;
  private previewDraftId?: string;
  private fileTreeRootPath: string | null = null;
  private folderRequestId = 0;
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoSavePaused = false;
  private isComposing = false;
  private saveInFlight: Promise<boolean> | null = null;
  private scrollPositions: Record<string, number> = {};
  private draftTimeouts = new Map<DocumentTab, ReturnType<typeof setTimeout>>();
  private draftOperations = new Map<DocumentTab, Promise<void>>();
  private tabCloseRequests = new Map<DocumentTab, Promise<boolean>>();
  private closePreparation: Promise<boolean> | null = null;
  private closeApproval: Array<{ tab: DocumentTab; revision: number; path: string | null }> | null = null;
  private fileOpenRequests = new Map<string, Promise<void>>();
  private remoteImagesRenderPending = false;
  private reloadRequests = new WeakMap<DocumentTab, object>();
  private contentRenderGeneration = 0;
  private editModeRequest: DocumentTab | null = null;
  private deferredEditorAction: { tab: DocumentTab; action: 'source' | 'edit'; enabled?: boolean } | null = null;

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
  public statusSavePolicyEl!: HTMLElement;
  public statusDraftBackupEl!: HTMLElement;
  public btnModeReadEl!: HTMLButtonElement;
  public btnViewRenderedEl!: HTMLButtonElement;

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
    this.updateUIForMode();
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
    this.statusSavePolicyEl = document.getElementById('status-save-policy')!;
    this.statusDraftBackupEl = document.getElementById('status-draft-backup')!;
    this.btnModeReadEl = document.getElementById('btn-mode-read') as HTMLButtonElement;
    this.btnViewRenderedEl = document.getElementById('btn-view-rendered') as HTMLButtonElement;

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
    this.searchController.configure({
      source: this.sourceTextareaEl,
      isSource: () => this.isSourceMode,
      canReplace: () => !!this.activeTab?.isEditMode,
      isComposing: () => this.isComposing,
      hasDocument: () => !!this.activeTab
    });

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
    document.getElementById('btn-welcome-new-file')?.addEventListener('click', () => this.openNewEmptyTab());
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
    this.btnToggleEditEl.addEventListener('click', () => this.setEditMode(true));
    this.btnModeReadEl.addEventListener('click', () => this.setEditMode(false));
    this.btnToggleSourceEl.addEventListener('click', () => this.setSourceMode(true));
    this.btnViewRenderedEl.addEventListener('click', () => this.setSourceMode(false));
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
      this.refreshRemoteImages();
    });

    document.getElementById('btn-clear-drafts')?.addEventListener('click', async () => {
      if (!confirm('清理所有恢复草稿？此操作不能撤销，不会删除原文件。')) return;
      try {
        const result = await window.electronAPI?.clearDrafts();
        if (!result?.success) throw new Error('清理失败，请重试');
        for (const tab of this.tabs) {
          tab.draftSavedRevision = undefined;
          this.scheduleDraftSave(tab);
        }
        this.updateSaveStatus();
        this.showError('已清理恢复草稿；正在编辑的文档会继续自动备份');
      } catch (error) { this.showError(`无法清理草稿：${String(error)}`); }
    });
    document.getElementById('btn-manage-drafts')?.addEventListener('click', () => {
      this.settingsDialogEl.close();
      void this.checkCrashRecoveryDrafts(true);
    });

    // Lightbox events
    this.btnLightboxCloseEl.addEventListener('click', () => this.closeLightbox());
    document.getElementById('lightbox-backdrop')?.addEventListener('click', () => this.closeLightbox());

    // Conflict banner events
    document.getElementById('btn-conflict-keep')?.addEventListener('click', () => {
      this.conflictBannerEl.classList.add('hidden');
      this.conflictBannerEl.style.display = 'none';
      if (this.activeTab) this.activeTab.externalConflict = false;
      this.updateSaveStatus();
    });

    document.getElementById('btn-conflict-reload')?.addEventListener('click', async () => {
      if (!this.activeTab || !this.activeTab.filePath) return;
      const ok = confirm('确认放弃本地未保存修改，重新载入磁盘最新版本？');
      if (ok) {
        this.conflictBannerEl.classList.add('hidden');
        this.conflictBannerEl.style.display = 'none';
        await this.reloadTabFromDisk(this.activeTab, true);
      }
    });

    document.getElementById('btn-conflict-copy')?.addEventListener('click', () => {
      this.handleSaveCopy();
    });

    // Draft recovery dialog events
    document.getElementById('btn-close-drafts')?.addEventListener('click', () => {
      this.draftRecoveryDialogEl.close();
    });
    document.getElementById('btn-later-drafts')?.addEventListener('click', () => {
      this.draftRecoveryDialogEl.close();
    });
    document.getElementById('btn-recover-drafts')?.addEventListener('click', async () => {
      await this.recoverSelectedDrafts();
    });

    window.addEventListener('compositionstart', () => {
      this.isComposing = true;
      this.cancelAutoSave();
    });
    window.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.scheduleAutoSave();
      this.scheduleDraftSave();
      if (this.remoteImagesRenderPending) setTimeout(() => this.refreshRemoteImages(), 0);
      const deferred = this.deferredEditorAction;
      this.deferredEditorAction = null;
      if (deferred) setTimeout(() => {
        if (this.activeTab === deferred.tab && !this.isComposing) {
          if (deferred.action === 'source') {
            if (deferred.enabled === undefined) this.toggleSourceView();
            else this.setSourceMode(deferred.enabled);
          } else if (deferred.enabled === undefined) void this.toggleEditMode();
          else void this.setEditMode(deferred.enabled);
        }
      }, 0);
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
    bindMathEditing(this.markdownBodyEl, () => this.isEditMode && !this.isSourceMode);
    this.markdownBodyEl.addEventListener('input', (e) => this.handleEditorInput(e));
    bindMarkdownPaste(this.markdownBodyEl, {
      canEdit: () => this.isEditMode && !this.isSourceMode && !this.isComposing,
      parseOptions: () => ({
        currentFilePath: this.currentFilePath || undefined,
        allowRemoteImages: this.currentSettings.allowRemoteImages === true,
        readonly: false
      }),
      onInserted: inputDispatched => {
        if (!inputDispatched) this.markAsEdited();
        this.refreshPastedDocument();
      },
      onError: error => this.showError(`粘贴处理失败：${error instanceof Error ? error.message : '请重试'}`)
    });
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
      draftId: options.draftId ?? crypto.randomUUID(),
      recoveredDraftId: options.recoveredDraftId,
      recoveredDraft: options.recoveredDraft,
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
      revision: options.revision,
      externalConflict: options.externalConflict
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
    this.markdownBodyEl.focus();
    return tab;
  }

  private getTabContent(tab: DocumentTab): string {
    if (this.activeTab !== tab) return tab.rawContent;
    if (tab.isSourceMode) return this.sourceTextareaEl?.value ?? tab.rawContent;
    return tab.isEdited && this.markdownBodyEl ? htmlToMarkdown(this.markdownBodyEl) : tab.rawContent;
  }

  private updateDocumentEdited(): void {
    const dirty = this.tabs ? this.tabs.some(tab => tab.isEdited) : this.isEdited;
    window.electronAPI?.setDocumentEdited(dirty);
  }

  private refreshRemoteImages(): void {
    if (this.isComposing) {
      this.remoteImagesRenderPending = true;
      return;
    }
    this.remoteImagesRenderPending = false;
    const tab = this.activeTab;
    if (tab && !tab.isSourceMode) {
      tab.rawContent = this.getTabContent(tab);
      tab.scrollRatio = this.getScrollRatio();
      this.renderActiveTabContent();
    }
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

    this.autoSavePaused = tab.autoSavePaused === true;
    this.renderTabBar();
    this.renderActiveTabContent();
    this.updateSaveStatus();
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
    this.tabCloseRequests ??= new Map();
    const pending = this.tabCloseRequests.get(tab);
    if (pending) return pending;
    const request = this.closeDocumentTab(tab).catch(error => {
      this.showError(`关闭失败，当前修改仍保留：${String(error)}`);
      return false;
    });
    this.tabCloseRequests.set(tab, request);
    try {
      return await request;
    } catch (error) {
      this.showError(`关闭失败，当前修改仍保留：${String(error)}`);
      return false;
    } finally {
      this.tabCloseRequests.delete(tab);
    }
  }

  private async closeDocumentTab(tab: DocumentTab): Promise<boolean> {
    if (this.isComposing) return false;
    if (this.saveInFlight && !await this.saveInFlight) return false;
    if (!this.tabs.includes(tab)) return true;

    if (tab.isEdited) {
      const revision = tab.editRevision;
      const path = tab.filePath;
      const res = await window.electronAPI.confirmSaveDialog(tab.title);
      if (!this.tabs.includes(tab)) return true;
      if (tab.editRevision !== revision || tab.filePath !== path || this.isComposing) return false;
      if (res.action === 'save') {
        const saved = await this.saveTab(tab);
        if (!saved || tab.isEdited) return false;
      } else if (res.action !== 'dont-save') {
        return false;
      }
    }
    // Remove synchronously after the last validation; draft cleanup may await the bridge.
    const index = this.tabs.indexOf(tab);
    if (index < 0) return true;
    this.cancelDraftSave(tab);
    this.tabs.splice(index, 1);

    if (this.activeTabId === tab.id) {
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
    this.updateDocumentEdited();
    await this.deleteTabDraft(tab);
    if (tab.filePath && !this.tabs.some(other => other.filePath === tab.filePath) && !this.fileOpenRequests?.has(tab.filePath)) {
      await window.electronAPI?.unwatchFile?.(tab.filePath);
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
    const generation = ++this.contentRenderGeneration;
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
      const sourceMode = tab.isSourceMode;
      const scrollEl = sourceMode ? this.sourceTextareaEl : this.markdownScrollWrapperEl;
      const scrollTop = scrollEl.scrollTop;
      requestAnimationFrame(() => {
        // Never let an older render move another tab, or undo a user's new scroll.
        if (this.activeTab === tab && generation === this.contentRenderGeneration &&
            tab.isSourceMode === sourceMode && scrollEl.scrollTop === scrollTop) {
          if (this.searchController?.isOpen) this.searchController.refresh();
          else this.setScrollRatio(tab.scrollRatio || 0);
        }
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

    setMathEditingEnabled(this.markdownBodyEl, tab.isEditMode);
    this.updateDocumentEdited();
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
    this.searchController?.refresh();
    this.renderTabBar();
    this.updateDocumentEdited();
    this.updateUIForMode();
  }

  // --- Read vs Edit Mode ---

  public updateUIForMode(): void {
    const tab = this.activeTab;
    const controls: Array<[HTMLButtonElement | undefined, boolean]> = [
      [this.btnModeReadEl, !!tab && !tab.isEditMode],
      [this.btnToggleEditEl, !!tab?.isEditMode],
      [this.btnViewRenderedEl, !!tab && !tab.isSourceMode],
      [this.btnToggleSourceEl, !!tab?.isSourceMode]
    ];
    for (const [button, selected] of controls) {
      if (!button) continue;
      button.disabled = !tab;
      button.setAttribute?.('aria-pressed', String(selected));
      if (selected) button.classList.add('active');
      else button.classList.remove('active');
    }
    if (typeof document !== 'undefined') {
      const search = document.getElementById?.('btn-search') as HTMLButtonElement | null;
      if (search) search.disabled = !tab;
    }
    if (this.statusModeBtnEl && !tab) this.statusModeBtnEl.textContent = '';
    this.updateSaveStatus();
    if (!tab) return;
    if (this.markdownBodyEl) setMathEditingEnabled(this.markdownBodyEl, tab.isEditMode);

    if (tab.isEditMode) {
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.add('mode-edit');
        document.body.classList.remove('mode-read');
      }
      if (this.markdownBodyEl) this.markdownBodyEl.contentEditable = 'true';
      if (this.sourceTextareaEl) this.sourceTextareaEl.readOnly = false;
      if (this.btnToggleEditEl) {
        this.btnToggleEditEl.textContent = '编辑';
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
        this.btnToggleSourceEl.textContent = '源码';
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
    this.searchController?.refresh();
  }

  public async setEditMode(enabled: boolean): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.isComposing) {
      this.deferredEditorAction = { tab, action: 'edit', enabled };
      return;
    }
    if (tab.isEditMode !== enabled) await this.toggleEditMode();
  }

  public setSourceMode(enabled: boolean): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.isComposing) {
      this.deferredEditorAction = { tab, action: 'source', enabled };
      return;
    }
    if (tab.isSourceMode !== enabled) this.toggleSourceView();
  }

  public async toggleEditMode(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.isComposing) {
      this.deferredEditorAction = { tab, action: 'edit' };
      return;
    }
    if (this.editModeRequest) return;
    this.editModeRequest = tab;
    try {
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
          const revision = tab.editRevision;
          const path = tab.filePath;
          const res = await window.electronAPI.confirmSaveDialog(tab.title);
          if (!this.tabs.includes(tab)) return;
          if (tab.editRevision !== revision || tab.filePath !== path || this.isComposing) return;
          if (res.action === 'save') {
            const success = await this.saveTab(tab);
            if (success) {
              tab.isEditMode = false;
              if (this.activeTab === tab) this.updateUIForMode();
            }
            // If save failed: stay in edit mode!
          } else if (res.action === 'dont-save') {
            // Discard changes and revert to savedContent
            tab.rawContent = tab.savedContent;
            tab.isEdited = false;
            tab.isEditMode = false;
            this.markAsSaved(tab);
            if (this.activeTab === tab) this.renderActiveTabContent();
            await this.deleteTabDraft(tab);
          }
          // 'cancel': remain in edit mode
        }
      }
    } catch (error) {
      this.showError(`结束编辑失败，当前修改仍保留：${error instanceof Error ? error.message : '请重试'}`);
    } finally {
      this.editModeRequest = null;
    }
  }

  public toggleSourceView(): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.isComposing) {
      this.deferredEditorAction = { tab, action: 'source' };
      return;
    }

    tab.scrollRatio = this.getScrollRatio();
    tab.isSourceMode = !tab.isSourceMode;

    if (tab.isSourceMode) {
      const markdown = tab.isEdited ? htmlToMarkdown(this.markdownBodyEl) : tab.rawContent;
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

    const sourceMode = tab.isSourceMode;
    this.searchController.refresh();
    requestAnimationFrame(() => {
      if (this.activeTab === tab && tab.isSourceMode === sourceMode) {
        if (this.searchController.isOpen) this.searchController.refresh();
        else this.setScrollRatio(tab.scrollRatio);
      }
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
    this.fileOpenRequests ??= new Map();
    const pending = this.fileOpenRequests.get(filePath);
    if (pending) return pending;
    const request = this.openFileTab(filePath);
    this.fileOpenRequests.set(filePath, request);
    try {
      await request;
    } catch (error) {
      this.showError(`无法打开此文件：${String(error)}`);
    } finally {
      this.fileOpenRequests.delete(filePath);
    }
  }

  private async openFileTab(filePath: string): Promise<void> {
    if (!window.electronAPI) return;
    this.cancelAutoSave();
    if (this.saveInFlight && !await this.saveInFlight) return;

    const hasTabs = !!this.tabs;

    // A real multi-tab window retains the current document. Legacy single-document
    // hosts still need confirmation because opening replaces their only document.
    if (!hasTabs && this.isEdited && this.currentFilePath && this.currentFilePath !== filePath) {
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
    if (!this.tabs) this.tabs = [];

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

    if (thisSessionId === this.renderSessionId || !this.activeTab) this.switchTab(tab.id);
    else this.renderTabBar();
    this.recordRecentFile(filePath);

    // Update file tree active item
    if (this.fileTreeController && this.activeTab === tab) {
      this.fileTreeController.setCurrentFile(filePath);
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      const rootPath = this.fileTreeRootPath && filePath.startsWith(`${this.fileTreeRootPath.replace(/\/$/, '')}/`)
        ? this.fileTreeRootPath : parentPath;
      await this.loadFolderTree(rootPath, thisSessionId);
    }
  }

  private async reloadTabFromDisk(tab: DocumentTab, discardLocalEdits = false): Promise<void> {
    if (!tab.filePath) return;
    const path = tab.filePath;
    const request = {};
    this.reloadRequests.set(tab, request);
    const savedContent = tab.savedContent;
    const revision = tab.revision;
    const editRevision = tab.editRevision;
    try {
      const res = await window.electronAPI.readFile(path);
      // Reads may finish out of order, after Save As/close, or after a save.
      if (this.reloadRequests.get(tab) !== request || !this.tabs.includes(tab) ||
          tab.filePath !== path || this.saveInFlight ||
          tab.savedContent !== savedContent || tab.revision !== revision) return;
      if (!res.success || res.content === undefined) {
        if (this.activeTab === tab) this.showError(res.error || '重新读取文件失败');
        return;
      }
      const canDiscard = discardLocalEdits && tab.editRevision === editRevision;
      if (!canDiscard && res.content === tab.savedContent) {
        // Metadata-only and duplicate notifications must not replace the DOM.
        tab.revision = res.stats?.revision;
        return;
      }
      if (!canDiscard && (tab.isEdited || tab.editRevision !== editRevision)) {
        tab.externalConflict = true;
        if (this.activeTab === tab) {
          this.conflictBannerEl.classList.remove('hidden');
          this.conflictBannerEl.style.display = 'flex';
        }
        this.pauseAutoSave('文件已被外部修改，自动保存已暂停；请先处理冲突。');
        return;
      }
      const contentChanged = res.content !== tab.rawContent || (canDiscard && tab.isEdited);
      if (this.activeTab === tab) tab.scrollRatio = this.getScrollRatio();
      tab.rawContent = res.content;
      tab.savedContent = res.content;
      tab.isEdited = false;
      tab.revision = res.stats?.revision;
      tab.externalConflict = false;
      if (this.activeTabId === tab.id) {
        if (contentChanged) this.renderActiveTabContent();
        this.markAsSaved();
        this.conflictBannerEl.classList.add('hidden');
        this.conflictBannerEl.style.display = 'none';
      }
    } catch (error) {
      if (this.reloadRequests.get(tab) === request && this.activeTab === tab) {
        this.showError(`重新读取文件失败：${String(error)}`);
      }
    }
  }

  private handleExternalFileChange(changedPath: string): void {
    const tab = this.tabs.find((t) => t.filePath === changedPath);
    if (!tab) return;

    if (!this.saveInFlight) {
      // Verify actual disk content before reloading or declaring a conflict.
      void this.reloadTabFromDisk(tab);
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
      return this.handleSaveAs(tab);
    }

    if (tab.isReadOnly) {
      this.setSaveState('failed', tab);
      this.showError('该文件在磁盘上为只读，无法直接写入。请使用“另存为”保存副本。');
      return false;
    }

    if (this.saveInFlight) {
      const success = await this.saveInFlight;
      if (!success) return false;
      return tab.isEdited ? this.saveTab(tab) : true;
    }
    if (!tab.isEdited) return true;

    const contentToSave = this.getTabContent(tab);
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
    this.setSaveState('saving', tab);
    try {
      const disk = await window.electronAPI.readFile(filePath);
      if (!disk.success || disk.content !== baseline) {
        if (tab) tab.externalConflict = true;
        this.setSaveState('failed', tab);
        this.pauseAutoSave(disk.error || '文件已在外部修改，保存已停止；当前修改仍保留，请先处理磁盘上的新版本。', tab);
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
        this.setSaveState('failed', tab);
        this.pauseAutoSave(res.error || '保存文件失败，当前修改仍保留；可使用 Cmd+S 重试。', tab);
        return false;
      }

      if (tab && (!this.tabs.includes(tab) || tab.filePath !== filePath)) return true;
      if (!tab && this.currentFilePath !== filePath) return true;
      const isActive = !tab || this.activeTab === tab;
      if (tab) {
        tab.savedContent = contentToSave;
        tab.revision = res.stats?.revision;
        tab.externalConflict = false;
        tab.autoSavePaused = false;
      } else {
        this.lastSavedContent = contentToSave;
      }
      if (isActive) this.autoSavePaused = false;
      if (isActive && res.stats && this.statusFileSizeEl) {
        const sizeKb = (res.stats.size / 1024).toFixed(1);
        this.statusFileSizeEl.textContent = `${sizeKb} KB`;
      }

      const unchanged = revision === (tab ? tab.editRevision : this.editRevision);
      if (unchanged) {
        if (tab) tab.rawContent = contentToSave;
        else this.currentRawContent = contentToSave;
        this.markAsSaved(tab);
        if (isActive) {
          if (!this.isSourceMode && this.sourceTextareaEl) this.sourceTextareaEl.value = contentToSave;
          this.updateStatsFromText(contentToSave);
          this.hideError();
        }
      } else {
        if (isActive) this.scheduleAutoSave();
      }
      if (unchanged && tab) await this.deleteTabDraft(tab);
      else if (unchanged) await window.electronAPI?.deleteDraft?.(filePath);
      else if (tab) this.scheduleDraftSave(tab);
      return unchanged && revision === (tab ? tab.editRevision : this.editRevision);
    } catch (error) {
      this.setSaveState('failed', tab);
      this.pauseAutoSave(`保存失败，自动保存已暂停；当前修改仍保留：${error instanceof Error ? error.message : '请重试'}`, tab);
      return false;
    } finally {
      if ((tab ? tab.saveState : this.fallbackSaveState) === 'saving') this.setSaveState(undefined, tab);
    }
  }

  public async handleSaveAs(targetTab?: DocumentTab): Promise<boolean> {
    const tab = targetTab ?? this.activeTab;
    if (!tab || !window.electronAPI) return false;

    if (this.isComposing) return false;
    const content = this.getTabContent(tab);
    const revision = tab.editRevision;
    const originalPath = tab.filePath;
    if (tab.saveState === 'saving') return false;
    const previousState = tab.saveState;
    this.setSaveState('saving', tab);
    try {
      const res = await window.electronAPI.saveAsDialog(tab.filePath || undefined, content, { hasBOM: tab.hasBOM, lineEnding: tab.lineEnding });
      if (res.success === false) {
        this.setSaveState('failed', tab);
        this.showError(res.error || '另存为失败，当前修改仍保留');
        return false;
      }
      if (res.canceled) {
        this.setSaveState(previousState, tab);
        return false;
      }
      if (!res.canceled && res.filePath && this.tabs.includes(tab) && tab.filePath === originalPath) {
        tab.filePath = res.filePath;
        tab.title = res.filePath.split('/').pop() || '未命名';
        tab.savedContent = content;
        tab.revision = res.stats?.revision;
        tab.externalConflict = false;
        tab.isReadOnly = false;
        tab.autoSavePaused = false;
        if (this.activeTab === tab) this.autoSavePaused = false;
        const unchanged = tab.editRevision === revision;
        if (unchanged) {
          tab.rawContent = content;
          this.markAsSaved(tab);
        }
        this.renderTabBar();
        this.recordRecentFile(res.filePath);
        if (unchanged) {
          await this.deleteTabDraft(tab);
        } else {
          this.scheduleDraftSave(tab);
        }
        if (this.activeTab === tab) {
          this.docPathEl.textContent = res.filePath;
          this.docPathEl.title = res.filePath;
        }
        if (originalPath && originalPath !== res.filePath && !this.tabs.some(other => other !== tab && other.filePath === originalPath) && !this.fileOpenRequests?.has(originalPath)) {
          await window.electronAPI.unwatchFile?.(originalPath);
        }
        return unchanged && tab.editRevision === revision;
      }
      return false;
    } catch (error) {
      this.setSaveState('failed', tab);
      this.showError(`另存为失败，当前修改仍保留：${error instanceof Error ? error.message : '请重试'}`);
      return false;
    } finally {
      if ((tab.saveState as DocumentTab['saveState']) === 'saving') this.setSaveState(undefined, tab);
    }
  }

  public async handleSaveCopy(): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab || !window.electronAPI) return false;

    const content = this.getTabContent(tab);
    const res = await window.electronAPI.saveCopyDialog(tab.filePath || undefined, content);
    if (!res.canceled && res.success) {
      this.showError(`已成功存储副本至: ${res.filePath?.split('/').pop()}`);
      setTimeout(() => this.hideError(), 2500);
      return true;
    }
    return false;
  }

  // --- Auto-Recovery Drafts ---

  private cancelDraftSave(tab: DocumentTab): void {
    const timeout = this.draftTimeouts?.get(tab);
    if (timeout) clearTimeout(timeout);
    this.draftTimeouts?.delete(tab);
  }

  private queueDraftOperation(tab: DocumentTab, operation: () => Promise<void>): Promise<void> {
    this.draftOperations ??= new Map();
    const previous = this.draftOperations.get(tab) ?? Promise.resolve();
    const pending = previous.then(operation).catch(error => {
      this.showError(`恢复草稿处理失败：${String(error)}`);
    });
    this.draftOperations.set(tab, pending);
    void pending.then(() => {
      if (this.draftOperations.get(tab) === pending) this.draftOperations.delete(tab);
    });
    return pending;
  }

  private deleteTabDraft(tab: DocumentTab): Promise<void> {
    this.cancelDraftSave(tab);
    return this.queueDraftOperation(tab, async () => {
      await window.electronAPI?.deleteDraft?.(tab.draftId);
      await this.removeRecoveredDraft(tab);
    });
  }

  private async removeRecoveredDraft(tab: DocumentTab): Promise<void> {
    if (!tab.recoveredDraftId) return;
    const result = await window.electronAPI?.deleteDraft?.(tab.recoveredDraftId, tab.recoveredDraft);
    if (result?.success === false && !result.conflict) throw new Error('无法清理旧恢复草稿');
    // An updated draft belongs to another snapshot; leave it available for later recovery.
    tab.recoveredDraftId = undefined;
    tab.recoveredDraft = undefined;
  }

  private scheduleDraftSave(tab = this.activeTab): void {
    if (!tab || !tab.isEdited) return;
    this.cancelDraftSave(tab);
    this.draftTimeouts ??= new Map();
    this.draftTimeouts.set(tab, setTimeout(() => {
      this.draftTimeouts.delete(tab);
      if (!this.tabs.includes(tab) || !tab.isEdited || (this.activeTab === tab && this.isComposing)) return;
      const revision = tab.editRevision;
      const draft = {
        id: tab.draftId,
        filePath: tab.filePath || undefined,
        content: this.getTabContent(tab),
        savedContent: tab.savedContent,
        revision: tab.revision,
        hasBOM: tab.hasBOM,
        lineEnding: tab.lineEnding,
        timestamp: Date.now()
      };
      void this.queueDraftOperation(tab, async () => {
        let result;
        try {
          result = await window.electronAPI?.saveDraft(draft);
          if (result?.success === false) throw new Error('无法保存恢复草稿');
          if (result?.success) {
            tab.draftSavedRevision = revision;
            tab.draftBackupFailed = false;
          }
        } catch (error) {
          tab.draftBackupFailed = true;
          throw error;
        } finally {
          this.updateSaveStatus();
        }
        if (result?.success && tab.recoveredDraftId) {
          await this.removeRecoveredDraft(tab);
        }
      });
    }, 1500));
  }

  private isDraftOpen(id: string): boolean {
    return this.tabs.some(tab => tab.recoveredDraftId === id || tab.draftId === id);
  }

  private sameDraft(a: RecoveryDraft, b: RecoveryDraft): boolean {
    const keys: Array<keyof RecoveryDraft> = ['id', 'filePath', 'content', 'timestamp', 'savedContent', 'revision', 'hasBOM', 'lineEnding'];
    return keys.every(key => a[key] === b[key]);
  }

  private setRecoveryStatus(message: string): void {
    const status = document.getElementById('draft-recovery-status');
    if (status) status.textContent = message;
  }

  private async checkCrashRecoveryDrafts(showEmpty = false, openDialog = true): Promise<void> {
    if (!window.electronAPI?.getAllDrafts) return;
    const request = this.recoveryRequestId = (this.recoveryRequestId || 0) + 1;
    try {
      const res = await window.electronAPI.getAllDrafts();
      if (request !== this.recoveryRequestId) return;
      const drafts = res.drafts.filter(draft => !this.isDraftOpen(draft.id));
      this.renderDraftRecoveryList(drafts);
      if (openDialog && (drafts.length || showEmpty) && !this.draftRecoveryDialogEl.open) this.draftRecoveryDialogEl.showModal();
    } catch (error) {
      if (showEmpty) {
        this.setRecoveryStatus(`无法读取草稿：${String(error)}`);
        if (!this.draftRecoveryDialogEl.open) this.draftRecoveryDialogEl.showModal();
      } else console.warn('Failed to inspect drafts:', error);
    }
  }

  private previewDraft(draft?: RecoveryDraft): void {
    this.previewDraftId = draft?.id;
    const title = document.getElementById('draft-recovery-preview-title');
    const path = document.getElementById('draft-recovery-preview-path');
    const preview = document.getElementById('draft-recovery-preview');
    if (title) title.textContent = draft ? draft.filePath?.split('/').pop() || '未命名草稿' : '选择草稿以预览';
    if (path) path.textContent = draft?.filePath || (draft ? '未关联文件 · 恢复后请另存为' : '');
    // Plain text only: draft Markdown/HTML must never execute or fetch remote resources here.
    if (preview) preview.textContent = draft ? draft.content.slice(0, 20000) + (draft.content.length > 20000 ? '\n…（仅预览前 20,000 字符，恢复时保留全文）' : '') : '';
    this.draftRecoveryListEl.querySelectorAll<HTMLElement>('[data-draft-id]').forEach(row => {
      row.classList.toggle('previewing', row.dataset.draftId === draft?.id);
    });
  }

  private updateRecoverySelection(): void {
    const button = document.getElementById('btn-recover-drafts') as HTMLButtonElement | null;
    const count = this.selectedDraftIds?.size || 0;
    if (button) {
      button.disabled = this.recoveryBusy || count === 0;
      button.textContent = count ? `恢复所选（${count}）` : '恢复所选';
    }
    this.draftRecoveryListEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => {
      control.disabled = this.recoveryBusy;
    });
    this.setRecoveryStatus(this.recoveryBusy ? '正在处理草稿…' : this.recoveryDrafts.length ? `共 ${this.recoveryDrafts.length} 篇，已选择 ${count} 篇` : '暂无可恢复草稿；正在打开的文档不会在此重复列出。');
  }

  private renderDraftRecoveryList(drafts: RecoveryDraft[]): void {
    const previous = this.recoveryDrafts || [];
    const selected = this.selectedDraftIds || new Set<string>();
    this.recoveryDrafts = drafts;
    this.selectedDraftIds = new Set(drafts.filter(draft => selected.has(draft.id) && previous.some(old => this.sameDraft(old, draft))).map(draft => draft.id));
    this.draftRecoveryListEl.innerHTML = '';
    for (const draft of drafts) {
      const li = document.createElement('li');
      li.className = 'draft-recovery-item';
      li.dataset.draftId = draft.id;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.selectedDraftIds.has(draft.id);
      const name = draft.filePath?.split('/').pop() || '未命名草稿';
      checkbox.setAttribute('aria-label', `选择草稿：${name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selectedDraftIds.add(draft.id);
        else this.selectedDraftIds.delete(draft.id);
        this.previewDraft(draft);
        this.updateRecoverySelection();
      });
      const preview = document.createElement('button');
      preview.className = 'draft-item-preview';
      preview.type = 'button';
      const title = document.createElement('strong');
      title.textContent = name;
      const date = document.createElement('span');
      date.textContent = new Date(draft.timestamp).toLocaleString();
      const path = document.createElement('span');
      path.className = 'draft-item-path';
      path.textContent = draft.filePath || '未关联文件';
      preview.append(title, date, path);
      preview.addEventListener('click', () => this.previewDraft(draft));
      const actions = document.createElement('div');
      actions.className = 'draft-item-actions';
      const discard = document.createElement('button');
      discard.className = 'btn-secondary btn-sm draft-item-discard';
      discard.type = 'button';
      discard.textContent = '丢弃';
      discard.setAttribute('aria-label', `丢弃草稿：${name}`);
      const cancel = document.createElement('button');
      cancel.className = 'btn-secondary btn-sm';
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.hidden = true;
      cancel.addEventListener('click', () => { discard.textContent = '丢弃'; cancel.hidden = true; this.updateRecoverySelection(); });
      discard.addEventListener('click', () => {
        if (cancel.hidden) {
          cancel.hidden = false;
          discard.textContent = '确认丢弃';
          this.previewDraft(draft);
          this.setRecoveryStatus(`确认丢弃“${name}”？无法撤销，原文件不受影响。`);
        } else void this.discardRecoveryDraft(draft);
      });
      actions.append(discard, cancel);
      li.append(checkbox, preview, actions);
      this.draftRecoveryListEl.appendChild(li);
    }
    this.previewDraft(drafts.find(draft => draft.id === this.previewDraftId) || drafts[0]);
    this.updateRecoverySelection();
  }

  private async discardRecoveryDraft(draft: RecoveryDraft): Promise<void> {
    if (this.recoveryBusy) return;
    this.recoveryBusy = true;
    this.updateRecoverySelection();
    let message = '';
    try {
      if (this.isDraftOpen(draft.id)) throw new Error('该草稿已在标签页打开，未删除');
      const result = await window.electronAPI.deleteDraft(draft.id, draft);
      if (!result.success) throw new Error(result.error || (result.conflict ? '草稿已更新，请重新预览后再操作' : '删除失败，请重试'));
      message = '已丢弃该草稿，原文件未修改。';
    } catch (error) { message = String(error); }
    finally {
      this.recoveryBusy = false;
      await this.checkCrashRecoveryDrafts(false, false);
      this.updateRecoverySelection();
      this.setRecoveryStatus(message);
    }
  }

  private async recoverSelectedDrafts(): Promise<void> {
    if (this.recoveryBusy || !this.selectedDraftIds?.size) return;
    const selected = this.recoveryDrafts.filter(draft => this.selectedDraftIds.has(draft.id));
    this.recoveryBusy = true;
    this.updateRecoverySelection();
    let recovered = 0;
    let message = '';
    try {
      recovered = await this.recoverDrafts(selected);
      message = `已恢复 ${recovered} 篇。` + (recovered < selected.length ? '部分草稿已更新、移除或打开，请重新预览后选择。' : '');
    } catch (error) { message = `恢复失败，草稿仍保留：${String(error)}`; }
    finally {
      this.recoveryBusy = false;
      this.selectedDraftIds.clear();
      await this.checkCrashRecoveryDrafts(false, false);
      this.updateRecoverySelection();
      this.setRecoveryStatus(message);
      if (recovered === selected.length && !this.recoveryDrafts.length) this.draftRecoveryDialogEl.close();
    }
  }

  private async recoverAllDrafts(): Promise<void> {
    const res = await window.electronAPI?.getAllDrafts();
    if (res?.drafts) await this.recoverDrafts(res.drafts);
  }

  private async recoverDrafts(drafts: RecoveryDraft[]): Promise<number> {
    let recovered = 0;
    for (const draft of drafts) {
      if (this.isDraftOpen(draft.id)) continue;
      // Old drafts have no trustworthy disk baseline. Keep them as detached copies.
      const filePath = typeof draft.savedContent === 'string' ? draft.filePath || null : null;
      let disk: Awaited<ReturnType<BridgeAPI['readFile']>> | undefined;
      if (filePath && !this.tabs.some(tab => tab.filePath === filePath)) {
        try { disk = await window.electronAPI.readFile(filePath); }
        catch { disk = { success: false }; }
      }
      const latest = await window.electronAPI.getAllDrafts();
      if (this.isDraftOpen(draft.id) || !latest.drafts.some(current => this.sameDraft(current, draft))) continue;
      const existing = filePath ? this.tabs.find(tab => tab.filePath === filePath) : undefined;
      const tab = this.createTab({
        filePath: existing ? null : filePath,
        recoveredDraftId: draft.id,
        recoveredDraft: { ...draft },
        title: draft.filePath ? draft.filePath.split('/').pop()! : '已恢复草稿',
        rawContent: draft.content,
        savedContent: draft.savedContent ?? '',
        hasBOM: draft.hasBOM,
        lineEnding: draft.lineEnding,
        revision: draft.revision,
        isReadOnly: disk?.stats?.isReadOnly,
        externalConflict: !!filePath && !existing && (!disk?.success || disk.content !== draft.savedContent),
        isEdited: true,
        isEditMode: true
      });
      this.switchTab(tab.id);
      this.scheduleDraftSave(tab);
      recovered++;
      if (draft.filePath && !tab.filePath) this.showError('该草稿缺少原始版本记录或同名文件已打开，已恢复为独立副本；请使用“另存为”保存。');
    }
    return recovered;
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

  private pauseAutoSave(message: string, tab?: DocumentTab): void {
    if (tab) tab.autoSavePaused = true;
    if (!tab || this.activeTab === tab) {
      this.autoSavePaused = true;
      this.cancelAutoSave();
      this.showError(message);
    }
    this.updateSaveStatus();
  }

  // --- Search ---

  public openSearch(): void {
    this.searchController.open();
  }

  // --- Window Close Handling ---

  public async prepareToClose(): Promise<boolean> {
    if (this.closePreparation) return this.closePreparation;
    this.closeApproval = null;
    const request = this.confirmWindowDocuments().catch(error => {
      this.showError(`关闭失败，当前修改仍保留：${String(error)}`);
      return false;
    });
    this.closePreparation = request;
    try {
      return await request;
    } catch (error) {
      this.showError(`关闭失败，当前修改仍保留：${String(error)}`);
      return false;
    } finally {
      this.closePreparation = null;
      if (!this.closeApproval) this.scheduleAutoSave();
    }
  }

  public isPreparedToClose(): boolean {
    return !!this.closeApproval && !this.isComposing &&
      !this.fileOpenRequests?.size &&
      this.tabs.length === this.closeApproval.length &&
      this.closeApproval.every(({ tab, revision, path }) =>
        this.tabs.includes(tab) && tab.editRevision === revision && tab.filePath === path);
  }

  public cancelClosePreparation(): void {
    this.closeApproval = null;
    this.scheduleAutoSave();
  }

  private async confirmWindowDocuments(): Promise<boolean> {
    this.cancelAutoSave();
    if (this.isComposing || (this.saveInFlight && !await this.saveInFlight)) return false;
    const snapshot = this.tabs.map(tab => ({ tab, revision: tab.editRevision, path: tab.filePath }));
    for (const state of snapshot) {
      const { tab, revision, path } = state;
      if (!this.tabs.includes(tab) || tab.editRevision !== revision || tab.filePath !== path) return false;
      if (!tab.isEdited) continue;
      const res = await window.electronAPI?.confirmSaveDialog(tab.title);
      if (!this.tabs.includes(tab) || tab.editRevision !== revision || tab.filePath !== path || this.isComposing) return false;
      if (res?.action === 'save') {
        if (!await this.saveTab(tab) || tab.isEdited) return false;
        state.path = tab.filePath;
      } else if (res?.action !== 'dont-save') {
        return false;
      }
    }
    this.closeApproval = snapshot;
    if (!this.isPreparedToClose()) {
      this.closeApproval = null;
      return false;
    }
    return true;
  }

  public async handleRequestClose(): Promise<void> {
    if (this.tabs) {
      if (await this.prepareToClose() && this.isPreparedToClose()) await window.electronAPI?.closeWindow();
      return;
    }

    // Fallback for headless / single document instance without initialized tabs
    this.cancelAutoSave();
    if (this.saveInFlight && !await this.saveInFlight) return;
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

  private setSaveState(state: 'saving' | 'failed' | undefined, tab?: DocumentTab): void {
    if (tab) tab.saveState = state;
    else this.fallbackSaveState = state;
    this.updateSaveStatus();
  }

  public updateSaveStatus(): void {
    const tab = this.activeTab;
    const hasDocument = !!tab || (!this.tabs && !!this.currentFilePath);
    const state = tab ? tab.saveState : this.fallbackSaveState;
    const automatic = this.currentSettings?.saveMode === 'auto';
    if (this.statusSavePolicyEl) {
      this.statusSavePolicyEl.textContent = automatic ? (this.autoSavePaused ? '自动保存已暂停' : '自动保存') : '手动保存';
      this.statusSavePolicyEl.title = automatic && tab && !tab.filePath
        ? '新文档需先另存为，之后自动保存到该文件' : automatic ? '停止输入后自动保存到原文件' : '按 Cmd+S 保存到原文件';
    }
    if (this.statusSaveBadgeEl) {
      let text = '未打开文件';
      let kind = '';
      if (hasDocument) {
        if (state === 'saving') { text = '正在保存…'; kind = 'saving'; }
        else if (state === 'failed') { text = '保存失败'; kind = 'failed'; }
        else if (tab?.externalConflict) { text = '外部版本有变化'; kind = 'unsaved'; }
        else if (this.isEdited || (tab && !tab.filePath)) { text = '未保存'; kind = 'unsaved'; }
        else { text = '已保存'; kind = 'saved'; }
      }
      this.statusSaveBadgeEl.textContent = text;
      this.statusSaveBadgeEl.className = `status-save-badge ${kind}`.trim();
      this.statusSaveBadgeEl.style.display = 'inline';
    }
    if (this.statusDraftBackupEl) {
      this.statusDraftBackupEl.textContent = !tab?.isEdited ? '' : tab.draftBackupFailed
        ? '恢复草稿备份失败' : tab.draftSavedRevision === tab.editRevision
          ? '恢复草稿已备份' : '恢复草稿待备份';
      this.statusDraftBackupEl.classList.toggle('failed', !!tab?.isEdited && !!tab.draftBackupFailed);
      this.statusDraftBackupEl.title = '本地恢复草稿独立保存；不会替代原文件的保存';
    }
  }

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

    this.updateSaveStatus();
  }

  public markAsSaved(targetTab?: DocumentTab): void {
    const tab = targetTab ?? this.activeTab;
    if (tab) {
      tab.isEdited = false;
      tab.saveState = undefined;
      tab.draftSavedRevision = undefined;
      tab.draftBackupFailed = false;
      this.cancelDraftSave(tab);
    } else {
      this._isEdited = false;
      this.fallbackSaveState = undefined;
    }
    this.updateDocumentEdited();
    this.renderTabBar();
    if (tab && this.activeTab !== tab) return;
    this.cancelAutoSave();

    const fileName = this.activeTab ? this.activeTab.title : (this.currentFilePath ? this.currentFilePath.split('/').pop() || '未命名' : '未命名');
    if (this.docTitleEl) {
      this.docTitleEl.textContent = fileName;
    }
    this.renderTabBar();

    this.updateSaveStatus();
  }

  private refreshPastedDocument(): void {
    const tab = this.activeTab;
    if (!tab || !tab.isEditMode || tab.isSourceMode) return;
    tab.rawContent = this.getTabContent(tab);
    setMathEditingEnabled(this.markdownBodyEl, true);
    this.outlineController.update(Array.from(this.markdownBodyEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'), heading => ({
      id: heading.id,
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent || ''
    })));
    this.searchController.refresh();
    this.updateStatsFromText(this.markdownBodyEl.innerText || '');
  }

  private handleEditorInput(e: Event): void {
    if (!this.isEditMode) return;
    this.markAsEdited();
    const text = this.markdownBodyEl.innerText || '';
    this.updateStatsFromText(text);
    if (e.target === this.markdownBodyEl && ['historyUndo', 'historyRedo'].includes((e as InputEvent).inputType)) this.refreshPastedDocument();
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
    this.updateSaveStatus();
  }

  private saveSetting(update: any): void {
    this.currentSettings = { ...this.currentSettings, ...update };
    this.updateSaveStatus();
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
