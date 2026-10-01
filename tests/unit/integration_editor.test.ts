import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseMarkdown, extractHeadings } from '../../src/renderer/modules/parser.ts';
import { htmlToMarkdown } from '../../src/renderer/modules/editor.ts';

describe('Editor End-to-End Formatting & Roundtrip Suite', () => {
  it('preserves complex markdown document roundtrip (headings, math, code, tasks, tables)', () => {
    const originalMarkdown = `# 标题测试

这是一段普通的文本，包含 **粗体** 和 *斜体* 以及 \`行内代码\`。

## 数学公式测试

行内公式 $E = mc^2$ 测试。

独立块级公式：

$$
\\sum_{i=1}^{n} X_i = Y
$$

## 代码块测试

\`\`\`typescript
interface User {
  id: string;
  name: string;
}
\`\`\`

## 任务列表

- [ ] 未完成的任务
- [x] 已完成的任务

## 表格测试

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 用户唯一ID |
| name | string | 用户姓名 |
`;

    // 1. Markdown -> HTML (WYSIWYG initial render)
    const html = parseMarkdown(originalMarkdown, { readonly: false });
    expect(html).toContain('math-block-wrapper');
    expect(html).toContain('math-inline-wrapper');
    expect(html).toContain('task-list-item-checkbox');
    expect(html).toContain('code-block-container');

    // 2. HTML -> Markdown (Serialization when switching to source mode or saving)
    const convertedMarkdown = htmlToMarkdown(html);

    // Verify all key structural components are completely preserved
    expect(convertedMarkdown).toContain('# 标题测试');
    expect(convertedMarkdown).toContain('**粗体**');
    expect(convertedMarkdown).toContain('*斜体*');
    expect(convertedMarkdown).toContain('`行内代码`');
    expect(convertedMarkdown).toContain('$E = mc^2$');
    expect(convertedMarkdown).toContain('$$\n\\sum_{i=1}^{n} X_i = Y\n$$');
    expect(convertedMarkdown).toContain('```typescript');
    expect(convertedMarkdown).toContain('interface User');
    expect(convertedMarkdown).toContain('- [ ] 未完成的任务');
    expect(convertedMarkdown).toContain('- [x] 已完成的任务');
    expect(convertedMarkdown).toContain('| 参数 | 类型 | 说明 |');
    expect(convertedMarkdown).toContain('| id | string | 用户唯一ID |');
  });

  it('correctly updates headings outline after markdown content edits', () => {
    const raw1 = '# 原始第一章\n## 第一节\n';
    const headings1 = extractHeadings(raw1);
    expect(headings1).toHaveLength(2);
    expect(headings1[0].text).toBe('原始第一章');

    const edited = '# 修改后的第一章\n## 新增第二节\n### 小结\n';
    const headings2 = extractHeadings(edited);
    expect(headings2).toHaveLength(3);
    expect(headings2[0].text).toBe('修改后的第一章');
    expect(headings2[2].text).toBe('小结');
  });

  it('correctly preserves code block indentation across multiple edits', () => {
    const codeMarkdown = `\`\`\`python
def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
\`\`\``;

    const html = parseMarkdown(codeMarkdown, { readonly: false });
    const mdOut = htmlToMarkdown(html);

    expect(mdOut).toContain('def fib(n):');
    expect(mdOut).toContain('    if n <= 1:');
    expect(mdOut).toContain('        return n');
    expect(mdOut).toContain('    return fib(n - 1) + fib(n - 2)');
  });
});
