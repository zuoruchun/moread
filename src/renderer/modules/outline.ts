import { HeadingItem } from './parser.ts';

export class OutlineController {
  private container: HTMLElement;
  private contentContainer: HTMLElement;
  private headings: HeadingItem[] = [];
  private observer: IntersectionObserver | null = null;
  private activeId: string | null = null;

  constructor(container: HTMLElement, contentContainer: HTMLElement) {
    this.container = container;
    this.contentContainer = contentContainer;
  }

  public update(headings: HeadingItem[]): void {
    this.headings = headings;
    this.render();
    this.setupIntersectionObserver();
  }

  private render(): void {
    this.container.innerHTML = '';
    if (this.headings.length === 0) {
      this.container.innerHTML = '<div class="outline-empty">当前文档无标题</div>';
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'outline-list';

    for (const h of this.headings) {
      const li = document.createElement('li');
      li.className = `outline-item outline-level-${h.level}`;
      li.dataset.headingId = h.id;

      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.text;
      a.className = 'outline-link';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.scrollToHeading(h.id);
      });

      li.appendChild(a);
      ul.appendChild(li);
    }

    this.container.appendChild(ul);
  }

  public scrollToHeading(id: string): void {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.setActive(id);
    }
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;

    const items = this.container.querySelectorAll('.outline-item');
    items.forEach((item) => {
      const el = item as HTMLElement;
      if (el.dataset.headingId === id) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        el.classList.remove('active');
      }
    });
  }

  private setupIntersectionObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
    }

    const headingEls = this.contentContainer.querySelectorAll('.heading-anchor');
    if (headingEls.length === 0) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.setActive(entry.target.id);
            break;
          }
        }
      },
      {
        root: this.contentContainer,
        rootMargin: '0px 0px -70% 0px',
        threshold: 0.1
      }
    );

    headingEls.forEach((el) => this.observer?.observe(el));
  }
}
