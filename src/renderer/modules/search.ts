export class SearchController {
  private contentContainer: HTMLElement;
  private searchBar: HTMLElement;
  private inputEl: HTMLInputElement;
  private countEl: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;

  private matches: HTMLElement[] = [];
  private currentIndex: number = -1;
  private originalHtml: string = '';
  private isSearching: boolean = false;

  constructor(
    contentContainer: HTMLElement,
    searchBar: HTMLElement,
    inputEl: HTMLInputElement,
    countEl: HTMLElement,
    prevBtn: HTMLButtonElement,
    nextBtn: HTMLButtonElement,
    closeBtn: HTMLButtonElement
  ) {
    this.contentContainer = contentContainer;
    this.searchBar = searchBar;
    this.inputEl = inputEl;
    this.countEl = countEl;
    this.prevBtn = prevBtn;
    this.nextBtn = nextBtn;
    this.closeBtn = closeBtn;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.inputEl.addEventListener('input', () => this.performSearch());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.gotoPrev();
        } else {
          this.gotoNext();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    this.prevBtn.addEventListener('click', () => this.gotoPrev());
    this.nextBtn.addEventListener('click', () => this.gotoNext());
    this.closeBtn.addEventListener('click', () => this.close());
  }

  public open(): void {
    this.searchBar.classList.remove('hidden');
    this.inputEl.focus();
    this.inputEl.select();
    if (this.inputEl.value.trim()) {
      this.performSearch();
    }
  }

  public close(): void {
    this.searchBar.classList.add('hidden');
    this.clearHighlights();
    this.matches = [];
    this.currentIndex = -1;
    this.updateCount();
    this.contentContainer.focus();
  }

  public setContentBase(html: string): void {
    this.originalHtml = html;
    if (!this.searchBar.classList.contains('hidden') && this.inputEl.value.trim()) {
      this.performSearch();
    }
  }

  public clearHighlights(): void {
    const marks = this.contentContainer.querySelectorAll('mark.mored-search-match');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      }
    });
  }

  public performSearch(): void {
    this.clearHighlights();
    this.matches = [];
    this.currentIndex = -1;

    const query = this.inputEl.value.trim();
    if (!query) {
      this.updateCount();
      return;
    }

    const walker = document.createTreeWalker(
      this.contentContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tagName = parent.tagName.toLowerCase();
          if (tagName === 'script' || tagName === 'style' || tagName === 'button') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes: Text[] = [];
    let currentNode: Node | null = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    const queryLower = query.toLowerCase();

    for (const node of textNodes) {
      const val = node.nodeValue || '';
      const valLower = val.toLowerCase();
      let index = valLower.indexOf(queryLower);
      if (index === -1) continue;

      const fragment = document.createDocumentFragment();
      let lastIdx = 0;

      while (index !== -1) {
        if (index > lastIdx) {
          fragment.appendChild(document.createTextNode(val.substring(lastIdx, index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'mored-search-match';
        mark.textContent = val.substring(index, index + query.length);
        fragment.appendChild(mark);
        this.matches.push(mark);

        lastIdx = index + query.length;
        index = valLower.indexOf(queryLower, lastIdx);
      }

      if (lastIdx < val.length) {
        fragment.appendChild(document.createTextNode(val.substring(lastIdx)));
      }

      const parent = node.parentNode;
      if (parent) {
        parent.replaceChild(fragment, node);
      }
    }

    if (this.matches.length > 0) {
      this.currentIndex = 0;
      this.highlightCurrent();
    }
    this.updateCount();
  }

  private gotoNext(): void {
    if (this.matches.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.matches.length;
    this.highlightCurrent();
    this.updateCount();
  }

  private gotoPrev(): void {
    if (this.matches.length === 0) return;
    this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length;
    this.highlightCurrent();
    this.updateCount();
  }

  private highlightCurrent(): void {
    this.matches.forEach((m, idx) => {
      if (idx === this.currentIndex) {
        m.classList.add('current');
        m.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        m.classList.remove('current');
      }
    });
  }

  private updateCount(): void {
    if (this.matches.length === 0) {
      this.countEl.textContent = this.inputEl.value.trim() ? '无匹配' : '0/0';
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
    } else {
      this.countEl.textContent = `${this.currentIndex + 1}/${this.matches.length}`;
      this.prevBtn.disabled = false;
      this.nextBtn.disabled = false;
    }
  }
}
