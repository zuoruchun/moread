import { describe, it, expect } from 'vitest';
import { parseMarkdown, extractHeadings } from '../../src/renderer/modules/parser.ts';

describe('Markdown Parser & Academic Content Pipeline', () => {
  it('uses visible numbered headings without Markdown escape backslashes', () => {
    const markdown = '# 1\\. **开头**\n## 2\\. [正文](https://example.com)\n### 3\\. 结尾';
    const headings = extractHeadings(markdown);
    expect(headings.map(h => h.text)).toEqual(['1. 开头', '2. 正文', '3. 结尾']);
    const html = parseMarkdown(markdown);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
  });

  it('handles setext, duplicate, formatted and entity headings with matching anchors', () => {
    const markdown = '标题 &amp; 小节\n===\n\n## **相同**\n## 相同\n## `C:\\Temp`\n## $x^2$ 公式';
    const headings = extractHeadings(markdown);
    expect(headings.map(h => h.text)).toEqual(['标题 & 小节', '相同', '相同', 'C:\\Temp', '$x^2$ 公式']);
    expect(headings[2].id).toBe('相同-1');
    const html = parseMarkdown(markdown);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
  });

  it('ignores headings in both tilde and backtick fences and indented code', () => {
    const markdown = '~~~md\n# 不显示\n~~~\n\n```md\n## 也不显示\n```\n\n    # 代码\n\n## 显示';
    expect(extractHeadings(markdown).map(h => h.text)).toEqual(['显示']);
  });

  it('keeps legitimate backslashes and literal trailing hash characters', () => {
    expect(extractHeadings('# `C:\\Temp`\n## C#\n## 标题 ###').map(h => h.text))
      .toEqual(['C:\\Temp', 'C#', '标题']);
  });

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

  it('should route relative local images through the protected native scheme', () => {
    const html = parseMarkdown('![plot](figures/result.png)', {
      currentFilePath: '/research/paper.md'
    });
    expect(html).toContain('mored://local?path=%2Fresearch%2Ffigures%2Fresult.png');
  });

  it('should block remote images unless explicitly enabled', () => {
    const blocked = parseMarkdown('![remote](https://example.com/plot.png)', {
      currentFilePath: '/research/paper.md'
    });
    const allowed = parseMarkdown('![remote](https://example.com/plot.png)', {
      currentFilePath: '/research/paper.md',
      allowRemoteImages: true
    });
    expect(blocked).toContain('远程图片已拦截');
    expect(allowed).toContain('https://example.com/plot.png');
  });
});
