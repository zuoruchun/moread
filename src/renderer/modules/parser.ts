import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { renderMath } from './math.ts';
import { highlightCode, escapeHtml } from './highlight.ts';

export interface ParseOptions {
  currentFilePath?: string;
  allowRemoteImages?: boolean;
  readonly?: boolean;
}

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
}

// Markdown-it instance
const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
  typographer: false
});

// Custom fence rule for code blocks (highlight + copy button)
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim();
  return highlightCode(token.content, lang, env.readonly ?? true);
};

// Custom link rule to block dangerous protocols like javascript:
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const hrefIndex = tokens[idx].attrIndex('href');
  if (hrefIndex >= 0 && tokens[idx].attrs) {
    const href = tokens[idx].attrs[hrefIndex][1].trim();
    if (/^(javascript|vbscript|data):/i.test(href)) {
      tokens[idx].attrs[hrefIndex][1] = '#';
    }
  }
  return self.renderToken(tokens, idx, options);
};

// Custom table wrapper to prevent wide tables from breaking layout
md.renderer.rules.table_open = () => '<div class="table-container"><table>';
md.renderer.rules.table_close = () => '</table></div>';

// Heading anchor slug generator with Chinese support and deduplication
function generateSlug(text: string, countMap: Map<string, number>): string {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-');
  
  if (!slug) slug = 'heading';

  const count = countMap.get(slug) || 0;
  countMap.set(slug, count + 1);

  return count === 0 ? slug : `${slug}-${count}`;
}

// Custom sanitizer fallback for Node test environments where browser DOM is absent
function fallbackSanitize(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/\s+on\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s+on\w+\s*=\s*[^>\s]+/gi, '')
    .replace(/href\s*=\s*(['"])(javascript|data|vbscript):.*?\1/gi, 'href="#"')
    .replace(/src\s*=\s*(['"])(javascript|data|vbscript):.*?\1/gi, 'src=""')
    .replace(/\[([^\]]*)\]\((?:javascript|data|vbscript):[^)]*\)/gi, '$1');
}

export function sanitizeHtml(rawHtml: string): string {
  if (typeof window !== 'undefined' && (DOMPurify as any).sanitize) {
    return DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: [
        'mjx-container',
        'mjx-merr',
        'mjx-assistive-mml',
        'svg',
        'path',
        'g',
        'defs',
        'use',
        'line',
        'rect',
        'circle',
        'text',
        'mark'
      ],
      ADD_ATTR: [
        'aria-hidden',
        'aria-label',
        'role',
        'focusable',
        'viewBox',
        'xmlns:xlink',
        'xlink:href',
        'jax',
        'display',
        'data-c',
        'transform',
        'stroke-width',
        'data-mml-node',
        'data-mjx-texclass',
        'data-code',
        'data-raw-formula',
        'contenteditable',
        'style',
        'disabled',
        'checked',
        'target',
        'title'
      ],
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|mored):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    });
  }
  return fallbackSanitize(rawHtml);
}

export function parseMarkdown(content: string, options: ParseOptions = {}): string {
  const headings = extractHeadings(content);
  let headingIndex = 0;

  // 1. Temporarily protect code blocks and inline code from math delimiter matching
  const codeBlocks: string[] = [];
  const protectCode = (match: string): string => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `@@@CODE_BLOCK_${idx}@@@`;
  };
  const lines = content.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  let protectedContent = content;
  // Token ranges also cover nested/list, tilde, long and unterminated fences.
  const codeTokens = md.parse(content, {}).filter(token => token.map && (token.type === 'fence' || token.type === 'code_block'));
  for (const token of codeTokens.reverse()) {
    const [start, end] = token.map!;
    const markerOffset = token.type === 'fence' ? Math.max(0, lines[start].indexOf(token.markup)) : 0;
    const from = offsets[start] + markerOffset;
    const to = Math.min(content.length, offsets[end]);
    protectedContent = protectedContent.slice(0, from) + protectCode(content.slice(from, to)) + protectedContent.slice(to);
  }
  protectedContent = protectedContent.replace(/(`+)[^\n]*?\1(?!`)/g, protectCode);

  // 2. Extract and protect Display Math: $$ ... $$ and \[ ... \]
  const displayMathList: string[] = [];
  protectedContent = protectedContent.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = displayMathList.length;
    displayMathList.push(math.trim());
    return `@@@MATH_DISPLAY_${idx}@@@`;
  });

  protectedContent = protectedContent.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    const idx = displayMathList.length;
    displayMathList.push(math.trim());
    return `@@@MATH_DISPLAY_${idx}@@@`;
  });

  // 3. Extract and protect Inline Math: $ ... $ and \( ... \)
  const inlineMathList: string[] = [];
  protectedContent = protectedContent.replace(/(?<!\\)\$(?!\d|\s)([^\s$]|(?:[^\s$].*?[^\s$]))\$(?!\d)/g, (_, math) => {
    const idx = inlineMathList.length;
    inlineMathList.push(math.trim());
    return `@@@MATH_INLINE_${idx}@@@`;
  });

  protectedContent = protectedContent.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    const idx = inlineMathList.length;
    inlineMathList.push(math.trim());
    return `@@@MATH_INLINE_${idx}@@@`;
  });

  // 4. Restore code blocks before Markdown-it parsing so syntax highlighting works
  protectedContent = protectedContent.replace(/@@@CODE_BLOCK_(\d+)@@@/g, (_, idx) => {
    return codeBlocks[parseInt(idx, 10)];
  });

  // 5. Override heading rendering to assign IDs for anchors
  md.renderer.rules.heading_open = (tokens, idx, renderOpts, _env, self) => {
    const slug = headings[headingIndex++]?.id || 'heading';
    tokens[idx].attrSet('id', slug);
    tokens[idx].attrSet('class', 'heading-anchor');
    return self.renderToken(tokens, idx, renderOpts);
  };

  // 6. Support task list rendering (readonly by default, interactive when readonly: false)
  const isReadonly = options.readonly ?? true;
  const disabledAttr = isReadonly ? 'disabled ' : '';
  protectedContent = protectedContent.replace(/^(\s*[-*+]\s+)\[ \]\s+/gm, `$1<input type="checkbox" ${disabledAttr}class="task-list-item-checkbox"> `);
  protectedContent = protectedContent.replace(/^(\s*[-*+]\s+)\[[xX]\]\s+/gm, `$1<input type="checkbox" ${disabledAttr}checked class="task-list-item-checkbox"> `);

  // 7. Parse with Markdown-it
  let renderedHtml = md.render(protectedContent, { readonly: isReadonly });

  const MAX_MATH_COUNT = 500;

  // 8. Replace Display Math placeholders with MathJax SVG (with quota protection)
  renderedHtml = renderedHtml.replace(/@@@MATH_DISPLAY_(\d+)@@@/g, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const formula = displayMathList[idx];
    if (idx >= MAX_MATH_COUNT) {
      return `<div class="math-block-wrapper math-quota-exceeded" data-raw-formula="${escapeHtml(formula)}" contenteditable="false" title="超出公式上限"><code class="hljs language-latex">$$\n${escapeHtml(formula)}\n$$</code></div>`;
    }
    return `<div class="math-block-wrapper" data-raw-formula="${escapeHtml(formula)}" contenteditable="false"><span class="raw-math-marker" style="display:none;">${escapeHtml(formula)}</span>${renderMath(formula, true)}</div>`;
  });

  // 9. Replace Inline Math placeholders with MathJax SVG (with quota protection)
  renderedHtml = renderedHtml.replace(/@@@MATH_INLINE_(\d+)@@@/g, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const formula = inlineMathList[idx];
    if (idx >= MAX_MATH_COUNT) {
      return `<code class="math-inline-fallback" data-raw-formula="${escapeHtml(formula)}" contenteditable="false" title="超出公式渲染上限">$${escapeHtml(formula)}$</code>`;
    }
    return `<span class="math-inline-wrapper" data-raw-formula="${escapeHtml(formula)}" contenteditable="false"><span class="raw-math-marker" style="display:none;">${escapeHtml(formula)}</span>${renderMath(formula, false)}</span>`;
  });

  // 10. Handle Relative Images and URL Safety
  if (options.currentFilePath) {
    const currentDir = options.currentFilePath.substring(0, options.currentFilePath.lastIndexOf('/'));
    renderedHtml = renderedHtml.replace(/<img\s+([^>]*?)src=(["'])(.*?)\2([^>]*?)>/gi, (fullImg, before, quote, src, after) => {
      let resolvedSrc = src;
      if (!src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('mored://')) {
        let fullPath = src;
        if (!src.startsWith('/')) {
          fullPath = `${currentDir}/${src}`;
        }
        resolvedSrc = `mored://local?path=${encodeURIComponent(fullPath)}`;
      } else if (src.startsWith('http://') || src.startsWith('https://')) {
        if (!options.allowRemoteImages) {
          return `<div class="remote-image-blocked" title="远程图片已默认拦截以保护隐私 (可在设置中启用)">[远程图片已拦截: ${escapeHtml(src)}]</div>`;
        }
      }
      return `<img ${before}src=${quote}${resolvedSrc}${quote}${after} loading="lazy" class="mored-image">`;
    });
  }

  // 11. Final strict sanitization to remove any malicious injected scripts or handlers
  return sanitizeHtml(renderedHtml);
}

export function extractHeadings(markdown: string): HeadingItem[] {
  const headingsCount = new Map<string, number>();
  const headings: HeadingItem[] = [];
  const tokens = md.parse(markdown, {});
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    // Parsed inline text matches visible escapes, emphasis, links and entities.
    // Genuine backslashes inside code are preserved.
    const text = (inline.children || []).map(child => {
      if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
      if (child.type === 'html_inline') return '';
      return child.content;
    }).join('').trim();
    const id = generateSlug(text, headingsCount);
    headings.push({ id, level: Number(token.tag.slice(1)), text });
  }

  return headings;
}
