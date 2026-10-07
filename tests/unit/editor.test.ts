import { describe, it, expect } from 'vitest';
import { createTurndownService, htmlToMarkdown } from '../../src/renderer/modules/editor.ts';

describe('Editor HTML to Markdown Converter', () => {
  it('converts standard headings, paragraphs, and formatting', () => {
    const html = '<h1>Heading 1</h1><p>This is <strong>bold</strong> and <em>italic</em>.</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('# Heading 1');
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
  });

  it('converts lists and task lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('Item 1');
    expect(md).toContain('Item 2');
  });

  it('converts math blocks and inline math preserving raw formulas', () => {
    const html = '<div class="math-block-wrapper" data-raw-formula="\\sum_{i=1}^n x_i = 10"><span style="display:none">math</span><svg></svg></div><p>Formula <span class="math-inline-wrapper" data-raw-formula="E = mc^2"><span style="display:none">math</span><svg></svg></span> inline</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('$$\n\\sum_{i=1}^n x_i = 10\n$$');
    expect(md).toContain('$E = mc^2$');
  });

  it('converts code blocks with language and exact indentation', () => {
    const code = 'function hello() {\n  console.log("world");\n}';
    const encoded = encodeURIComponent(code);
    const html = `
<div class="code-block-container">
  <div class="code-block-header">
    <span class="code-lang">javascript</span>
    <button class="code-copy-btn" data-code="${encoded}">复制</button>
  </div>
  <pre><code class="hljs language-javascript"><span class="hljs-keyword">function</span> hello() {\n  console.log("world");\n}</code></pre>
</div>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('```javascript');
    expect(md).toContain('function hello() {\n  console.log("world");\n}');
    expect(md).toContain('```');
  });

  it('converts GFM tables', () => {
    const html = `
<div class="table-container">
  <table>
    <thead><tr><th>Name</th><th>Age</th></tr></thead>
    <tbody><tr><td>Alice</td><td>24</td></tr></tbody>
  </table>
</div>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('| Name | Age |');
    expect(md).toContain('| Alice | 24 |');
  });

  it('converts blockquotes and nested formatting', () => {
    const html = '<blockquote><p>Quote line 1</p><p>Quote line 2</p></blockquote>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('> Quote line 1');
    expect(md).toContain('> Quote line 2');
  });

  it('converts task lists with checked and unchecked states', () => {
    const html = '<ul><li><input type="checkbox" class="task-list-item-checkbox"> Unchecked</li><li><input type="checkbox" checked class="task-list-item-checkbox"> Checked</li></ul>';
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/- \[[ ]\]\s+Unchecked/);
    expect(md).toMatch(/- \[[xX]\]\s+Checked/);
  });

  it('handles code blocks when language is text or omitted', () => {
    const html = `
<div class="code-block-container">
  <div class="code-block-header">
    <span class="code-lang">text</span>
    <button class="code-copy-btn" data-code="${encodeURIComponent('plain text code')}">复制</button>
  </div>
  <pre><code class="hljs language-text">plain text code</code></pre>
</div>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('```\nplain text code\n```');
  });

  it('handles empty input gracefully', () => {
    const md = htmlToMarkdown('');
    expect(md.trim()).toBe('');
  });

  it('saves live code instead of a stale copy-button cache', () => {
    const html = '<div class="code-block-container" data-language="python"><input class="code-lang" value="python"><button class="code-copy-btn" data-code="old%20code">复制</button><pre><code><span class="hljs-keyword">print</span>("更新")\n\n</code></pre></div>';
    expect(htmlToMarkdown(html)).toBe('```python\nprint("更新")\n\n```\n');
  });

  it('handles empty code and edited plaintext line-break DOM', () => {
    expect(htmlToMarkdown('<div class="code-block-container"><input class="code-lang" value=""><button>复制</button><pre><code></code></pre></div>'))
      .toBe('```\n\n```\n');
    expect(htmlToMarkdown('<div class="code-block-container" data-language="js"><button>复制</button><pre><code>one<div>two<br>three</div><div>four</div></code></pre></div>'))
      .toContain('one\ntwo\nthree\nfour');
  });

  it('uses a safe fence for pasted Markdown examples and normalizes unsafe language input', () => {
    const html = '<div class="code-block-container" data-language="markdown&#10;`"><button>复制</button><pre><code>```js\nconst x = 1;\n```\n</code></pre></div>';
    expect(htmlToMarkdown(html)).toBe('````markdown\n```js\nconst x = 1;\n```\n````\n');
  });
});
