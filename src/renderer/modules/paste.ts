import { htmlToMarkdown } from './editor.ts';
import { parseMarkdown, sanitizeHtml, type ParseOptions } from './parser.ts';

interface PasteOptions {
  canEdit: () => boolean;
  parseOptions: () => ParseOptions;
  onInserted: (inputDispatched: boolean) => void;
  onError: (error: unknown) => void;
}

function elementAt(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

export function bindMarkdownPaste(root: HTMLElement, options: PasteOptions): void {
  const protectedSelector = '[data-paste-protected="true"]';
  const restoreProtection = () => root.querySelectorAll<HTMLElement>(protectedSelector).forEach(node => node.setAttribute('contenteditable', 'false'));
  root.addEventListener('beforeinput', event => {
    if (event.target !== root || !options.canEdit() || !['historyUndo', 'historyRedo'].includes(event.inputType)) return;
    // WebKit otherwise leaves non-editable formula/code nodes behind when undoing their paste.
    root.querySelectorAll<HTMLElement>(protectedSelector).forEach(node => node.removeAttribute('contenteditable'));
    queueMicrotask(restoreProtection);
  });
  root.addEventListener('paste', event => {
    if (event.defaultPrevented || !options.canEdit() || !event.clipboardData) return;
    const target = event.target;
    // Embedded code/formula editors and form controls own their native plaintext paste.
    if (target instanceof Element && target.closest('textarea, input, select, button')) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    const data = event.clipboardData;
    let text = data.getData('text/plain');
    if (!text && data.getData('text/html')) {
      event.preventDefault();
      try { text = htmlToMarkdown(sanitizeHtml(data.getData('text/html'))); }
      catch (error) { options.onError(error); return; }
    }
    if (!text) return;
    text = text.replace(/\r\n?/g, '\n');
    event.preventDefault();

    let inputDispatched = false;
    const recordInput = () => { inputDispatched = true; };
    root.addEventListener('input', recordInput);
    try {
      const literal = elementAt(range.startContainer)?.closest('pre, code');
      const endLiteral = elementAt(range.endContainer)?.closest('pre, code');
      let command: 'insertText' | 'insertHTML' = 'insertText';
      let value = text;
      if (!literal || literal !== endLiteral) {
        const template = root.ownerDocument.createElement('template');
        template.innerHTML = parseMarkdown(text, options.parseOptions());
        template.content.querySelectorAll<HTMLElement>('[contenteditable="false"]').forEach(node => {
          node.setAttribute('data-paste-protected', 'true');
          node.removeAttribute('contenteditable');
        });
        const usedIds = new Set(Array.from(root.querySelectorAll('[id]'), node => node.id));
        template.content.querySelectorAll<HTMLElement>('.heading-anchor').forEach(heading => {
          const base = heading.id || 'heading';
          let id = base;
          for (let suffix = 1; usedIds.has(id); suffix++) id = `${base}-${suffix}`;
          heading.id = id;
          usedIds.add(id);
        });
        // A paragraph fragment should stay inline at the caret, preserving its neighbors.
        // Block boundaries prevent WebKit from merging a leading quote into the current paragraph.
        const nodes = Array.from(template.content.childNodes).filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim());
        value = nodes.length === 1 && nodes[0] instanceof HTMLParagraphElement
          ? nodes[0].innerHTML : `<p><br></p>${template.innerHTML}<p><br></p>`;
        command = 'insertHTML';
      }
      // WebKit's editing command keeps paste, selection replacement and Cmd+Z in one undo step.
      if (root.ownerDocument.execCommand(command, false, value)) options.onInserted(inputDispatched);
      else options.onError(new Error('编辑器未能插入粘贴内容，请重试'));
    } catch (error) {
      options.onError(error);
    } finally {
      root.removeEventListener('input', recordInput);
      restoreProtection();
    }
  });
}
