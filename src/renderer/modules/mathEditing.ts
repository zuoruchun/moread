import { renderMath } from './math.ts';
import { sanitizeHtml } from './parser.ts';

const selector = '.math-block-wrapper, .math-inline-wrapper, .math-inline-fallback';
const previewTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function updatePreview(wrapper: HTMLElement, preview: HTMLElement): void {
  const formula = wrapper.getAttribute('data-raw-formula') || '';
  preview.innerHTML = sanitizeHtml(renderMath(formula, wrapper.classList.contains('math-block-wrapper')));
  const marker = document.createElement('span');
  marker.className = 'raw-math-marker';
  marker.style.display = 'none';
  marker.textContent = formula;
  preview.prepend(marker);
}

function finish(wrapper: HTMLElement): void {
  const timer = previewTimers.get(wrapper);
  if (timer) clearTimeout(timer);
  previewTimers.delete(wrapper);
  const preview = wrapper.querySelector<HTMLElement>('.math-preview');
  if (!preview) return;
  updatePreview(wrapper, preview);
  wrapper.replaceChildren(...Array.from(preview.childNodes));
  wrapper.classList.remove('math-editing');
  if (wrapper.tabIndex >= 0) wrapper.setAttribute('role', 'button');
}

export function finishMathEditing(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.math-editing').forEach(finish);
}

export function setMathEditingEnabled(root: HTMLElement, enabled: boolean): void {
  if (!enabled) finishMathEditing(root);
  root.querySelectorAll<HTMLElement>(selector).forEach(wrapper => {
    wrapper.tabIndex = enabled ? 0 : -1;
    if (enabled) {
      wrapper.setAttribute('role', 'button');
      wrapper.setAttribute('aria-label', '编辑公式');
      wrapper.title = '点击编辑 LaTeX 公式';
    } else {
      wrapper.removeAttribute('role');
      wrapper.removeAttribute('aria-label');
      wrapper.removeAttribute('title');
    }
  });
}

export function bindMathEditing(root: HTMLElement, canEdit: () => boolean): void {
  const open = (wrapper: HTMLElement) => {
    if (!canEdit() || wrapper.querySelector('.math-editor')) return;
    finishMathEditing(root);
    const preview = document.createElement('span');
    preview.className = 'math-preview';
    preview.append(...Array.from(wrapper.childNodes));
    const panel = document.createElement('span');
    panel.className = 'math-editor-panel';
    const editor = document.createElement('textarea');
    editor.className = 'math-editor';
    editor.value = wrapper.getAttribute('data-raw-formula') || '';
    editor.rows = wrapper.classList.contains('math-block-wrapper') ? Math.min(8, Math.max(3, editor.value.split('\n').length)) : 2;
    editor.spellcheck = false;
    editor.setAttribute('aria-label', 'LaTeX 公式源码');
    const done = document.createElement('button');
    done.className = 'math-editor-done';
    done.type = 'button';
    done.textContent = '完成';
    done.title = '完成公式编辑 (Cmd+Enter)';
    let composing = false;
    let pendingFinish = false;
    const refresh = () => {
      wrapper.setAttribute('data-raw-formula', editor.value);
      const oldTimer = previewTimers.get(wrapper);
      if (oldTimer) clearTimeout(oldTimer);
      if (!composing) previewTimers.set(wrapper, setTimeout(() => {
        if (wrapper.isConnected && wrapper.contains(editor)) updatePreview(wrapper, preview);
        previewTimers.delete(wrapper);
      }, 160));
    };
    const close = () => {
      if (composing) { pendingFinish = true; return; }
      refresh();
      finish(wrapper);
    };
    editor.addEventListener('compositionstart', () => { composing = true; });
    editor.addEventListener('compositionend', () => {
      composing = false;
      refresh();
      if (pendingFinish) close();
    });
    editor.addEventListener('input', refresh);
    editor.addEventListener('keydown', event => {
      if (event.isComposing || composing) return;
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        event.stopPropagation();
        close();
        wrapper.focus();
      } else if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
    editor.addEventListener('blur', event => {
      if (event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget)) return;
      setTimeout(() => {
        if (wrapper.isConnected && wrapper.contains(editor) && !wrapper.contains(document.activeElement)) close();
      }, 0);
    });
    done.addEventListener('click', event => {
      event.stopPropagation();
      close();
      wrapper.focus();
    });
    panel.append(editor, done);
    wrapper.append(preview, panel);
    wrapper.classList.add('math-editing');
    wrapper.setAttribute('role', 'group');
    editor.focus();
    editor.setSelectionRange(0, editor.value.length);
  };
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const wrapper = target.closest<HTMLElement>(selector);
    if (!wrapper || !canEdit() || target.closest('.math-editor-panel')) return;
    event.preventDefault();
    open(wrapper);
  });
  root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.matches(selector) && (event.key === 'Enter' || event.key === ' ')) {
      if (!canEdit()) return;
      event.preventDefault();
      open(target);
    }
  });
}
