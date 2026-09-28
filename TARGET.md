# 墨读 MoRead - 项目目标与架构升级控制 (TARGET)

## 一、定位与范围
- **目标产物**：交付 Typora 同款原生架构的 macOS 桌面 Markdown 阅读应用（`MoRead.app` / `MoRead-1.0.0-arm64.dmg` / `MoRead-1.0.0-arm64.zip` / `SHA256SUMS.txt`）。
- **架构升级**：由通用 Electron 架构迁移为 **macOS 原生 Swift/AppKit + WKWebView** 架构（对齐 Mac 版 Typora）。
- **核心收益**：
  - 应用体积从 106MB 骤降至 **~5MB - 12MB**；
  - 内存占用从 ~160MB 骤降至 **~40MB - 60MB**；
  - 启动速度进入百毫秒级秒开，获得系统级 120Hz ProMotion 与 Metal 原生贴手回弹手感。
- **边界**：严格只读，不做富文本编辑系统，不做云同步/插件市场/AI/遥测。

## 二、新架构技术选型依据（< 10 行）
1. **原生框架**：采用 Swift 6 + macOS AppKit 构建原生窗口、状态栏、菜单栏与生命周期，零第三方运行时依赖。
2. **系统内核**：内嵌 macOS 系统级 WebKit (`WKWebView`)，共享系统 dyld 缓存与 Metal GPU 合成器，杜绝 Chromium 庞大臃肿。
3. **渲染核心**：复用高度优化的离线静态资源（`markdown-it` + MathJax 3 矢量 SVG + `highlight.js` + `DOMPurify`），静态包仅 2.8MB。
4. **安全桥接**：基于 `WKScriptMessageHandler` 实现严格参数校验与白名单 IPC，严格拦截跨目录穿越与系统外链。
5. **测试与质量**：多层针对性验证（Swift 单元/集成测试、真实 AppKit GUI 驱动、系统级内存与冷启动实测、五轮严密测试）。

## 三、阶段任务与当前状态
- [x] 阶段 1：架构升级论证与体积/流畅度技术对比完成
- [x] 阶段 2：Swift/AppKit 原生工程搭建与纵向原型（窗口 + WKWebView 桥接 + 静态资源加载）
- [x] 阶段 3：原生双向 IPC 桥接与核心功能补齐（文件对话框、只读打开、监听热重载、目录树、设置持久化）
- [x] 阶段 4：针对性测试套件构建（异常输入、特殊路径、XSS/沙箱安全、只读哈希比对、内存与启动测量）
- [x] 阶段 5：执行多轮严苛针对性测试与缺陷排查修复（BUGLOG.md & QA_REPORT.md，BUG-006 彻底闭环）
- [x] 阶段 6：轻量化 DMG/ZIP 打包与独立沙箱验收交付（DMG 1.4MB，ZIP 1.1MB，SHA-256 清单完成）

**当前状态**：全流程交付完成 (Completed & Production Ready)。
**最终交付物**：
- `dist/MoRead.app` (3.1MB 原生 App 捆绑包)
- `dist/MoRead-1.0.0-arm64.dmg` (1.4MB 极轻量安装镜像)
- `dist/MoRead-1.0.0-arm64.zip` (1.1MB 便携压缩包)
- `dist/SHA256SUMS.txt` (校验清单)
