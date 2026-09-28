# 墨读 MoRead

> 专注纯净阅读与学术排版的 macOS 个人专属 Markdown 桌面阅读器。

墨读（MoRead）专为追求极致沉浸阅读体验的学者、工程师与写作者打造。参考 Typora 的黑白灰克制排版风格，全面支持 CommonMark 与 GitHub Flavored Markdown (GFM) 标准，离线集成学术级 MathJax 3 矢量数学引擎与多语言代码高亮。

---

## 🌟 核心特性

- **阅读优先与原生排版**：极简黑白灰视觉质感，多级文档大纲导航（TOC），字号加减，标准/紧凑/宽松/全宽多档阅读宽度。
- **学术级 LaTeX 数学公式**：100% 离线 MathJax 3 SVG 矢量渲染，支持行内（`$...$` 与 `\(...\)`）与独立行间（`$$...$$` 与 `\[...\]`），全面兼容矩阵（`pmatrix`, `bmatrix`）、方程组对齐（`aligned`）、分段函数（`cases`）等复杂环境，局部语法错误优雅降级不崩整篇；严密隔离普通货币符号（如 `$100`）防误触。
- **语法高亮与无损复制代码**：集成 highlight.js 离线高亮，一键复制代码块时精准保留换行符、缩进与空格。
- **全文档中文搜索**：`Cmd+F` 快速唤起文内搜索，支持中文拼音与英文大小写匹配，实时呈现“第 X 处 / 共 Y 处”并高亮定位。
- **绝对文件安全与只读保护**：默认绝对只读，打开、翻阅、搜索、切换主题或点击任务清单复选框绝不改写原文件；自动化测试通过 SHA-256 哈希严格验证不变性。
- **沙箱与隐私防御**：基于 AppKit 与 WKWebView 原生隔离；原生只读文件处理与文件变更监听；自定义本地资源安全加载，严格防御目录穿越（`../`）；外链点击通过系统默认浏览器安全打开；无任何联网遥测或外部依赖。
- **系统级体验**：支持拖拽打开、未启动/运行中通过 Finder“打开方式”打开、关闭窗口后 Dock 重新唤起、外部程序保存文件自动热重载并智能保持阅读滚动位置。

---

## 📦 最终交付成品

在 `dist/` 目录下提供经过针对性测试与多轮严苛验证的原生构建产物：

| 文件名称 | 格式与架构 | 体积 | 说明 |
| :--- | :--- | :--- | :--- |
| **`dist/MoRead.app`** | macOS 原生 App (`arm64`) | **3.1 MB** | Swift 6 + AppKit 原生应用程序包 |
| **`dist/MoRead-1.0.1-arm64.dmg`** | APFS 磁盘映像安装包 | **1.6 MB** | 极轻量原生安装包（含 Applications 拖拽安装快捷方式） |
| **`dist/MoRead-1.0.1-arm64.zip`** | ZIP 便携压缩包 | **1.3 MB** | 保留 Unix 权限与软链接的备用发布包 |
| **`dist/SHA256SUMS.txt`** | 校验和清单 | 178 B | 记录 DMG 与 ZIP 文件的 SHA-256 签名 |

---

## 🚀 安装与使用指南

### 1. 本机直接使用（推荐）
双击打开 `dist/MoRead-1.0.1-arm64.dmg`，将 **MoRead** 图标直接拖拽至窗口右侧的 **Applications** 目录即可。

### 2. 权限与代码签名说明
本应用采用 macOS 本地 ad-hoc 代码签名（`codesign -s -`），已在本机（macOS 27.0 Apple M3 arm64）上完成全链路安装与独立冷启动验证。
若在其他 Mac 设备上下载或解压使用时提示“无法打开，因为无法验证开发者”，请使用 macOS 官方推荐的方式解除下载隔离属性：
```bash
xattr -cr /Applications/MoRead.app
```
*(注：本应用绝不要求用户关闭 SIP 或全局绕过 Gatekeeper)*

### 3. 设置与缓存目录
应用所有用户偏好设置（主题、字号、窗口位置、最近打开列表）完全存储在系统专用目录，绝不污染用户文档目录：
- **配置文件路径**：`~/Library/Application Support/moread/moread-config.json`
- **重置设置方式**：在应用菜单中选择 **墨读 MoRead -> 清除所有配置与缓存**。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| **`Cmd + O`** | 打开 Markdown 文件 |
| **`Cmd + Shift + O`** | 打开包含 Markdown 的文件夹（在侧边栏以树形结构浏览） |
| **`Cmd + F`** | 唤起文内全文搜索框（`Enter` 下一处，`Shift+Enter` 上一处，`Esc` 退出） |
| **`Cmd + Shift + S`** | 切换只读源码模式与排版视图 |
| **`Cmd + R`** | 重新载入当前文档（保持当前阅读滚动百分比） |
| **`Cmd + +` / `Cmd + -`** | 放大 / 缩小阅读正文字号 |
| **`Cmd + 0`** | 恢复默认正文字号 (16px) |
| **`Cmd + W`** | 关闭当前窗口 |
| **`Cmd + Q`** | 退出 墨读 MoRead |

---

## 🛠️ 从源码重新构建与全量测试

如需自行基于源码重建与验证：

### 1. 构建依赖要求
- macOS 14.0+ (当前系统已验证: macOS 27.0.0 on Apple Silicon M3)
- Swift 6.0+
- Node.js >= 20.0.0, npm >= 10.0.0

### 2. 编译与打包命令
```bash
# 执行一键原生构建（自动构建前端静态资源 + 编译 Swift 原生二进制 + 封装 .app / .dmg / .zip）
./build-native.sh
```

### 3. 运行完整自动化测试套件
```bash
# 运行前端解析与安全单元测试 (CommonMark, MathJax 3 渲染, DOMPurify 防注入, 原生桥接通信)
npm test

# 运行 macOS 原生 Swift 测试套件 (文件监听, 原生设置持久化, SHA-256 绝对只读不变性)
npm run test:native
```

---

## 📄 开源许可证与致谢

墨读 MoRead 遵循 MIT 开源许可协议。本项目离线打包并集成了以下优秀开源库：
- **MathJax 3** (The MathJax Consortium, Apache-2.0 License)
- **markdown-it** (Vitaly Puzrin, Alex Kocharin, MIT License)
- **highlight.js** (Ivan Sagalaev, BSD-3-Clause License)
- **DOMPurify** (Cure53, Apache-2.0 / MPL-2.0)
