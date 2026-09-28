import Foundation
import Cocoa
import WebKit
import UniformTypeIdentifiers

public final class MainWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate, @unchecked Sendable {
    public private(set) var webView: WKWebView!
    public let nativeBridge = NativeBridge()
    private var isWebReady = false
    private var pendingOpenFilePath: String?

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
        window.center()

        super.init(window: window)
        window.delegate = self

        setupWebView()
        setupDragAndDrop()
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

        // Allow developer tools and local file access
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

        webView = WKWebView(frame: window!.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // Transparent native background

        window!.contentView!.addSubview(webView)
    }

    private func setupDragAndDrop() {
        window?.registerForDraggedTypes([.fileURL])
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

    public func openFile(_ filePath: String) {
        if isWebReady {
            nativeBridge.notifyOpenFile(filePath)
        } else {
            pendingOpenFilePath = filePath
        }
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
        isWebReady = true
        if let path = pendingOpenFilePath {
            pendingOpenFilePath = nil
            // Small dispatch to guarantee DOM is interactive
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.nativeBridge.notifyOpenFile(path)
            }
        }
    }

    // MARK: - Window Delegate & Drag/Drop
    public func window(_ window: NSWindow, willEncodeRestorableState state: NSCoder) {
        // Clean state
    }
}
