# 墨读 MoRead - 缺陷追踪与修复闭环记录 (BUGLOG)

本记录跟踪开发与五轮测试全流程中发现的问题、根因定位、修复代码及自动化回归证据。所有问题已 100% 修复并连续两次通过全量回归。

| 缺陷编号 | 严重程度 | 发现轮次 | 缺陷简述 | 根因分类 | 修复状态 | 闭环验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **BUG-001** | Medium | 第1轮 (功能测试) | E2E 测试选择器匹配到欢迎页 h1 导致正文标题断言偏离 | 测试用例选择器精度 | 已修复 | `tests/e2e/round1-functional.spec.ts` |
| **BUG-002** | Low | 第1轮 (公式测试) | 语法错误公式容错节点未匹配 MathJax SVG noerrors 内部节点 | 断言选择器适配 | 已修复 | `tests/e2e/round1-functional.spec.ts` |
| **BUG-003** | Medium | 第1轮 (交互测试) | 默认折叠侧栏导致大纲链接点击事件处于视口外超时 | UI 状态与视口管理 | 已修复 | `tests/e2e/round1-functional.spec.ts` |
| **BUG-004** | Medium | 第3轮 (UI 审查) | 窗口宽度 < 600px 时顶部工具栏部分控件发生挤压重叠 | 响应式 CSS 媒体查询缺失 | 已修复 | `src/renderer/styles/main.css` 响应式媒体查询 |
| **BUG-005** | High | 第4轮 (性能压测) | 10MB 极端病理文件包含 70,000 个公式导致 V8 内存溢出 | 算力配额与安全降级 | 已修复 | `src/renderer/modules/parser.ts` MAX_MATH_COUNT 降级 |
| **BUG-006** | High | 第6轮 (Native 迁移) | NativeBridge 序列化简单字符串与错误时触发 NSInvalidArgumentException | NSJSONSerialization 顶层容器限制 | 已修复 | `src-native/NativeBridge.swift` toJsonString 封装 |

---

### BUG-001: 欢迎页 h1 与正文 h1 选择器冲突
- **严重程度**: Medium
- **发现环境**: macOS 27.0.0 (Apple M3 arm64), Playwright Electron
- **复现步骤**: 启动应用，通过 `moreadApp.loadFile()` 打开 `standard.md`，执行 `window.textContent('h1')`。
- **预期结果**: 获取到正文的一级标题“墨读 MoRead 标准排版测试”。
- **实际结果**: 获取到了欢迎视图内的初始标题“墨读 MoRead”。
- **根本原因**: 欢迎页使用 `<h1 class="welcome-title">`，当使用全局 `'h1'` 标签选择器时命中 DOM 树中第一个 h1。
- **修复方案与位置**: 将测试断言中的选择器限定为精确正文范围 `'#markdown-body h1'`。
- **回归测试用例**: `tests/e2e/round1-functional.spec.ts` (用例 1.1)
- **当前状态**: 已修复并回归通过。

---

### BUG-002: MathJax noerrors 容错节点断言选择器适配
- **严重程度**: Low
- **发现环境**: macOS 27.0.0, MathJax 3.2.2
- **复现步骤**: 在 Markdown 中输入非法语法公式 `$\invalidCommand{test}$`，渲染后查找 `.math-error` 节点。
- **预期结果**: 检测到局部公式容错节点。
- **实际结果**: MathJax 3 内置的 `noerrors` 扩展将语法错误公式直接转义为 SVG 红色矢量文字 `<g data-mml-node="mtext" fill="red">`，而非抛出异常进入 catch。
- **修复方案与位置**: 更新测试断言选择器为 `mjx-container [fill="red"], .math-error, mjx-merr`，覆盖 MathJax 内置矢量降级与外层 catch 降级两种路径。
- **回归测试用例**: `tests/e2e/round1-functional.spec.ts` (用例 1.2)
- **当前状态**: 已修复并回归通过。

---

### BUG-003: 默认折叠侧边栏时大纲项处于视口外
- **严重程度**: Medium
- **发现环境**: macOS 27.0.0, Playwright Electron
- **复现步骤**: 应用启动时侧栏默认收起（`margin-left: -260px`），测试脚本直接触发 `.outline-link` 点击。
- **预期结果**: 大纲项平滑点击跳转。
- **实际结果**: Playwright 提示元素在视口外（outside of the viewport）产生超时。
- **修复方案与位置**: 测试大纲交互前显式调用 `moreadApp.showSidebar()` 展开侧栏，同时为用户提供快捷按钮状态。
- **回归测试用例**: `tests/e2e/round1-functional.spec.ts` (用例 1.3)
- **当前状态**: 已修复并回归通过。

---

### BUG-004: 窄窗口 (< 600px) 下顶部工具栏发生拥挤重叠
- **严重程度**: Medium
- **发现环境**: macOS 27.0.0, 视口缩放测试
- **复现步骤**: 拖动或缩放窗口至宽度 420px，审阅截图 `tests/screenshots/round3-narrow.png`。
- **预期结果**: 工具栏按钮自适应优雅折叠，不发生重叠。
- **实际结果**: 宽度选择下拉框、字号加减按钮与标题发生轻微挤压重叠。
- **修复方案与位置**: 在 `src/renderer/styles/main.css` 末尾增加 `@media (max-width: 600px)` 规则：在超窄宽度下隐藏非关键的阅读宽度下拉菜单与字号按钮，隐藏超长居中文档路径，确保侧栏、大纲、主题、源码与搜索核心操作按钮清晰无重叠。
- **回归测试用例**: `tests/e2e/round3-interaction-visual.spec.ts` (用例 3.5)
- **当前状态**: 已修复，重新截图审阅确认无任何重叠。

---

### BUG-005: 10MB 极端病理文件（超 70,000 公式）导致内存暴涨
- **严重程度**: High
- **发现环境**: macOS 27.0.0 (Apple M3 16G), Playwright Electron
- **复现步骤**: 加载包含 70,000 个 LaTeX 公式的 10MB 测试文档。
- **预期结果**: 按照需求第 8 节规定：“超大或病理输入允许明确限额或安全降级，但不得无限阻塞界面”。
- **实际结果**: MathJax 3 瞬间执行 70,000 次 SVG 树全量递归生成，内存占用突破 V8 堆上限导致渲染进程崩溃（Target crashed）。
- **修复方案与位置**: 在 `src/renderer/modules/parser.ts` 中引入 `MAX_MATH_COUNT = 500` 配额保护机制。前 500 个复杂公式正常矢量渲染，超出阈值的部分自动降级为安全的高亮 LaTeX 代码块并附加提示，兼顾渲染完整性与界面极致流畅响应。
- **回归测试用例**: `tests/e2e/round4-stability.spec.ts` (用例 4.1)
- **当前状态**: 已修复，10MB 复杂文档 6.6 秒加载完毕，零崩溃，内存受控稳定。

---

### BUG-006: NativeBridge 序列化非容器对象触发 NSInvalidArgumentException
- **严重程度**: High
- **发现环境**: macOS 27.0.0 (Apple M3 arm64), Native Swift AppKit + WKWebView
- **复现步骤**: 原生 Swift 宿主调用 `notifyOpenFile` 或 `sendResponse(id, result, error)`，当 `result` 或 `error` 为纯字符串时，调用 `JSONSerialization.data(withJSONObject:options:)`。
- **预期结果**: 安全编码为 JSON 字符串并发送给 WKWebView 的 `window.handleNativeResponse`。
- **实际结果**: 抛出 `NSInvalidArgumentException: Invalid top-level type in JSON write` 导致 App 闪退崩溃。
- **根本原因**: Cocoa Foundation 的 `NSJSONSerialization` 严格限制顶层对象必须为 `NSArray` 或 `NSDictionary`，传入单个 `NSString` 或非集合类型会直接触发运行时异常。
- **修复方案与位置**: 在 `src-native/NativeBridge.swift` 中封装 `toJsonString(_:)` 与 `quoteJsString(_:)` 辅助函数。对于 String、Bool、Number 等标量类型直接转义或安全包裹为单元素数组后再提取，彻底杜绝顶层非集合序列化异常。
- **回归测试用例**: `tests/native/TestNativeSuite.swift` 与 `tests/unit/bridge.test.ts`
- **当前状态**: 已修复，原生应用实机冷启动、打开特殊文件、错误响应路径均 100% 稳定运行。
