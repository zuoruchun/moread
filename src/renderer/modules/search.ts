export interface TextMatch { start: number; end: number }

// Match original UTF-16 offsets, including Unicode whose lowercase length changes.
export function findLiteralMatches(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(text.matchAll(expression), match => ({ start: match.index!, end: match.index! + match[0].length }));
}

interface SearchMatch extends TextMatch {
  range?: Range;
  editor?: HTMLTextAreaElement;
  text: string;
}

interface SearchContext {
  source: HTMLTextAreaElement;
  isSource: () => boolean;
  canReplace: () => boolean;
  isComposing: () => boolean;
  hasDocument: () => boolean;
}

export class SearchController {
  private matches: SearchMatch[] = [];
  private currentIndex = -1;
  private context?: SearchContext;
  private replaceInput: HTMLInputElement;
  private replaceBtn: HTMLButtonElement;
  private replaceAllBtn: HTMLButtonElement;
  private messageEl: HTMLElement;
  private mirror?: HTMLElement;
  private fallback?: HTMLElement;
  private refreshFrame = 0;
  private replacing = false;

  constructor(
    private contentContainer: HTMLElement,
    private searchBar: HTMLElement,
    private inputEl: HTMLInputElement,
    private countEl: HTMLElement,
    private prevBtn: HTMLButtonElement,
    private nextBtn: HTMLButtonElement,
    private closeBtn: HTMLButtonElement
  ) {
    this.replaceInput = searchBar.querySelector('#replace-input')!;
    this.replaceBtn = searchBar.querySelector('#btn-search-replace')!;
    this.replaceAllBtn = searchBar.querySelector('#btn-search-replace-all')!;
    this.messageEl = searchBar.querySelector('#search-message')!;
    this.inputEl.addEventListener('input', () => { this.messageEl.textContent = ''; this.performSearch(); });
    this.inputEl.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); this.navigate(event.shiftKey ? -1 : 1); }
    });
    this.searchBar.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.close(); }
    });
    this.replaceInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.replace(false); }
    });
    this.prevBtn.addEventListener('click', () => this.navigate(-1));
    this.nextBtn.addEventListener('click', () => this.navigate(1));
    this.closeBtn.addEventListener('click', () => this.close());
    this.replaceBtn.addEventListener('click', () => this.replace(false));
    this.replaceAllBtn.addEventListener('click', () => this.replace(true));
    this.contentContainer.addEventListener('input', () => this.scheduleRefresh());
    window.addEventListener('resize', () => this.scheduleRefresh());
    window.addEventListener('scroll', () => { if (this.fallback) this.scheduleRefresh(); }, true);
  }

  public configure(context: SearchContext): void {
    this.context = context;
    context.source.addEventListener('input', () => this.scheduleRefresh());
    context.source.addEventListener('scroll', () => this.syncMirrorScroll());
    window.addEventListener('compositionstart', () => this.updateCount());
    window.addEventListener('compositionend', () => this.scheduleRefresh());
  }

  public get isOpen(): boolean {
    return !this.searchBar.classList.contains('hidden');
  }

  public open(): void {
    this.searchBar.classList.remove('hidden');
    this.layoutSearchBar();
    this.inputEl.focus();
    this.inputEl.select();
    this.performSearch();
  }

  public close(): void {
    this.searchBar.classList.add('hidden');
    this.searchBar.parentElement!.classList.remove('search-open');
    this.clearHighlights();
    this.matches = [];
    this.currentIndex = -1;
    this.messageEl.textContent = '';
    this.updateCount();
    (this.context?.isSource() ? this.context.source : this.contentContainer).focus();
  }

  public setContentBase(_html: string): void {
    this.refresh();
  }

  public refresh(): void {
    this.messageEl.textContent = '';
    if (this.searchBar.classList.contains('hidden')) this.clearHighlights();
    else this.performSearch();
  }

  private layoutSearchBar(): void {
    const parent = this.searchBar.parentElement!;
    parent.classList.add('search-open');
    parent.style.setProperty('--search-bar-space', `${this.searchBar.offsetHeight + 24}px`);
  }

  private scheduleRefresh(): void {
    if (this.replacing || this.searchBar.classList.contains('hidden') || this.refreshFrame) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0;
      this.performSearch(false);
    });
  }

  public clearHighlights(): void {
    // Search decorations never change editable Markdown or its undo history.
    CSS.highlights?.delete('moread-search');
    CSS.highlights?.delete('moread-search-current');
    this.mirror?.remove();
    this.mirror = undefined;
    this.fallback?.remove();
    this.fallback = undefined;
    this.context?.source.classList.remove('search-highlighted');
  }

  public performSearch(scroll = true): void {
    const previousIndex = this.currentIndex;
    if (!this.searchBar.classList.contains('hidden')) this.layoutSearchBar();
    this.clearHighlights();
    this.matches = [];
    this.currentIndex = -1;
    const query = this.inputEl.value;
    if (!query || (this.context && !this.context.hasDocument())) { this.updateCount(); return; }
    if (this.context?.isSource()) {
      const editor = this.context.source;
      this.matches = findLiteralMatches(editor.value, query).map(match => ({ ...match, editor, text: editor.value.slice(match.start, match.end) }));
      this.createSourceMirror(editor);
    } else {
      this.collectRenderedMatches(query);
    }
    if (this.matches.length) this.currentIndex = scroll ? 0 : Math.min(Math.max(0, previousIndex), this.matches.length - 1);
    this.paintHighlights(scroll);
    this.updateCount();
  }

  private collectRenderedMatches(query: string): void {
    const groups = new Map<Element, Text[]>();
    const walker = document.createTreeWalker(this.contentContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, button, textarea, input, svg, mjx-container, .code-block-header, .raw-math-marker, .math-inline-wrapper, .math-block-wrapper, .math-inline-fallback, [hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        if (!parent.getClientRects().length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const group = node.parentElement!.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote') || node.parentElement!;
      const list = groups.get(group) || [];
      list.push(node as Text);
      groups.set(group, list);
    }
    for (const [group, nodes] of groups) {
      const text = nodes.map(node => node.data).join('');
      const editor = group.closest('.code-block-container')?.querySelector<HTMLTextAreaElement>('textarea.code-editor') || undefined;
      for (const match of findLiteralMatches(text, query)) {
        const range = document.createRange();
        let offset = 0;
        for (const node of nodes) {
          if (match.start >= offset && match.start < offset + node.length) range.setStart(node, match.start - offset);
          if (match.end > offset && match.end <= offset + node.length) { range.setEnd(node, match.end - offset); break; }
          offset += node.length;
        }
        if (range.toString() !== text.slice(match.start, match.end) ||
            range.cloneContents().querySelector('.math-inline-wrapper, .math-block-wrapper, .math-inline-fallback, textarea, button, input')) continue;
        this.matches.push({ ...match, range, editor, text: text.slice(match.start, match.end) });
      }
    }
    // A paragraph inside a list can be a separate group; retain document order.
    this.matches.sort((a, b) => a.range!.compareBoundaryPoints(Range.START_TO_START, b.range!));
  }

  private createSourceMirror(editor: HTMLTextAreaElement): void {
    const mirror = document.createElement('div');
    mirror.className = 'search-source-overlay';
    mirror.setAttribute('aria-hidden', 'true');
    const style = getComputedStyle(editor);
    Object.assign(mirror.style, {
      left: `${editor.offsetLeft}px`, top: `${editor.offsetTop}px`, width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px`,
      fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing, tabSize: style.tabSize
    });
    const text = document.createElement('div');
    text.className = 'search-source-text';
    text.style.padding = style.padding;
    text.style.whiteSpace = editor.wrap === 'off' ? 'pre' : 'pre-wrap';
    let offset = 0;
    for (const match of this.matches) {
      text.append(document.createTextNode(editor.value.slice(offset, match.start)));
      const mark = document.createElement('mark');
      mark.className = 'mored-search-match';
      mark.textContent = editor.value.slice(match.start, match.end);
      text.append(mark);
      offset = match.end;
    }
    text.append(document.createTextNode(editor.value.slice(offset) + '\n'));
    mirror.append(text);
    editor.parentElement!.append(mirror);
    editor.classList.add('search-highlighted');
    this.mirror = mirror;
    this.syncMirrorScroll();
  }

  private syncMirrorScroll(): void {
    if (!this.mirror || !this.context) return;
    const editor = this.context.source;
    (this.mirror.firstElementChild as HTMLElement).style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  }

  private paintHighlights(scroll: boolean): void {
    const current = this.matches[this.currentIndex];
    if (scroll && current?.range) {
      const element = current.range.startContainer.parentElement!;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const scroller = this.contentContainer.closest('#markdown-scroll-wrapper')!;
      const rect = current.range.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top - viewport.top - viewport.height / 2;
    }
    if (this.mirror && this.context) {
      const marks = Array.from(this.mirror.querySelectorAll<HTMLElement>('mark'));
      marks.forEach((mark, index) => mark.classList.toggle('current', index === this.currentIndex));
      const mark = marks[this.currentIndex];
      if (scroll && mark) {
        const editor = this.context.source;
        const rect = mark.getBoundingClientRect(), viewport = editor.getBoundingClientRect();
        const inset = this.searchBar.getBoundingClientRect().bottom > viewport.top ? this.searchBar.getBoundingClientRect().bottom - viewport.top + 12 : 12;
        editor.scrollTop = Math.max(0, editor.scrollTop + rect.top - viewport.top - Math.max(inset, editor.clientHeight / 2));
        this.syncMirrorScroll();
      }
    } else if (CSS.highlights && typeof Highlight !== 'undefined') {
      const all = new Highlight();
      this.matches.forEach(match => all.add(match.range!));
      const active = new Highlight(...(current?.range ? [current.range] : []));
      all.priority = 0;
      active.priority = 1;
      CSS.highlights.set('moread-search', all);
      CSS.highlights.set('moread-search-current', active);
    } else {
      // Older WebKit: draw outside the editable article instead of inserting marks.
      this.fallback?.remove();
      const layer = document.createElement('div');
      layer.className = 'search-render-overlay';
      layer.setAttribute('aria-hidden', 'true');
      const parent = this.searchBar.parentElement!, origin = parent.getBoundingClientRect();
      const viewport = this.contentContainer.closest('#markdown-scroll-wrapper')!.getBoundingClientRect();
      for (const [index, match] of this.matches.entries()) {
        for (const rect of match.range?.getClientRects() || []) {
          const left = Math.max(rect.left, viewport.left), top = Math.max(rect.top, viewport.top);
          const right = Math.min(rect.right, viewport.right), bottom = Math.min(rect.bottom, viewport.bottom);
          if (right <= left || bottom <= top) continue;
          const mark = document.createElement('span');
          mark.className = index === this.currentIndex ? 'current' : '';
          Object.assign(mark.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
          layer.append(mark);
        }
      }
      parent.append(layer);
      this.fallback = layer;
    }
  }

  private navigate(delta: number): void {
    if (!this.matches.length) return;
    this.currentIndex = (this.currentIndex + delta + this.matches.length) % this.matches.length;
    this.paintHighlights(true);
    this.updateCount();
  }

  private replace(all: boolean): void {
    if (!this.context?.canReplace() || this.context.isComposing() || !this.matches.length) return;
    const index = this.currentIndex;
    // Re-read live DOM before replacing: no cached offsets across edits or tabs.
    this.performSearch(false);
    if (!this.matches.length) return;
    this.currentIndex = Math.min(Math.max(0, index), this.matches.length - 1);
    const value = this.replaceInput.value;
    let targets = (all ? [...this.matches].reverse() : [this.matches[this.currentIndex]])
      .map(match => ({ ...match, replacement: value, count: 1 }));
    if (all && this.context.isSource()) {
      // One native textarea operation makes Replace All a single undo step.
      const first = this.matches[0], last = this.matches[this.matches.length - 1];
      const original = this.context.source.value.slice(first.start, last.end);
      let replacement = original;
      for (const match of [...this.matches].reverse()) {
        replacement = replacement.slice(0, match.start - first.start) + value + replacement.slice(match.end - first.start);
      }
      targets = [{ ...first, end: last.end, text: original, replacement, count: this.matches.filter(match => match.text !== value).length }];
    }
    let changed = 0;
    this.replacing = true;
    this.clearHighlights();
    try {
      for (const match of targets) {
        if (!this.context.canReplace() || this.context.isComposing()) break;
        if (match.text === match.replacement) continue;
        if (match.editor) {
          if (!match.editor.isConnected || match.editor.value.slice(match.start, match.end) !== match.text) break;
          match.editor.focus();
          match.editor.setSelectionRange(match.start, match.end);
        } else if (match.range) {
          if (!match.range.startContainer.isConnected || match.range.toString() !== match.text) break;
          this.contentContainer.focus();
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(match.range);
        }
        if (!document.execCommand('insertText', false, match.replacement)) break;
        changed += match.count;
      }
    } finally {
      this.replacing = false;
      this.performSearch(false);
      this.messageEl.textContent = changed ? `已替换 ${changed} 处` : '内容未改变';
      this.replaceInput.focus();
      this.paintHighlights(true);
    }
  }

  private updateCount(): void {
    const hasQuery = !!this.inputEl.value;
    this.countEl.textContent = this.matches.length ? `${this.currentIndex + 1}/${this.matches.length}` : hasQuery ? '无匹配' : '0/0';
    this.prevBtn.disabled = this.nextBtn.disabled = !this.matches.length;
    const editable = !!this.context?.canReplace();
    const composing = !!this.context?.isComposing();
    this.replaceBtn.disabled = this.replaceAllBtn.disabled = !editable || composing || !this.matches.length;
    this.replaceInput.disabled = !editable;
    const hint = this.searchBar.querySelector<HTMLElement>('#search-scope')!;
    hint.textContent = this.context?.isSource() ? '查找源码（含公式）' : '查找显示文字 · 公式请切换源码';
    if (!editable) hint.textContent += ' · 编辑后可替换';
  }
}
