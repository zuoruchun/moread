import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../src/renderer/modules/parser.ts';

describe('Markdown Parser & Academic Content Pipeline', () => {
  it('should parse GFM tables', () => {
    const md = `| Header 1 | Header 2 |\n| :--- | :---: |\n| Cell 1 | Cell 2 |`;
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('<table');
    expect(html).toContain('Header 1');
    expect(html).toContain('Cell 1');
  });

  it('should parse task lists as disabled read-only checkboxes', () => {
    const md = `- [ ] Task 1\n- [x] Task 2`;
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).toContain('checked');
  });

  it('should highlight code blocks with language and provide copy markup', () => {
    const md = "```typescript\nconst greeting: string = 'hello';\n```";
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('class="hljs');
    expect(html).toContain('data-code');
    expect(html).toContain('class="code-copy-btn"');
  });

  it('should render inline math with $...$ and \\(...\\)', () => {
    const md = 'Let $E = mc^2$ and \\(a^2 + b^2 = c^2\\) be equations.';
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('<mjx-container');
    expect(html).toContain('<svg');
  });

  it('should render display math with $$...$$ and \\[...\\]', () => {
    const md = '$$\n\\int_0^1 x^2 \\mathrm{d}x = \\frac{1}{3}\n$$\n\n\\[\n\\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n\\]';
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('display="true"');
  });

  it('should NOT treat currency or escaped dollars as math', () => {
    const md = 'Price is $100 and tax is $50. Also \\$20 discount.';
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).not.toContain('<mjx-container');
    expect(html).toContain('$100');
    expect(html).toContain('$50');
  });

  it('should NOT parse math inside inline code or fenced code blocks', () => {
    const md = 'Code `const $var = "$foo$";` and block:\n```\n$$ not math $$\n```';
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).toContain('const $var =');
    expect(html).toContain('$$ not math $$');
  });

  it('should strip dangerous XSS scripts, handlers, and dangerous hrefs', () => {
    const md = '<script>alert("xss")</script>\n\n<img src="invalid.jpg" onerror="alert(1)">\n\n[Click](javascript:alert(1))';
    const html = parseMarkdown(md, { currentFilePath: '/test/doc.md' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("xss")');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });
});
