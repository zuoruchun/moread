import { describe, it, expect } from 'vitest';
import { highlightCode, highlightCodeContent } from '../../src/renderer/modules/highlight.ts';
import { parseMarkdown } from '../../src/renderer/modules/parser.ts';
import { htmlToMarkdown } from '../../src/renderer/modules/editor.ts';

describe('Editable code blocks and syntax colors', () => {
  it('colors custom Bash commands, flags and numeric arguments', () => {
    const html = highlightCodeContent('qwen-start \\\n  --gpu 1 \\\n  --max-model-len 98304 \\\n  --gpu-memory-utilization 0.90\nqwen-end\ncodex-qwen\n', 'bash');
    expect(html).toContain('<span class="hljs-title">qwen-start</span>');
    expect(html).toContain('<span class="hljs-title">qwen-end</span>');
    expect(html).toContain('<span class="hljs-attr">--gpu</span>');
    expect(html).toContain('<span class="hljs-number">0.90</span>');
  });

  it('keeps shell comments, strings, variables and keywords separate from CLI coloring', () => {
    const html = highlightCodeContent('# qwen-start --gpu 1\nif true; then\n  echo "--gpu 1 $HOME"\nfi', 'sh');
    expect(html).toContain('<span class="hljs-comment"># qwen-start --gpu 1</span>');
    expect(html).toContain('<span class="hljs-keyword">if</span>');
    expect(html).toContain('<span class="hljs-string">&quot;--gpu 1 <span class="hljs-variable">$HOME</span>&quot;</span>');
  });

  it('supports aliases and a fence info string', () => {
    expect(highlightCodeContent('def hello():\n  return 42', 'py title=demo')).toContain('hljs-keyword');
    expect(highlightCodeContent('qwen-start --gpu 1', 'ZSH')).toContain('hljs-title');
  });

  it('escapes unknown languages and untrusted source rather than executing them', () => {
    const code = '<script>alert("test")</script>';
    expect(highlightCodeContent(code, 'not-a-language')).toContain('&lt;script&gt;');
    expect(highlightCode(code, '\" onfocus=\"alert(1)', false)).not.toContain('value="" onfocus=');
  });

  it('only enables language and textarea editing in editable mode', () => {
    const md = '```python\nprint(42)\n```';
    expect(parseMarkdown(md)).not.toContain('input class="code-lang"');
    const html = parseMarkdown(md, { readonly: false });
    expect(html).toContain('input class="code-lang"');
    expect(html).toContain('textarea class="code-editor"');
    expect(htmlToMarkdown(html)).toBe(md + '\n');
  });

  it('does not expose the fence separator as an extra editable blank line', () => {
    for (const raw of ['qwen-end', 'qwen-start \\\n  --gpu 1 \\\n  --max-model-len 98304 \\\n  --gpu-memory-utilization 0.90', 'first\n\n', '']) {
      const markdown = '```bash\n' + raw + '\n```\n';
      const html = parseMarkdown(markdown, { readonly: false });
      expect(html.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/)?.[1]).toBe(raw);
      expect(htmlToMarkdown(html)).toBe(markdown);
    }
  });

  it('keeps genuine trailing blank lines in editable and readonly roundtrips', () => {
    const markdown = '```bash\nfirst\n\n\n```\n';
    for (const readonly of [true, false]) {
      let current = markdown;
      for (let i = 0; i < 3; i++) current = htmlToMarkdown(parseMarkdown(current, { readonly }));
      expect(current).toBe(markdown);
    }
  });

  it('protects math-like text inside long, tilde and unterminated fences', () => {
    for (const md of ['````md\n```\n$$x$$\n```\n````', '~~~bash\necho "$foo$"\n~~~', '```bash\necho "$foo$"', '- ```bash\n  echo "$foo$"\n  ```', '    echo "$foo$"']) {
      const html = parseMarkdown(md);
      expect(html).not.toContain('mjx-container');
      expect(htmlToMarkdown(html)).toContain(md.includes('$$x$$') ? '$$x$$' : 'echo "$foo$"');
    }
  });

  it('preserves long code and blank lines over repeated editable roundtrips', () => {
    const raw = Array.from({length:200}, (_, i) => `    print(${i}, "中文 <tag>")`).join('\n') + '\n\n';
    let markdown = '```python\n' + raw + '```\n';
    for (let i = 0; i < 3; i++) markdown = htmlToMarkdown(parseMarkdown(markdown, {readonly:false}));
    expect(markdown).toBe('```python\n' + raw + '```\n');
  });
});
