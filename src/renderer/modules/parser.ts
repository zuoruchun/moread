import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { renderMath } from './math.ts';
import { highlightCode, escapeHtml } from './highlight.ts';

export interface ParseOptions {
  currentFilePath?: string;
  allowRemoteImages?: boolean;
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
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim();
  return highlightCode(token.content, lang);
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
    .replace(/\s*on\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s*on\w+\s*=\s*[^>\s]+/gi, '')
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
        'disabled',
        'checked',
        'target',
        'title'
      ]
    });
  }
  return fallbackSanitize(rawHtml);
}

export function parseMarkdown(content: string, options: ParseOptions = {}): string {
  const headingsCount = new Map<string, number>();

  // 1. Temporarily protect code blocks and inline code from math delimiter matching
  const codeBlocks: string[] = [];
  let protectedContent = content.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `@@@CODE_BLOCK_${idx}@@@`;
  });

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
    const nextToken = tokens[idx + 1];
    const text = nextToken && nextToken.children ? nextToken.children.map(c => c.content).join('') : nextToken?.content || '';
    const slug = generateSlug(text, headingsCount);
    tokens[idx].attrSet('id', slug);
    tokens[idx].attrSet('class', 'heading-anchor');
    return self.renderToken(tokens, idx, renderOpts);
  };

  // 6. Support read-only task list rendering
  protectedContent = protectedContent.replace(/^(\s*[-*+]\s+)\[ \]\s+/gm, '$1<input type="checkbox" disabled class="task-list-item-checkbox"> ');
  protectedContent = protectedContent.replace(/^(\s*[-*+]\s+)\[[xX]\]\s+/gm, '$1<input type="checkbox" disabled checked class="task-list-item-checkbox"> ');

  // 7. Parse with Markdown-it
  let renderedHtml = md.render(protectedContent);

  const MAX_MATH_COUNT = 500;

  // 8. Replace Display Math placeholders with MathJax SVG (with quota protection)
  renderedHtml = renderedHtml.replace(/@@@MATH_DISPLAY_(\d+)@@@/g, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const formula = displayMathList[idx];
    if (idx >= MAX_MATH_COUNT) {
      return `<div class="math-block-wrapper math-quota-exceeded" title="为保证界面响应速度，超出${MAX_MATH_COUNT}个公式的部分安全降级为源码"><code class="hljs language-latex">$$\n${escapeHtml(formula)}\n$$</code></div>`;
    }
    return `<div class="math-block-wrapper">${renderMath(formula, true)}</div>`;
  });

  // 9. Replace Inline Math placeholders with MathJax SVG (with quota protection)
  renderedHtml = renderedHtml.replace(/@@@MATH_INLINE_(\d+)@@@/g, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const formula = inlineMathList[idx];
    if (idx >= MAX_MATH_COUNT) {
      return `<code class="math-inline-fallback" title="超出公式渲染上限，安全降级">$${escapeHtml(formula)}$</code>`;
    }
    return renderMath(formula, false);
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
  const lines = markdown.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawText = headingMatch[2].trim().replace(/\s*#*$/, '');
      const id = generateSlug(rawText, headingsCount);
      headings.push({ id, level, text: rawText });
    }
  }

  return headings;
}
