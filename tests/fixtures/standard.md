# 墨读 MoRead 标准排版测试

这是一个用于验证 CommonMark 和 GitHub Flavored Markdown (GFM) 标准特性的样例文件。

## 一、排版与样式

这是一段常规正文段落，包含 **粗体文字**、*斜体文字*、~~删除线文字~~ 以及 `行内代码`。
支持文内链接：[跳转至底部表格](#三数据表格)。

> 这是一个引用块（Blockquote）。
> 引用块内可以包含多行文字，用于文献引用或重要说明。
> > 嵌套的二级引用块。

## 二、任务列表与有序/无序列表

### 1. 任务复选框（阅读模式只读）
- [x] 已完成的核心需求：文件沙箱与只读保护
- [ ] 待验证的扩展测试：性能压测与大文件加载
- [x] LaTeX 数学公式离线 SVG 渲染

### 2. 多级无序列表
* 一级列表项 A
  * 二级列表项 A-1
  * 二级列表项 A-2
    * 三级列表项 A-2-1
* 一级列表项 B

### 3. 多级有序列表
1. 第一阶段：脚手架搭建与原型打通
2. 第二阶段：核心解析引擎与学术渲染
3. 第三阶段：全链路质量测试与发布

## 三、数据表格

| 功能模块 | 对应技术栈 | 离线支持 | 性能表现 |
| :--- | :---: | :---: | ---: |
| 核心框架 | Electron 32 + TS | ✅ 是 | 原生秒启 |
| 数学引擎 | MathJax 3 (SVG) | ✅ 是 | 矢量清晰 |
| 代码高亮 | highlight.js | ✅ 是 | 零外部依赖 |
| 安全协议 | mored:// 隔离 | ✅ 是 | 阻止越权 |

## 四、代码块高亮与复制

```typescript
// TypeScript 样例代码
interface BookReview {
  id: string;
  title: string;
  wordCount: number;
  tags: string[];
}

function displayReview(review: BookReview): void {
  console.log(`[${review.id}] ${review.title} (${review.wordCount} words)`);
}
```

```python
# Python 样例代码
def fibonacci(n: int) -> list[int]:
    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence[:n]

if __name__ == "__main__":
    print(fibonacci(10))
```

---
*测试文档结尾*
