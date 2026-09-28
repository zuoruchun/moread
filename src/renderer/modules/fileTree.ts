export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export class FileTreeController {
  private container: HTMLElement;
  private onSelectFile: (filePath: string) => void;
  private currentFilePath: string | null = null;

  constructor(container: HTMLElement, onSelectFile: (filePath: string) => void) {
    this.container = container;
    this.onSelectFile = onSelectFile;
  }

  public update(nodes: FileNode[], currentPath: string | null = null): void {
    this.currentFilePath = currentPath;
    this.container.innerHTML = '';

    if (!nodes || nodes.length === 0) {
      this.container.innerHTML = '<div class="file-tree-empty">目录下无 Markdown 文件</div>';
      return;
    }

    const rootList = this.renderNodes(nodes);
    this.container.appendChild(rootList);
  }

  public setCurrentFile(filePath: string): void {
    this.currentFilePath = filePath;
    const items = this.container.querySelectorAll('.file-item');
    items.forEach((item) => {
      const el = item as HTMLElement;
      if (el.dataset.filePath === filePath) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  private renderNodes(nodes: FileNode[]): HTMLElement {
    const ul = document.createElement('ul');
    ul.className = 'file-tree-list';

    for (const node of nodes) {
      const li = document.createElement('li');
      li.className = node.isDirectory ? 'dir-item' : 'file-item';
      li.dataset.filePath = node.path;

      if (!node.isDirectory && node.path === this.currentFilePath) {
        li.classList.add('active');
      }

      const row = document.createElement('div');
      row.className = 'tree-row';

      const icon = document.createElement('span');
      icon.className = `tree-icon ${node.isDirectory ? 'icon-dir' : 'icon-file'}`;
      icon.textContent = node.isDirectory ? '📁 ' : '📄 ';

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      label.title = node.path;

      row.appendChild(icon);
      row.appendChild(label);
      li.appendChild(row);

      if (node.isDirectory) {
        let isExpanded = false;
        let subUl: HTMLElement | null = null;

        row.addEventListener('click', () => {
          isExpanded = !isExpanded;
          icon.textContent = isExpanded ? '📂 ' : '📁 ';
          if (isExpanded) {
            if (!subUl && node.children) {
              subUl = this.renderNodes(node.children);
              li.appendChild(subUl);
            } else if (subUl) {
              subUl.style.display = 'block';
            }
          } else if (subUl) {
            subUl.style.display = 'none';
          }
        });
      } else {
        row.addEventListener('click', () => {
          this.onSelectFile(node.path);
          this.setCurrentFile(node.path);
        });
      }

      ul.appendChild(li);
    }

    return ul;
  }
}
