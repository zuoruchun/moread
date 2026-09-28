import { parseMarkdown, extractHeadings } from './modules/parser.ts';
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

  // Header Elements
  public selectThemeEl!: HTMLSelectElement;
  public selectWidthEl!: HTMLSelectElement;
  public btnToggleSourceEl!: HTMLButtonElement;
  public btnToggleSidebarEl!: HTMLButtonElement;
  public btnToggleOutlineEl!: HTMLButtonElement;

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

    this.selectThemeEl = document.getElementById('select-theme') as HTMLSelectElement;
    this.selectWidthEl = document.getElementById('select-reading-width') as HTMLSelectElement;
    this.btnToggleSourceEl = document.getElementById('btn-toggle-source') as HTMLButtonElement;
    this.btnToggleSidebarEl = document.getElementById('btn-toggle-sidebar') as HTMLButtonElement;
    this.btnToggleOutlineEl = document.getElementById('btn-toggle-outline') as HTMLButtonElement;
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
    if (window.electronAPI) {
      this.currentSettings = await window.electronAPI.getSettings();
      this.applySettings(this.currentSettings);
      this.renderRecentList(this.currentSettings.recentFiles || []);

      window.electronAPI.onOpenFile((filePath) => this.loadFile(filePath));
      window.electronAPI.onOpenFolder?.(async (folderPath) => {
        const folderRes = await window.electronAPI.readFolder(folderPath);
        if (folderRes.success && folderRes.nodes) {
          this.fileTreeController.update(folderRes.nodes, this.currentFilePath);
          this.switchSidebarTab('files');
          this.showSidebar();
        }
      });
      window.electronAPI.onFileChanged((changedPath) => {
        if (this.currentFilePath === changedPath) {
          this.reloadCurrentFilePreservingScroll();
        }
      });
      window.electronAPI.onMenuAction((action) => this.handleMenuAction(action));
    }
  }

  private initEventListeners(): void {
    // Welcome screen actions
    document.getElementById('btn-welcome-open-file')?.addEventListener('click', () => this.triggerOpenFile());
    document.getElementById('btn-welcome-open-folder')?.addEventListener('click', () => this.triggerOpenFolder());
    document.getElementById('btn-clear-recent')?.addEventListener('click', async () => {
      if (window.electronAPI) {
        await window.electronAPI.saveSettings({ recentFiles: [] });
        this.renderRecentList([]);
      }
    });

    // Toolbar actions
    this.btnToggleSidebarEl.addEventListener('click', () => this.toggleSidebar());
    this.btnToggleOutlineEl.addEventListener('click', () => this.toggleOutline());
    this.btnToggleSourceEl.addEventListener('click', () => this.toggleSourceView());
    document.getElementById('btn-search')?.addEventListener('click', () => this.searchController.open());

    // Font size controls
    document.getElementById('btn-font-increase')?.addEventListener('click', () => this.changeFontSize(1));
    document.getElementById('btn-font-decrease')?.addEventListener('click', () => this.changeFontSize(-1));

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
    this.outlineTabBtn.addEventListener('click', () => this.switchSidebarTab('outline'));
    this.filesTabBtn.addEventListener('click', () => this.switchSidebarTab('files'));

    // Global Drag & Drop for Markdown files
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          this.loadFile((file as any).path || file.name);
        }
      }
    });

    // System theme change listener
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.currentSettings.theme === 'system') {
        this.applyTheme('system');
      }
    });

    // Delegate copy and link events in markdown body
    this.markdownBodyEl.addEventListener('click', (e) => this.handleContentClick(e));
  }

  private handleContentClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // 1. Code copy button
    if (target.classList.contains('code-copy-btn')) {
      const rawCode = decodeURIComponent(target.dataset.code || '');
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

    // 2. Links
    const anchor = target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#')) {
        e.preventDefault();
        const id = href.slice(1);
        this.outlineController.scrollToHeading(id);
      } else if (href.startsWith('http://') || href.startsWith('https://')) {
        e.preventDefault();
        window.electronAPI?.openExternal(href);
      } else if (href.endsWith('.md') || href.endsWith('.markdown') || href.includes('.md#') || href.includes('.markdown#')) {
        e.preventDefault();
        this.handleRelativeDocLink(href);
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

    // Update title and path
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    this.docTitleEl.textContent = fileName;
    this.docPathEl.textContent = filePath;
    this.docPathEl.title = filePath;

    // Update status bar
    const sizeKb = ((res.stats?.size || 0) / 1024).toFixed(1);
    this.statusFileSizeEl.textContent = `${sizeKb} KB`;

    const charCount = res.content.length;
    const lineCount = res.content.split('\n').length;
    this.statusStatsEl.textContent = `${charCount} 字符 · ${lineCount} 行`;

    // Render Markdown
    const renderedHtml = parseMarkdown(res.content, {
      currentFilePath: filePath,
      allowRemoteImages: this.currentSettings.allowRemoteImages
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
    } else {
      this.markdownScrollWrapperEl.classList.remove('hidden');
      this.markdownScrollWrapperEl.style.display = 'flex';
      this.sourceViewEl.classList.add('hidden');
      this.sourceViewEl.style.display = 'none';
    }

    // Scroll to top
    this.markdownScrollWrapperEl.scrollTop = 0;

    // Update file tree active item
    this.fileTreeController.setCurrentFile(filePath);
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
      const folderRes = await window.electronAPI.readFolder(res.folderPath);
      if (folderRes.success && folderRes.nodes) {
        this.fileTreeController.update(folderRes.nodes, this.currentFilePath);
        this.switchSidebarTab('files');
        this.showSidebar();
      }
    }
  }

  public toggleSidebar(): void {
    if (this.sidebarEl.classList.contains('collapsed')) {
      this.showSidebar();
    } else {
      this.hideSidebar();
    }
  }

  public showSidebar(): void {
    this.sidebarEl.classList.remove('collapsed');
    this.btnToggleSidebarEl.classList.add('active');
  }

  public hideSidebar(): void {
    this.sidebarEl.classList.add('collapsed');
    this.btnToggleSidebarEl.classList.remove('active');
  }

  public toggleOutline(): void {
    if (this.sidebarEl.classList.contains('collapsed')) {
      this.switchSidebarTab('outline');
      this.showSidebar();
    } else if (this.outlineTabBtn.classList.contains('active')) {
      this.hideSidebar();
    } else {
      this.switchSidebarTab('outline');
    }
  }

  public switchSidebarTab(tab: 'outline' | 'files'): void {
    if (tab === 'outline') {
      this.outlineTabBtn.classList.add('active');
      this.filesTabBtn.classList.remove('active');
      this.outlineContentEl.classList.remove('hidden');
      this.outlineContentEl.style.display = 'block';
      this.filesContentEl.classList.add('hidden');
      this.filesContentEl.style.display = 'none';
      this.btnToggleOutlineEl.classList.add('active');
    } else {
      this.filesTabBtn.classList.add('active');
      this.outlineTabBtn.classList.remove('active');
      this.filesContentEl.classList.remove('hidden');
      this.filesContentEl.style.display = 'block';
      this.outlineContentEl.classList.add('hidden');
      this.outlineContentEl.style.display = 'none';
      this.btnToggleOutlineEl.classList.remove('active');
    }
  }

  public toggleSourceView(): void {
    this.isSourceMode = !this.isSourceMode;
    if (this.isSourceMode) {
      this.btnToggleSourceEl.classList.add('active');
      this.markdownScrollWrapperEl.classList.add('hidden');
      this.markdownScrollWrapperEl.style.display = 'none';
      this.sourceViewEl.classList.remove('hidden');
      this.sourceViewEl.style.display = 'block';
      this.sourceTextareaEl.value = this.currentRawContent;
    } else {
      this.btnToggleSourceEl.classList.remove('active');
      this.sourceViewEl.classList.add('hidden');
      this.sourceViewEl.style.display = 'none';
      this.markdownScrollWrapperEl.classList.remove('hidden');
      this.markdownScrollWrapperEl.style.display = 'flex';
    }
  }

  public changeFontSize(delta: number): void {
    let current = parseInt(this.markdownBodyEl.style.fontSize || '16', 10);
    current = Math.max(12, Math.min(28, current + delta));
    this.markdownBodyEl.style.fontSize = `${current}px`;
    this.saveSetting({ fontSize: current });
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
    }
    if (settings.showSidebar) {
      this.showSidebar();
    } else {
      this.hideSidebar();
    }
  }

  private saveSetting(update: any): void {
    this.currentSettings = { ...this.currentSettings, ...update };
    window.electronAPI?.saveSettings(this.currentSettings);
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
        this.markdownBodyEl.style.fontSize = '16px';
        this.saveSetting({ fontSize: 16 });
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
