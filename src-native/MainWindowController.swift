import Foundation
import Cocoa
import WebKit
import UniformTypeIdentifiers

private final class DraggableTitlebarView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

private final class MarkdownWebView: WKWebView {
    var onMarkdownFilesDropped: (([String]) -> Void)?
    private(set) var lastMouseDownEvent: NSEvent?

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

    public init() {
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
        let width: CGFloat = 240
        let height: CGFloat = 52
        let dragRegion = DraggableTitlebarView(frame: .zero)
        dragRegion.translatesAutoresizingMaskIntoConstraints = false
        dragRegion.wantsLayer = true
        dragRegion.layer?.backgroundColor = NSColor.clear.cgColor
        dragRegion.setAccessibilityElement(false)
        contentView.addSubview(dragRegion, positioned: .above, relativeTo: webView)
        NSLayoutConstraint.activate([
            dragRegion.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            dragRegion.topAnchor.constraint(equalTo: contentView.topAnchor),
            dragRegion.widthAnchor.constraint(equalToConstant: width),
            dragRegion.heightAnchor.constraint(equalToConstant: height)
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
                    self?.nativeBridge.authorizeDirectory(url.path)
                    self?.nativeBridge.notifyOpenFolder(url.path)
                }
            }
        }
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

    // MARK: - WKNavigationDelegate
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isWebContentLoaded = true
        flushPendingOpenFilesIfReady()
    }

    private func flushPendingOpenFilesIfReady() {
        guard isWebContentLoaded && isRendererReady && !pendingOpenFilePaths.isEmpty else { return }
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
