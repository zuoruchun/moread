# 墨读 MoRead

macOS Markdown 查看器，支持少量编辑、数学公式、代码高亮、大纲、文件列表和多标签页。

当前源码版本：**1.5.7**。[已发布版本与说明](https://github.com/zuoruchun/moread/releases)

## 安装

适用于 Apple Silicon，需 macOS 14 或更新版本。

从 [Releases](https://github.com/zuoruchun/moread/releases/latest) 下载 DMG，打开后将 MoRead 拖入“应用程序”。也提供 ZIP 和 SHA-256 校验文件。应用采用临时签名，未经过 Apple 公证。

### 首次打开报错 / 无法打开的解决方法

若 macOS 弹出提示“无法打开‘MoRead.app’，因为无法验证开发者”或“‘MoRead.app’已损坏，无法打开”，任选以下一种方法即可解决：

- **方法一（系统设置中同意）**：
  打开 macOS **「系统设置」→「隐私与安全性」**，向下滚动到“安全性”区域，在提示“已阻止使用 MoRead...”旁边点击**「仍要打开」**（或按提示点击“打开”并输入开机密码确认）。

- **方法二（终端一行命令）**：
  打开「终端」（Terminal），输入以下命令并回车：
  ```bash
  xattr -cr /Applications/MoRead.app
  ```
  *(若应用不在“应用程序”文件夹，请将路径替换为实际解压或存放的位置)*

## 使用

- 默认以阅读模式打开 Markdown；`Cmd+E` 切换编辑，`Cmd+S` 保存。
- `Cmd+Shift+S` 切换源码与渲染，`Cmd+F` 搜索，`Cmd+B` 切换侧边栏。
- `Cmd+T` 新建标签页，`Cmd+N` 新建窗口。
- 编辑模式中点击公式可直接修改；查找栏中黄色标出所有匹配，橙色标出当前项。替换仅在编辑模式可用，留空表示删除；公式 LaTeX 请在源码视图查找替换。
- “文件”菜单提供另存为、保存副本和 PDF 导出。
- “墨读 MoRead → 设置…”中调整主题、字号、阅读宽度及自动／手动保存。

## 许可

MIT。
