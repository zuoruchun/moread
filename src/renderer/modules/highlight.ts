import hljs from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';

// Keep Bash strings/comments intact while coloring CLI arguments and custom commands.
hljs.registerLanguage('moread-bash', (api) => {
  const language = bash(api);
  const keywords = language.keywords as Record<string, string[] | string>;
  const reserved = new Set(Object.values(keywords).flatMap(value => typeof value === 'string' ? value.split(/\s+/) : Array.isArray(value) ? value : []));
  language.aliases = [];
  language.contains = [
    ...(language.contains || []),
    { scope: 'attr', match: /(?<![\w-])--?[a-zA-Z][\w-]*/, relevance: 0 },
    { scope: 'number', match: /(?<![\w./-])-?\d+(?:\.\d+)?\b(?![\w./-])/, relevance: 0 },
    {
      match: [/(?:^|[;|&])\s*/, /[a-zA-Z_][\w.-]*/],
      scope: { 2: 'title' },
      relevance: 0,
      'on:begin': (match, response) => {
        if (reserved.has(match[2]) || (match.input || '')[(match.index || 0) + match[0].length] === '=') response.ignoreMatch();
      }
    }
  ];
  return language;
});

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeCodeLanguage(lang: string): string {
  return (lang || '').replace(/[\r\n`]/g, '').trim();
}

export function highlightCodeContent(code: string, lang: string): string {
  const cleanLang = normalizeCodeLanguage(lang).split(/\s+/)[0].toLowerCase();
  const grammar = ['bash', 'sh', 'zsh', 'shell'].includes(cleanLang) ? 'moread-bash' : cleanLang;
  
  if (grammar && hljs.getLanguage(grammar)) {
    try {
      return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(code);
    }
  }
  return escapeHtml(code);
}

export function highlightCode(code: string, lang: string, readonly = true): string {
  const cleanLang = normalizeCodeLanguage(lang);
  const highlighted = highlightCodeContent(code, cleanLang);

  // Preserve raw code in data-code attribute for exact copy (newlines, indentation, spaces)
  const encodedRawCode = encodeURIComponent(code);
  const displayLang = cleanLang || 'text';
  const languageControl = readonly
    ? `<span class="code-lang">${escapeHtml(displayLang)}</span>`
    : `<input class="code-lang" type="text" value="${escapeHtml(cleanLang)}" placeholder="text" aria-label="代码语言" title="修改代码语言，如 bash、python、javascript；留空为纯文本" spellcheck="false" autocomplete="off">`;
  const codeMarkup = `<code class="hljs language-${escapeHtml(displayLang.split(/\s+/)[0])}">${highlighted}${!readonly && (!code || code.endsWith('\n')) ? ' ' : ''}</code>`;
  // Keep the input inside PRE so Markdown serialization does not collapse its whitespace.
  const codeEditor = readonly ? `<pre>${codeMarkup}</pre>` : `<div class="code-editor-wrapper"><pre>${codeMarkup}<textarea class="code-editor" aria-label="代码内容" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off">${escapeHtml(code)}</textarea></pre></div>`;

  return `
<div class="code-block-container" contenteditable="false" data-language="${escapeHtml(cleanLang)}">
  <div class="code-block-header" contenteditable="false">
    ${languageControl}
    <button class="code-copy-btn" data-code="${encodedRawCode}" title="复制全部代码" aria-label="复制代码">复制</button>
  </div>
  ${codeEditor}
</div>`.trim();
}
