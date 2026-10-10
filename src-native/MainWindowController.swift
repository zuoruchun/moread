import Foundation
import Cocoa
import WebKit
import UniformTypeIdentifiers

private final class DraggableTitlebarView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

private final class MarkdownWebView: WKWebView {
    var onMarkdownFilesDropped: (([String]) -> Void)?
    private(set) var lastMouseDownEvent: NSEvent?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        lastMouseDownEvent = event
        super.mouseDown(with: event)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        markdownPaths(from: sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let paths = markdownPaths(from: sender)
        guard !paths.isEmpty else { return false }
        onMarkdownFilesDropped?(paths)
        return true
    }

    private func markdownPaths(from sender: any NSDraggingInfo) -> [String] {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] else {
            return []
        }
        return urls.compactMap { url in
            let standardized = url.standardizedFileURL
            let ext = standardized.pathExtension.lowercased()
            guard ext == "md" || ext == "markdown" else { return nil }
            return standardized.path
        }
    }
}

public final class MainWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate, @unchecked Sendable {
    public private(set) var webView: WKWebView!
    public let nativeBridge = NativeBridge()
    private let localFileSchemeHandler = LocalFileSchemeHandler()
    private var isWebContentLoaded = false
    private var isRendererReady = false
    private var pendingOpenFilePaths: [String] = []
    public private(set) var currentFolderPath: String?

    public init(initialFolderPath: String? = nil) {
        self.currentFolderPath = initialFolderPath
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "墨读 MoRead"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 500, height: 400)

        super.init(window: window)
        window.delegate = self
        restoreWindowFrame()

        if let initialFolderPath = initialFolderPath {
            nativeBridge.authorizeDirectory(initialFolderPath)
        }

        setupWebView()
        setupDragAndDrop()
        setupTitlebarDragRegion()
        loadWebContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupWebView() {
        nativeBridge.windowController = self

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(nativeBridge, name: "nativeAPI")
        config.userContentController = controller
        config.setURLSchemeHandler(localFileSchemeHandler, forURLScheme: "mored")
        // Vite emits an ES module bundle. WKWebView requires file-to-file access
        // for module imports and styles when the app shell is loaded with file://.
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        if ProcessInfo.processInfo.environment["MOREAD_DEVELOPER_TOOLS"] == "1" {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }

        let markdownWebView = MarkdownWebView(frame: window!.contentView!.bounds, configuration: config)
        markdownWebView.onMarkdownFilesDropped = { [weak self] paths in
            self?.openFiles(paths)
        }
        webView = markdownWebView
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // Transparent native background

        window!.contentView!.addSubview(webView)
    }

    private func setupDragAndDrop() {
        webView.registerForDraggedTypes([.fileURL])
    }

    private func setupTitlebarDragRegion() {
        guard let contentView = window?.contentView else { return }
        let dragRegion = DraggableTitlebarView(frame: .zero)
        dragRegion.translatesAutoresizingMaskIntoConstraints = false
        dragRegion.wantsLayer = true
        dragRegion.layer?.backgroundColor = NSColor.clear.cgColor
        dragRegion.setAccessibilityElement(false)
        contentView.addSubview(dragRegion, positioned: .above, relativeTo: webView)
        // Reserve 200 points at either edge for native controls and web toolbar buttons.
        let preferredWidth = dragRegion.widthAnchor.constraint(equalToConstant: 240)
        preferredWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            dragRegion.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            dragRegion.topAnchor.constraint(equalTo: contentView.topAnchor),
            dragRegion.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, constant: -400),
            preferredWidth,
            dragRegion.heightAnchor.constraint(equalToConstant: 52)
        ])
    }

    private func loadWebContent() {
        // Look for web assets inside App Bundle Resources/web
        if let resourceURL = Bundle.main.resourceURL {
            let webIndex = resourceURL.appendingPathComponent("web/index.html")
            if FileManager.default.fileExists(atPath: webIndex.path) {
                webView.loadFileURL(webIndex, allowingReadAccessTo: resourceURL)
                return
            }
        }

        // Fallback for local development or direct swiftc run
        let cwd = FileManager.default.currentDirectoryPath
        let localDist = URL(fileURLWithPath: cwd).appendingPathComponent("dist-renderer/index.html")
        if FileManager.default.fileExists(atPath: localDist.path) {
            let parentDir = URL(fileURLWithPath: cwd).appendingPathComponent("dist-renderer")
            webView.loadFileURL(localDist, allowingReadAccessTo: parentDir)
            return
        }

        NSLog("Warning: Could not locate index.html in bundle or dist-renderer")
    }

    public func presentWindow() {
        showWindow(nil)
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func openFile(_ filePath: String) {
        openFiles([filePath])
    }

    public func openFiles(_ filePaths: [String]) {
        guard !filePaths.isEmpty else { return }
        presentWindow()
        for filePath in filePaths {
            nativeBridge.authorizeFile(filePath)
            localFileSchemeHandler.allowDocument(at: filePath)
            window?.title = URL(fileURLWithPath: filePath).lastPathComponent
            if isWebContentLoaded && isRendererReady {
                nativeBridge.notifyOpenFile(filePath)
            } else if !pendingOpenFilePaths.contains(filePath) {
                pendingOpenFilePaths.append(filePath)
            }
        }
    }

    public func rendererDidBecomeReady() {
        isRendererReady = true
        flushPendingOpenFilesIfReady()
    }

    public func allowLocalResources(forDocument filePath: String) {
        localFileSchemeHandler.allowDocument(at: filePath)
    }

    public func beginWindowDrag() {
        guard let event = (webView as? MarkdownWebView)?.lastMouseDownEvent else { return }
        window?.performDrag(with: event)
    }

    public func showOpenFileDialog() {
        let panel = NSOpenPanel()
        panel.title = "选择 Markdown 文件"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [
            UTType(filenameExtension: "md") ?? .plainText,
            UTType(filenameExtension: "markdown") ?? .plainText,
            .plainText
        ]
        if let window = self.window {
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let url = panel.url {
                    self?.openFile(url.path)
                }
            }
        }
    }

    public func showOpenFolderDialog() {
        let panel = NSOpenPanel()
        panel.title = "选择包含 Markdown 的文件夹"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if let window = self.window {
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let url = panel.url {
                    self?.currentFolderPath = url.path
                    self?.nativeBridge.authorizeDirectory(url.path)
                    self?.nativeBridge.notifyOpenFolder(url.path)
                }
            }
        }
    }

    private var pdfExporter: PDFExporter?
    private var pdfExportInProgress = false

    public func exportPDF(completion: (([String: Any]) -> Void)? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else {
                completion?(["success": false, "error": "窗口已关闭"])
                return
            }
            guard !self.pdfExportInProgress else {
                completion?(["success": false, "error": "已有 PDF 导出正在进行"])
                return
            }
            self.pdfExportInProgress = true
            // Capture once before the save panel: tab switches or later edits cannot change this export.
            self.webView.evaluateJavaScript("window.moreadApp?.prepareForPDFExport() ?? null") { [weak self] value, error in
                guard let self else { completion?(["success": false, "error": "窗口已关闭"]); return }
                guard error == nil, let snapshot = value as? [String: Any], let html = snapshot["html"] as? String else {
                    self.pdfExportInProgress = false
                    let message = error?.localizedDescription ?? "请先打开需要导出的 Markdown 文档"
                    completion?(["success": false, "error": message])
                    self.showPDFError(message)
                    return
                }
                let panel = NSSavePanel()
                panel.title = "导出为 PDF（A4 自动分页）"
                panel.allowedContentTypes = [UTType.pdf]
                panel.canCreateDirectories = true
                let title = ((snapshot["title"] as? String ?? "未命名") as NSString).lastPathComponent
                panel.nameFieldStringValue = "\((title as NSString).deletingPathExtension).pdf"
                panel.beginSheetModal(for: window) { [weak self] response in
                    guard let self else { completion?(["success": false, "error": "窗口已关闭"]); return }
                    guard response == .OK, let url = panel.url else {
                        self.pdfExportInProgress = false
                        completion?(["success": false, "cancelled": true])
                        return
                    }
                    let exporter = PDFExporter()
                    self.pdfExporter = exporter
                    exporter.export(html: html, filePath: snapshot["filePath"] as? String, to: url) { [weak self] result in
                        self?.pdfExporter = nil
                        self?.pdfExportInProgress = false
                        switch result {
                        case .success: completion?(["success": true])
                        case .failure(let error):
                            completion?(["success": false, "error": error.localizedDescription])
                            self?.showPDFError(error.localizedDescription)
                        }
                    }
                }
            }
        }
    }

    private func showPDFError(_ message: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "无法导出 PDF"
        alert.informativeText = message
        alert.beginSheetModal(for: window)
    }

    public func zoomIn() {
        webView.pageZoom += 0.1
    }

    public func zoomOut() {
        webView.pageZoom = max(0.5, webView.pageZoom - 0.1)
    }

    public func zoomActual() {
        webView.pageZoom = 1.0
    }

    public func saveDocument() {
        nativeBridge.notifyMenuAction("save")
    }

    public func toggleSourceMode() {
        nativeBridge.notifyMenuAction("toggle-source")
    }

    public func forceCloseWindow() {
        window?.isDocumentEdited = false
        window?.close()
    }

    // MARK: - NSWindowDelegate
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender.isDocumentEdited {
            nativeBridge.notifyMenuAction("request-close")
            return false
        }
        return true
    }

    // MARK: - WKNavigationDelegate
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isWebContentLoaded = true
        flushPendingOpenFilesIfReady()
    }

    private func flushPendingOpenFilesIfReady() {
        guard isWebContentLoaded && isRendererReady else { return }
        if let folder = currentFolderPath {
            nativeBridge.notifyOpenFolder(folder)
        }
        guard !pendingOpenFilePaths.isEmpty else { return }
        let pending = pendingOpenFilePaths
        pendingOpenFilePaths.removeAll()
        pending.forEach(nativeBridge.notifyOpenFile)
    }

    public func windowDidMove(_ notification: Notification) {
        saveWindowFrame()
    }

    public func windowDidResize(_ notification: Notification) {
        saveWindowFrame()
    }

    public func windowWillClose(_ notification: Notification) {
        saveWindowFrame()
        if let appDelegate = NSApp.delegate as? AppDelegate {
            appDelegate.removeWindowController(self)
        }
    }

    private func restoreWindowFrame() {
        guard let window else { return }
        let settings = SettingsManager.shared.getSettings()
        guard let bounds = settings["windowBounds"] as? [String: Any],
              let x = number(bounds["x"]),
              let y = number(bounds["y"]),
              let width = number(bounds["width"]),
              let height = number(bounds["height"]),
              width >= window.minSize.width,
              height >= window.minSize.height else {
            window.center()
            return
        }

        let restoredFrame = NSRect(x: x, y: y, width: width, height: height)
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(restoredFrame) }) {
            window.setFrame(restoredFrame, display: false)
        } else {
            window.center()
        }
    }

    private func saveWindowFrame() {
        guard let frame = window?.frame else { return }
        SettingsManager.shared.saveSettings([
            "windowBounds": [
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.size.width,
                "height": frame.size.height
            ]
        ])
    }

    private func number(_ value: Any?) -> CGFloat? {
        if let number = value as? NSNumber { return CGFloat(number.doubleValue) }
        if let value = value as? Double { return CGFloat(value) }
        return nil
    }
}
