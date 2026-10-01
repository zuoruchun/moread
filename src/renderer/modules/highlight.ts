import hljs from 'highlight.js';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightCode(code: string, lang: string): string {
  let highlighted = '';
  const cleanLang = (lang || '').trim().toLowerCase();
  
  if (cleanLang && hljs.getLanguage(cleanLang)) {
    try {
      highlighted = hljs.highlight(code, { language: cleanLang, ignoreIllegals: true }).value;
    } catch {
      highlighted = escapeHtml(code);
    }
  } else {
    highlighted = escapeHtml(code);
  }

  // Preserve raw code in data-code attribute for exact copy (newlines, indentation, spaces)
  const encodedRawCode = encodeURIComponent(code);
  const displayLang = cleanLang || 'text';

  return `
<div class="code-block-container">
  <div class="code-block-header" contenteditable="false">
    <span class="code-lang">${escapeHtml(displayLang)}</span>
    <button class="code-copy-btn" data-code="${encodedRawCode}" title="复制全部代码" aria-label="复制代码">复制</button>
  </div>
  <pre><code class="hljs language-${escapeHtml(displayLang)}">${highlighted}</code></pre>
</div>`.trim();
}
