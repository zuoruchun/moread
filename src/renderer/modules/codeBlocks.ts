import { highlightCodeContent, normalizeCodeLanguage } from './highlight.ts';

// Read live DOM, never the copy-button cache: editing hosts can report input on the article.
export function readCodeBlock(container: Element): string {
  const editor = container.querySelector('textarea.code-editor') as HTMLTextAreaElement | null;
  if (editor) return editor.value ?? editor.textContent ?? '';
  const code = container.querySelector('pre code');
  if (!code) return '';
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeName === 'BR') return '\n';
    let text = '';
    for (const child of Array.from(node.childNodes)) {
      const block = child.nodeName === 'DIV' || child.nodeName === 'P';
      const previousBlock = child.previousSibling?.nodeName === 'DIV' || child.previousSibling?.nodeName === 'P';
      if (child.previousSibling && (block || previousBlock)) text += '\n';
      // WebKit uses a final BR as the caret placeholder of an empty paragraph.
      if ((node.nodeName === 'DIV' || node.nodeName === 'P') && child.nodeName === 'BR' && !child.nextSibling) continue;
      text += read(child);
    }
    return text;
  };
  return read(code);
}

export function getCodeLanguage(container: Element): string {
  const input = container.querySelector('input.code-lang') as HTMLInputElement | null;
  return normalizeCodeLanguage(input?.value ?? container.getAttribute('data-language') ?? container.querySelector('.code-lang')?.textContent ?? '');
}

function refreshCodeBlock(container: Element): void {
  const code = container.querySelector('pre code') as HTMLElement | null;
  if (!code) return;
  const raw = readCodeBlock(container);
  const language = getCodeLanguage(container);
  container.setAttribute('data-language', language);
  container.querySelector('input.code-lang')?.setAttribute('value', language);
  container.querySelector('.code-copy-btn')?.setAttribute('data-code', encodeURIComponent(raw));
  code.className = `hljs language-${language.split(/\s+/)[0] || 'text'}`;
  const editor = container.querySelector('textarea.code-editor') as HTMLTextAreaElement | null;
  code.innerHTML = highlightCodeContent(raw, language) + (editor && (!raw || raw.endsWith('\n')) ? ' ' : '');
  if (editor) {
    // Preserve the live value when Turndown clones the DOM; do not assign .value or selection.
    editor.defaultValue = raw;
    const pre = code.parentElement!;
    pre.scrollLeft = editor.scrollLeft;
    pre.scrollTop = editor.scrollTop;
  }
}

export function bindCodeBlockEditing(root: HTMLElement): void {
  root.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    const container = target.closest('.code-block-container');
    if (!container) {
      if (target === root) {
        root.querySelectorAll('.code-block-container').forEach(block => {
          block.querySelector('.code-copy-btn')?.setAttribute('data-code', encodeURIComponent(readCodeBlock(block)));
        });
      }
      return;
    }
    if (target.matches('input.code-lang, textarea.code-editor')) {
      // Keep the live input value on clones used by Markdown serialization.
      refreshCodeBlock(container);
    } else {
      container.querySelector('.code-copy-btn')?.setAttribute('data-code', encodeURIComponent(readCodeBlock(container)));
    }
  });

  // Only the display layer is recolored; the textarea owns caret, IME and native undo.
  root.addEventListener('focusout', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('textarea.code-editor, input.code-lang')) {
      const container = target.closest('.code-block-container');
      if (container) refreshCodeBlock(container);
    }
  });

  root.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('input.code-lang') && event.key === 'Enter') {
      event.preventDefault();
      target.blur();
      return;
    }
    if (!target.matches('textarea.code-editor') || event.isComposing || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });

  root.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement;
    if (!target.matches('textarea.code-editor') || !event.clipboardData) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });

  root.addEventListener('scroll', (event) => {
    const editor = event.target as HTMLTextAreaElement;
    if (!editor.matches('textarea.code-editor')) return;
    const pre = editor.closest('.code-block-container')?.querySelector('pre');
    if (pre) { pre.scrollLeft = editor.scrollLeft; pre.scrollTop = editor.scrollTop; }
  }, true);
}
