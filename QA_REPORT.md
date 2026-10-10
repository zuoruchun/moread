# 墨读 MoRead - 质量验收与测试报告 (QA_REPORT)

## 当前版本 1.5.4：验证范围（2026-10-10）

下方旧报告保留为历史记录，其中 Electron、`tests/e2e/*`、100% 覆盖和缺陷清零等描述不能作为当前原生版本的验收依据。当前实现为 Swift/AppKit + WKWebView，以下结论只覆盖本次实际检查的行为。

| 检查 | 本次结果 | 覆盖与限制 |
| --- | --- | --- |
| `npm test` | 12 个文件，97 项通过 | 单元检查；保存竞态使用受控延迟和 mock，不能替代原生生命周期验证 |
| `npm run test:renderer:bridge` | 100 项通过 | 真实 WKWebView + 生产文件读写桥，隔离样本；检查替换、高亮、Unicode 偏移、撤销、dirty、过期匹配和实际磁盘内容。设置、草稿、保存确认使用测试替身 |
| Web 与原生构建 | TypeScript/Vite、arm64 Swift 编译及签名校验通过 | Vite 大包警告仍存在；编译和签名不证明功能完整 |
| 实际 AppKit 交互 | 隔离应用中目视检查正文／源码及深色高亮；全部替换后经真实保存确认框保存 | 28 处替换，磁盘字节与预先计算的结果一致。截图在测试对话中查看，未作为仓库文件保存 |

保存样本由 1520 字节变为 1772 字节；原 SHA-256 为 `6998356dc29547adb9ad30996df87697f0a15cafb106f7a331c8abe1b0af2946`，实际新 SHA-256 与预期均为 `0f881c5689ee5e5476f17faa68b2b708060af9ed40fd54b954b156a8c2e48aef`。

相关检查见 `tests/unit/search.test.ts`、`tests/unit/multi_tab_saving.test.ts`、`tests/unit/editor.test.ts` 及 `tests/native/TestRendererSuite.swift`。旧版 WebKit 的高亮降级路径通过隐藏 CSS Highlight API 模拟；中文组合输入通过合成事件验证，尚未实际手工验收中文输入法。此次未重新执行全套原生 PDF、Finder/Dock 或多窗口生命周期检查；原生标题栏实际拖动仍未确认。本次不是全项目缺陷清零验收，先前审计发现的部分安全、草稿及监听生命周期问题仍待处理。

---

## 历史报告（以下内容不代表 1.5.4 当前覆盖）

## 一、验收执行环境与版本概况
- **测试时间**：2026-09-28
- **硬件架构**：Apple M3 (`arm64`)
- **操作系统**：macOS 27.0.0 (Darwin Kernel 27.0.0)
- **底层运行时**：Node.js v20.17.0 / npm 10.8.2 / Xcode 26.6 CLI
- **发布应用版本**：MoRead v1.0.0 (Production Release)
- **自动化测试栈**：Vitest 2.1.9 (单元测试) + Playwright 1.63.0 (真实 Electron 桌面 E2E)
- **验收总体结论**：**全部通过 (PASS)**。所有核心需求覆盖率 100%，Blocker / High 严重级别缺陷清零，同一候选构建版本全量回归**连续通过 2 次**。

---

## 二、需求与测试闭环对照表

| 需求大项 | 核心规格要求 | 自动化测试用例 | 实际执行结果 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **A. 文件管理** | 支持 .md/.markdown，打开文件/文件夹对话框、Finder 打开、Dock 激活、最近文件、只读目录树、特殊字符路径（中文、空格、#、%、emoji）、外部程序修改热重载并保持滚动位置 | `tests/e2e/file-lifecycle.spec.ts`<br>`tests/e2e/round2-security-boundary.spec.ts` (2.5) | 特殊路径全部正常加载，热重载保持比例精准，最近文件正常记录 | **已通过** |
| **B. 学术渲染** | CommonMark/GFM 全要素、多列对齐表格防布局撑坏、只读任务清单、highlight.js 离线多语言高亮、无损复制代码（保留缩进与换行）、文内锚点定位、MathJax 3 矢量公式与容错 | `tests/unit/parser.test.ts`<br>`tests/unit/math.test.ts`<br>`tests/e2e/round1-functional.spec.ts` | 复杂矩阵、方程组、分段函数、行内/行间公式精准渲染；非数学货币字符零误识别；代码一键复制 | **已通过** |
| **C. 阅读交互** | 单栏阅读优先、可收起文档大纲（TOC）、只读源码模式自由切换、浅色/深色/跟随系统主题切换、Cmd+F 全文中文搜索（高亮、上一处/下一处、计数）、macOS 标准快捷键与菜单 | `tests/e2e/round3-interaction-visual.spec.ts` | 搜索高亮与上下跳转正常，深浅色切换平滑，源码视图无缝切换，窄窗口布局自适应 | **已通过** |
| **D. 文件安全** | 严格只读（测试前后比对 SHA-256 哈希值保证原文件零变动）、用户配置与最近记录完全隔离在应用专属目录（`userData`） | `tests/e2e/round2-security-boundary.spec.ts` (2.8) | 操作前后测试文件 SHA-256 哈希值 100% 绝对一致，完全未发生任何改写 | **已通过** |
| **E. 安全沙箱** | 强制启用 `contextIsolation`、`sandbox`，彻底关闭 `nodeIntegration`，严格 CSP 策略，DOMPurify 拦截 XSS/SVG 脚本，`mored://` 严格校验根路径拦截目录穿越，外链使用系统浏览器唤起 | `tests/e2e/round2-security-boundary.spec.ts` (2.6, 2.7) | 攻击脚本与 onload 事件全量静默剥离，跨目录越权读取返回 403 Forbidden | **已通过** |

---

## 三、五轮针对性测试执行详细证据

### 第 1 轮：正常功能与渲染正确性 (Functional & Rendering)
- **执行命令**：`npx playwright test tests/e2e/round1-functional.spec.ts`
- **执行时间**：1.5s
- **验证项**：
  1. `1.1 Open standard.md and verify full GFM elements`：标题、段落、粗斜体、删除线、嵌套引用、列表、表格、只读任务框、TypeScript 与 Python 语法高亮、一键复制代码。
  2. `1.2 Open math-academic.md and verify LaTeX math equations`：`$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`pmatrix`、`bmatrix`、`aligned`、`cases`。
  3. `1.3 Verify document outline TOC items and smooth scroll`：自动提取 12 级标题，大纲点击触发平滑滚动。
- **结果**：3 项全数通过 (3 passed)。

### 第 2 轮：异常输入、文件边界与安全防线 (Edge Cases & Security)
- **执行命令**：`npx playwright test tests/e2e/round2-security-boundary.spec.ts`
- **执行时间**：1.6s
- **验证项**：
  1. `2.1 Empty file loading without crash`：0 字节空文件打开，无白屏崩溃，状态栏显示 0 字符。
  2. `2.2 UTF-8 BOM file loading and BOM stripping`：正确去除 `\uFEFF`，正文标题解析无乱码。
  3. `2.3 CRLF line endings normalization`：Windows 格式 CRLF 自动归一化为 LF。
  4. `2.4 Edge cases: long line, nested lists, missing image, wide table`：超长无空格单行文字自动折行，10 级嵌套列表正常缩进，宽表格启用横向平滑滚动条未撑坏窗口。
  5. `2.5 Special path handling (Chinese, spaces, #, %, brackets, emoji)`：`测试文档 #1 [2026] 🏷️.md` 路径解析正常。
  6. `2.6 Security & XSS Injection Protection`：拦截 `<script>`、`<img onerror>`、`<svg onload>`、`javascript:` 伪协议链接，`window.__xss_pwned` 保持 undefined。
  7. `2.7 Safe Protocol (mored://) Path Traversal Defense`：尝试读取 `/etc/passwd`，返回 HTTP 403 Forbidden。
  8. `2.8 Strict Read-Only Guarantee: SHA-256 Hash Verification`：测试前后计算源文件 SHA-256，证明无任何意外修改。
- **结果**：8 项全数通过 (8 passed)。

### 第 3 轮：真实 macOS 桌面交互与 UI 视觉审核 (macOS GUI & Visual QA)
- **执行命令**：`npx playwright test tests/e2e/round3-interaction-visual.spec.ts`
- **执行时间**：1.8s
- **审查截图成果**：
  - [round3-light.png](file:///Users/zuoruchun/Desktop/Projects/markdown/tests/screenshots/round3-light.png)：浅色模式下 macOS 原生黑白灰质感、Typora 式排版。
  - [round3-dark.png](file:///Users/zuoruchun/Desktop/Projects/markdown/tests/screenshots/round3-dark.png)：深色模式视觉对比度柔和、字体清晰、代码块与高亮协调。
  - [round3-math.png](file:///Users/zuoruchun/Desktop/Projects/markdown/tests/screenshots/round3-math.png)：学术级 LaTeX 公式无锯齿 SVG 矢量呈现，矩阵与分式排版工整。
  - [round3-narrow.png](file:///Users/zuoruchun/Desktop/Projects/markdown/tests/screenshots/round3-narrow.png)：420px 窄窗口下响应式折叠无挤压，正文阅读排版稳定。
- **交互验证项**：Cmd+F 中文拼音搜索、实时高亮匹配计数、Enter/Shift+Enter 上下遍历、Esc 退出、只读源码模式双向切换。
- **结果**：5 项全数通过 (5 passed)，截图已完成人工审阅。

### 第 4 轮：稳定性、竞态条件与故障恢复 (Stability & Performance)
- **执行命令**：`npx playwright test tests/e2e/round4-stability.spec.ts`
- **执行时间**：9.7s
- **性能实测数据**：
  - **10KB 文档**：加载与首屏耗时 **133 ms**
  - **1MB 复杂长文档**：加载与全要素解析耗时 **1023 ms** (~1秒)
  - **10MB 著作级超大文档**：全量加载与解析耗时 **6654 ms** (~6.6秒)，内存保持在 150MB 以下
- **并发与容灾实测**：
  - **100 次极速切换竞态防串染**：快速在不同文档间切换 100 次，请求令牌保证最新文档独占渲染，耗时 588 ms，无过期内容串染。
  - **50 次文件热重载**：快速触发 50 次重载，内存平稳，文件句柄零泄漏，耗时 180 ms。
  - **损坏配置文件自愈**：写入非法畸变 JSON 至 `moread-config.json`，应用启动自动捕获并无损恢复默认配置。
- **结果**：4 项全数通过 (4 passed)。

### 第 5 轮：独立 Release 发布包验收 (Release Bundle Acceptance)
- **执行命令**：`npx playwright test tests/e2e/round5-release-acceptance.spec.ts`
- **执行时间**：3.6s
- **执行环境**：挂载正式生成的 `dist/MoRead-1.0.0-arm64.dmg`，将 `MoRead.app` 复制到沙箱目录 `/tmp/moread-acceptance/`，并在完全脱离 Node/npm/项目源码的独立终端环境中冷启动运行。
- **验证项**：
  1. `5.1 Standalone App Cold Boot & Welcome Screen Verification`：独立发布应用独立双击冷启动秒开，欢迎页与系统菜单完好。
  2. `5.2 Offline Bundled LaTeX MathJax & Asset Verification`：在无网络环境下加载复杂学术公式，内置 SVG 字体与数学矢量图形渲染无破损。
  3. `5.3 Full GFM & Syntax Highlighting in Packaged Binary`：发布包中内置 highlight.js 与样式表正确执行。
  4. `5.4 Reopen & Lifecycle Verification`：多次关闭重开，应用状态稳定。
- **结果**：4 项全数通过 (4 passed)。

---

## 四、连续全量回归验证证据 (2x Consecutive Passes)

依据验收门槛第 3 条要求，在候选版本定稿后，连续执行两次完整回归（Vitest 单元测试 13 项 + Playwright 端到端 25 项，共 38 个用例）：

- **第 1 次全量回归**：
  - Vitest：13 passed in 338ms
  - Playwright：25 passed in 14.6s
  - 结果：**100% PASS**
- **第 2 次全量回归**：
  - Vitest：13 passed in 342ms
  - Playwright：25 passed in 14.7s
  - 结果：**100% PASS**

零跳过、零降级、零失败，满足最终交付停止条件。

---

## 五、Native Swift / WebKit 原生架构专项评测与针对性测试

在用户提出“将体积降至 Typora 级别（~14MB）并维持极致流畅”的需求后，MoRead 彻底升级为与 Typora macOS 版本完全一致的原生架构：**Swift 6 + AppKit 原生宿主 + 系统级 WebKit (WKWebView)**。

### 1. 架构与性能全方位指标对比

| 评测维度 | 原 Electron 架构 | Native Swift + WKWebView 架构 | 改进幅度 / 优势 |
| :--- | :--- | :--- | :--- |
| **DMG 安装包体积** | 106.0 MB | **1.4 MB** | **体积骤减 98.7%** (比 Typora 14MB 还轻量 90%) |
| **ZIP 压缩包体积** | 102.0 MB | **1.1 MB** | **体积骤减 98.9%** |
| **解压后 App 目录体积**| 280.0 MB | **3.1 MB** | **体积骤减 98.9%** |
| **应用冷启动耗时** | ~320 ms | **2.0 ms** | **提速 160 倍**（几乎瞬间呈现） |
| **基准运行内存 (RSS)** | 250 MB ~ 320 MB (4个进程) | **~98 MB** (单原生进程) | **内存节省 60%~70%** |
| **1MB 文档读取+解码**| 25 ms | **0.72 ms** | 极速秒开 |
| **10MB 巨型文档读取+解码**| 120 ms | **6.72 ms** | 极致吞吐，绝不卡死 |
| **屏幕刷新与动画体验**| 依赖 Chromium 渲染管线 | macOS 原生 CoreAnimation / Metal | 原生支持 120Hz ProMotion 高刷 |

### 2. Native Swift 针对性测试用例集 (`TestNativeSuite.swift`)

针对原生文件系统操作、编码兼容、路径异常、事件监听与绝对安全性，执行了专有自动化测试套件：

- **Group 1: 文本编码与格式处理 (6 项)**
  - `✓ PASS: Standard markdown file read cleanly`（标准文档 UTF-8 正确解码）
  - `✓ PASS: Code blocks present in standard doc`（代码块高亮标记完备）
  - `✓ PASS: bom.md fixture contains UTF-8 BOM prefix`（探测 0xEF 0xBB 0xBF 标记）
  - `✓ PASS: UTF-8 BOM is completely removed from content string`（去除 BOM 首字符）
  - `✓ PASS: Document begins with title after BOM strip`（去 BOM 后首行标题解析无误）
  - `✓ PASS: crlf.md fixture has Windows \r\n line endings`（探测 Windows 换行符）
  - `✓ PASS: Normalized content has NO \r\n`（Windows CRLF 成功归一化为 LF）
  - `✓ PASS: Normalized content preserves standard \n`（标准 LF 换行完整保留）
- **Group 2: 特殊路径与空文件边界 (3 项)**
  - `✓ PASS: Special path file exists on disk`（特殊字符文件物理存在校验）
  - `✓ PASS: Read file with spaces, '#', brackets, and emojis`（完美打开 `special paths/测试文档 #1 [2026] 🏷️.md`）
  - `✓ PASS: Empty file correctly decodes to empty string without crash`（0 字节空文件打开无崩溃）
- **Group 3: 大文件吞吐性能基准 (2 项)**
  - `✓ PASS: 1MB file reads and decodes in under 100ms`（实测 0.72 ms）
  - `✓ PASS: 10MB file reads and decodes in under 500ms`（实测 6.72 ms）
- **Group 4: 错误边界与越界防护 (2 项)**
  - `✓ PASS: Non-existent path correctly recognized`（不存在路径友好报错，不崩溃）
  - `✓ PASS: Directory path identified, guarded from being read as file`（目录误当文件防护）
- **Group 5: 目录树扫描与过滤 (2 项)**
  - `✓ PASS: Scanned at least 8 markdown files in fixtures directory`（目录树深度遍历正常）
  - `✓ PASS: Scanned subdirectories (e.g. 'special paths')`（子文件夹递归与特殊字符过滤）
- **Group 6: 用户偏好持久化 (4 项)**
  - `✓ PASS: Settings contains theme property`
  - `✓ PASS: Settings contains readingWidth property`
  - `✓ PASS: Theme updated to dark and persisted`（写入 ~/Library/Application Support/moread/）
  - `✓ PASS: FontSize updated to 18 and persisted`（字号设置重启保持）
- **Group 7: FileWatcher 外部修改热重载 (1 项)**
  - `✓ PASS: FileWatcher correctly detected file modification and notified`（GCD 文件描述符原子写入捕获与 200ms 防抖测试通过）
- **Group 8: 严格只读源文件 SHA-256 绝对不变保证 (1 项)**
  - `✓ PASS: All 10 test fixtures have 100% identical SHA-256 hashes (Strictly Read-Only Guarantee)`（全流程无任何一次针对源文件的写入）

**测试结果汇总**：Native 专项用例 23 项全数通过 (23 Passed, 0 Failed)。加上 Web 核心单元测试 18 项，总自动化用例 41 项均保持 100% PASS。

