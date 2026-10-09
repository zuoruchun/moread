import Cocoa

public final class AppDelegate: NSObject, NSApplicationDelegate {
    public var windowControllers: [MainWindowController] = []
    public var activeWindowController: MainWindowController? {
        windowControllers.first(where: { $0.window?.isKeyWindow == true }) ?? windowControllers.last
    }
    public var mainWindowController: MainWindowController? {
        activeWindowController
    }
    private var pendingOpenFilePaths: [String] = []
    private var hasFinishedLaunching = false

    public func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        hasFinishedLaunching = true

        let controller = activeWindowController ?? createWindow()
        controller.presentWindow()

        // Check command-line arguments for file paths to open
        let commandLineFiles = CommandLine.arguments.dropFirst().compactMap(normalizedMarkdownPath)
        let filesToOpen = deduplicated(pendingOpenFilePaths + commandLineFiles)
        pendingOpenFilePaths.removeAll()
        if !filesToOpen.isEmpty {
            controller.openFiles(filesToOpen)
        }
    }

    public func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        guard let path = normalizedMarkdownPath(filename) else { return false }
        openFiles([path])
        return true
    }

    public func application(_ sender: NSApplication, openFiles filenames: [String]) {
        let paths = filenames.compactMap(normalizedMarkdownPath)
        openFiles(paths)
        sender.reply(toOpenOrPrint: paths.isEmpty ? .failure : .success)
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A hidden/minimized window is still a usable document window.
        let controller = activeWindowController ?? createWindow()
        controller.presentWindow()
        return true
    }

    public func removeWindowController(_ controller: MainWindowController) {
        windowControllers.removeAll(where: { $0 === controller })
    }

    private func openFiles(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        guard hasFinishedLaunching else {
            pendingOpenFilePaths = deduplicated(pendingOpenFilePaths + paths)
            return
        }
        let controller = activeWindowController ?? createWindow()
        controller.presentWindow()
        controller.openFiles(paths)
    }

    private func createWindow(initialFolderPath: String? = nil) -> MainWindowController {
        let controller = MainWindowController(initialFolderPath: initialFolderPath)
        windowControllers.append(controller)
        return controller
    }

    private func normalizedMarkdownPath(_ rawPath: String) -> String? {
        guard !rawPath.hasPrefix("-") else { return nil }
        let expanded = NSString(string: rawPath).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded).standardizedFileURL
        let ext = url.pathExtension.lowercased()
        guard ext == "md" || ext == "markdown" else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return nil
        }
        return url.path
    }

    private func deduplicated(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }

    // MARK: - Menu Setup
    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // 1. App Menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 墨读 MoRead", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        let settingsItem = NSMenuItem(title: "设置...", action: #selector(menuSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 墨读", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 墨读", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 2. File Menu
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")

        let newWindowItem = NSMenuItem(title: "新建窗口", action: #selector(menuNewWindow), keyEquivalent: "n")
        newWindowItem.target = self
        fileMenu.addItem(newWindowItem)

        let newTabItem = NSMenuItem(title: "新建标签页", action: #selector(menuNewTab), keyEquivalent: "t")
        newTabItem.target = self
        fileMenu.addItem(newTabItem)

        fileMenu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "打开 Markdown 文件...", action: #selector(menuOpenFile), keyEquivalent: "o")
        openItem.target = self
        fileMenu.addItem(openItem)

        let openFolderItem = NSMenuItem(title: "打开文件夹...", action: #selector(menuOpenFolder), keyEquivalent: "O")
        openFolderItem.keyEquivalentModifierMask = [.command, .shift]
        openFolderItem.target = self
        fileMenu.addItem(openFolderItem)

        fileMenu.addItem(NSMenuItem.separator())
        let saveItem = NSMenuItem(title: "存储", action: #selector(menuSaveFile), keyEquivalent: "s")
        saveItem.target = self
        fileMenu.addItem(saveItem)

        let saveAsItem = NSMenuItem(title: "另存为...", action: #selector(menuSaveAs), keyEquivalent: "S")
        saveAsItem.keyEquivalentModifierMask = [.command, .option, .shift]
        saveAsItem.target = self
        fileMenu.addItem(saveAsItem)

        let saveCopyItem = NSMenuItem(title: "存储副本...", action: #selector(menuSaveCopy), keyEquivalent: "")
        saveCopyItem.target = self
        fileMenu.addItem(saveCopyItem)

        fileMenu.addItem(NSMenuItem.separator())
        let exportPDFItem = NSMenuItem(title: "导出为 PDF...", action: #selector(menuExportPDF), keyEquivalent: "p")
        exportPDFItem.keyEquivalentModifierMask = [.command, .option]
        exportPDFItem.target = self
        fileMenu.addItem(exportPDFItem)

        fileMenu.addItem(NSMenuItem.separator())
        let closeItem = NSMenuItem(title: "关闭标签页", action: #selector(menuCloseTab), keyEquivalent: "w")
        closeItem.target = self
        fileMenu.addItem(closeItem)

        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // 3. Edit Menu
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())

        let toggleEditItem = NSMenuItem(title: "切换编辑 / 阅读模式", action: #selector(menuToggleEdit), keyEquivalent: "e")
        toggleEditItem.target = self
        editMenu.addItem(toggleEditItem)

        let findItem = NSMenuItem(title: "在文档中搜索...", action: #selector(menuSearch), keyEquivalent: "f")
        findItem.target = self
        editMenu.addItem(findItem)
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // 4. View Menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "视图")

        let toggleOutlineItem = NSMenuItem(title: "切换文档大纲", action: #selector(menuToggleOutline), keyEquivalent: "j")
        toggleOutlineItem.target = self
        viewMenu.addItem(toggleOutlineItem)

        let toggleSidebarItem = NSMenuItem(title: "切换侧边栏", action: #selector(menuToggleSidebar), keyEquivalent: "b")
        toggleSidebarItem.target = self
        viewMenu.addItem(toggleSidebarItem)

        let toggleSourceItem = NSMenuItem(title: "切换源码 / 渲染", action: #selector(menuToggleSource), keyEquivalent: "S")
        toggleSourceItem.keyEquivalentModifierMask = [.command, .shift]
        toggleSourceItem.target = self
        viewMenu.addItem(toggleSourceItem)

        viewMenu.addItem(NSMenuItem.separator())

        let zoomInItem = NSMenuItem(title: "放大", action: #selector(menuZoomIn), keyEquivalent: "=")
        zoomInItem.target = self
        viewMenu.addItem(zoomInItem)

        let zoomOutItem = NSMenuItem(title: "缩小", action: #selector(menuZoomOut), keyEquivalent: "-")
        zoomOutItem.target = self
        viewMenu.addItem(zoomOutItem)

        let zoomActualItem = NSMenuItem(title: "实际大小", action: #selector(menuZoomActual), keyEquivalent: "0")
        zoomActualItem.target = self
        viewMenu.addItem(zoomActualItem)

        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 5. Window Menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Actions
    @objc public func menuNewWindow() {
        let currentFolder = activeWindowController?.currentFolderPath
        let controller = createWindow(initialFolderPath: currentFolder)
        controller.presentWindow()
    }

    @objc private func menuNewTab() {
        activeWindowController?.nativeBridge.notifyMenuAction("new-tab")
    }

    @objc private func menuCloseTab() {
        activeWindowController?.nativeBridge.notifyMenuAction("close-tab")
    }

    @objc private func menuSettings() {
        activeWindowController?.nativeBridge.notifyMenuAction("settings")
    }

    @objc private func menuOpenFile() {
        activeWindowController?.showOpenFileDialog()
    }

    @objc private func menuOpenFolder() {
        activeWindowController?.showOpenFolderDialog()
    }

    @objc private func menuSaveFile() {
        activeWindowController?.saveDocument()
    }

    @objc private func menuSaveAs() {
        activeWindowController?.nativeBridge.notifyMenuAction("save-as")
    }

    @objc private func menuSaveCopy() {
        activeWindowController?.nativeBridge.notifyMenuAction("save-copy")
    }

    @objc private func menuExportPDF() {
        activeWindowController?.exportPDF()
    }

    @objc private func menuToggleEdit() {
        activeWindowController?.nativeBridge.notifyMenuAction("toggle-edit")
    }

    @objc private func menuSearch() {
        activeWindowController?.nativeBridge.notifyMenuAction("find")
    }

    @objc private func menuToggleOutline() {
        activeWindowController?.nativeBridge.notifyMenuAction("toggle-outline")
    }

    @objc private func menuToggleSidebar() {
        activeWindowController?.nativeBridge.notifyMenuAction("toggle-sidebar")
    }

    @objc private func menuToggleSource() {
        activeWindowController?.nativeBridge.notifyMenuAction("toggle-source")
    }

    @objc private func menuZoomIn() {
        activeWindowController?.zoomIn()
    }

    @objc private func menuZoomOut() {
        activeWindowController?.zoomOut()
    }

    @objc private func menuZoomActual() {
        activeWindowController?.zoomActual()
    }
}
