import TurndownService from 'turndown';
// @ts-ignore
import { gfm } from 'turndown-plugin-gfm';
import { getCodeLanguage, readCodeBlock } from './codeBlocks.ts';

export function createTurndownService(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  });

  turndown.use(gfm);

  // 1. Math block wrapper rule
  turndown.addRule('mathBlock', {
    filter: (node) => {
      const className = node.getAttribute('class') || '';
      return node.nodeName === 'DIV' && className.includes('math-block-wrapper');
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const formula = el.getAttribute('data-raw-formula') || '';
      return `\n\n$$\n${formula.trim()}\n$$\n\n`;
    }
  });

  // 2. Inline math wrapper rule
  turndown.addRule('mathInline', {
    filter: (node) => {
      const className = node.getAttribute('class') || '';
      return (node.nodeName === 'SPAN' && className.includes('math-inline-wrapper')) ||
             (node.nodeName === 'CODE' && className.includes('math-inline-fallback'));
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const formula = el.getAttribute('data-raw-formula') || '';
      return `$${formula.trim()}$`;
    }
  });

  // 3. Code block container rule
  turndown.addRule('codeBlockContainer', {
    filter: (node) => {
      const className = node.getAttribute('class') || '';
      return node.nodeName === 'DIV' && className.includes('code-block-container');
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const rawCode = readCodeBlock(el);
      const lang = getCodeLanguage(el);
      const cleanLang = (lang === 'text' || !lang) ? '' : lang;
      // A longer fence prevents pasted Markdown examples from closing the code block.
      const longestRun = (rawCode.match(/`+/g) || []).reduce((longest, run) => Math.max(longest, run.length), 0);
      const fence = '`'.repeat(Math.max(3, longestRun + 1));
      return `\n\n${fence}${cleanLang}\n${rawCode}${rawCode.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
  });

  // 4. Clean table wrappers
  turndown.addRule('tableContainer', {
    filter: (node) => node.nodeName === 'DIV' && node.classList.contains('table-container'),
    replacement: (content) => content
  });

  // 5. Headings cleanup (ignore anchor slugs)
  turndown.addRule('headings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1));
      const prefix = '#'.repeat(level);
      return `\n\n${prefix} ${content.trim()}\n\n`;
    }
  });

  return turndown;
}

export function htmlToMarkdown(htmlOrElement: string | HTMLElement): string {
  const service = createTurndownService();
  const raw = typeof htmlOrElement === 'string'
    ? service.turndown(htmlOrElement)
    : service.turndown(htmlOrElement);
  // Normalize task list spacing to standard GFM: "- [ ] " / "- [x] "
  const normalized = raw.replace(/^(\s*[-*+])\s*(\[[ xX]\])\s+/gm, '$1 $2 ');
  return normalized.trim() + '\n';
}
