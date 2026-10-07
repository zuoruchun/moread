import Foundation
import WebKit
import Cocoa
import UniformTypeIdentifiers
import CryptoKit

public final class NativeBridge: NSObject, WKScriptMessageHandler, @unchecked Sendable {
    public weak var windowController: MainWindowController?
    private var fileWatcher: FileWatcher?
    private let authorizationLock = NSLock()
    private let writeLock = NSLock()
    private var authorizedDirectories = Set<String>()

    public override init() {
        super.init()
        self.fileWatcher = FileWatcher { [weak self] changedPath in
            self?.notifyFileChanged(changedPath)
        }
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let action = body["action"] as? String else {
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]

        // Dispatch background tasks off the main thread, except UI dialogs
        switch action {
        case "app:renderer-ready":
            windowController?.rendererDidBecomeReady()
            sendResponse(id: id, result: ["success": true])
        case "window:begin-drag":
            windowController?.beginWindowDrag()
            sendResponse(id: id, result: ["success": true])
        case "window:new-window":
            handleNewWindow(id: id)
        case "dialog:open-file":
            handleOpenFile(id: id)
        case "dialog:open-folder":
            handleOpenFolder(id: id)
        case "dialog:save-as":
            handleSaveAsDialog(id: id, payload: payload)
        case "dialog:save-copy":
            handleSaveCopyDialog(id: id, payload: payload)
        case "export:pdf":
            handleExportPDF(id: id)
        case "drafts:save":
            handleSaveDraft(id: id, payload: payload)
        case "drafts:get-all":
            handleGetAllDrafts(id: id)
        case "drafts:delete":
            handleDeleteDraft(id: id, payload: payload)
        case "drafts:clear-all":
            handleClearAllDrafts(id: id)
        case "fs:read-file":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleReadFile(id: id, payload: payload)
            }
        case "fs:write-file":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleWriteFile(id: id, payload: payload)
            }
        case "fs:check-conflict":
            handleCheckConflict(id: id, payload: payload)
        case "window:set-edited":
            handleSetWindowEdited(id: id, payload: payload)
        case "dialog:confirm-save":
            handleConfirmSaveDialog(id: id, payload: payload)
        case "fs:read-folder":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleReadFolder(id: id, payload: payload)
            }
        case "fs:show-in-folder":
            handleShowInFolder(id: id, payload: payload)
        case "shell:open-external":
            handleOpenExternal(id: id, payload: payload)
        case "store:get-settings":
            handleGetSettings(id: id)
        case "store:save-settings":
            handleSaveSettings(id: id, payload: payload)
        case "window:close":
            DispatchQueue.main.async { [weak self] in
                self?.windowController?.forceCloseWindow()
            }
            sendResponse(id: id, result: ["success": true])
        case "store:clear-all":
            handleClearAll(id: id)
        default:
            sendResponse(id: id, result: nil, error: "未知的操作指令: \(action)")
        }
    }

    // MARK: - Dialog Handlers
    private func handleOpenFile(id: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.windowController?.window else { return }
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

            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url {
                    self.authorizeFile(url.path)
                    self.sendResponse(id: id, result: ["canceled": false, "filePath": url.path])
                } else {
                    self.sendResponse(id: id, result: ["canceled": true])
                }
            }
        }
    }

    private func handleOpenFolder(id: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.windowController?.window else { return }
            let panel = NSOpenPanel()
            panel.title = "选择包含 Markdown 的文件夹"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false

            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url {
                    self.authorizeDirectory(url.path)
                    self.sendResponse(id: id, result: ["canceled": false, "folderPath": url.path])
                } else {
                    self.sendResponse(id: id, result: ["canceled": true])
                }
            }
        }
    }

    private func handleSaveAsDialog(id: String, payload: [String: Any]) {
        let currentPath = payload["currentPath"] as? String
        let content = payload["content"] as? String
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.windowController?.window else {
                self?.sendResponse(id: id, result: ["canceled": true])
                return
            }
            let panel = NSSavePanel()
            panel.title = "另存为 Markdown 文件"
            panel.allowedContentTypes = [
                UTType(filenameExtension: "md") ?? .plainText,
                UTType(filenameExtension: "markdown") ?? .plainText,
                .plainText
            ]
            panel.canCreateDirectories = true
            if let currentPath = currentPath, !currentPath.isEmpty {
                let url = URL(fileURLWithPath: currentPath)
                panel.directoryURL = url.deletingLastPathComponent()
                panel.nameFieldStringValue = url.lastPathComponent
            } else {
                panel.nameFieldStringValue = "未命名.md"
            }

            panel.beginSheetModal(for: window) { response in
                if response == .OK, let targetURL = panel.url {
                    self.authorizeFile(targetURL.path)
                    if let content = content, let data = content.data(using: .utf8) {
                        try? data.write(to: targetURL, options: .atomic)
                    }
                    self.fileWatcher?.watch(filePath: targetURL.path)
                    self.windowController?.allowLocalResources(forDocument: targetURL.path)
                    self.sendResponse(id: id, result: [
                        "canceled": false,
                        "filePath": targetURL.path
                    ])
                } else {
                    self.sendResponse(id: id, result: ["canceled": true])
                }
            }
        }
    }

    private func handleSaveCopyDialog(id: String, payload: [String: Any]) {
        let currentPath = payload["currentPath"] as? String
        guard let content = payload["content"] as? String else {
            sendResponse(id: id, result: ["canceled": true, "error": "缺少保存内容"])
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.windowController?.window else {
                self?.sendResponse(id: id, result: ["canceled": true])
                return
            }
            let panel = NSSavePanel()
            panel.title = "存储副本为"
            panel.allowedContentTypes = [
                UTType(filenameExtension: "md") ?? .plainText,
                UTType(filenameExtension: "markdown") ?? .plainText,
                .plainText
            ]
            panel.canCreateDirectories = true
            if let currentPath = currentPath, !currentPath.isEmpty {
                let url = URL(fileURLWithPath: currentPath)
                let baseName = url.deletingPathExtension().lastPathComponent
                panel.directoryURL = url.deletingLastPathComponent()
                panel.nameFieldStringValue = "\(baseName) 副本.md"
            } else {
                panel.nameFieldStringValue = "副本.md"
            }

            panel.beginSheetModal(for: window) { response in
                if response == .OK, let targetURL = panel.url {
                    self.authorizeFile(targetURL.path)
                    if let data = content.data(using: .utf8) {
                        do {
                            try data.write(to: targetURL, options: .atomic)
                            self.sendResponse(id: id, result: [
                                "canceled": false,
                                "filePath": targetURL.path,
                                "success": true
                            ])
                        } catch {
                            self.sendResponse(id: id, result: [
                                "canceled": false,
                                "success": false,
                                "error": "写入文件失败: \(error.localizedDescription)"
                            ])
                        }
                    }
                } else {
                    self.sendResponse(id: id, result: ["canceled": true])
                }
            }
        }
    }

    private func handleExportPDF(id: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.windowController else { return }
            host.exportPDF { [weak self] result in self?.sendResponse(id: id, result: result) }
        }
    }

    private var draftsDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let draftsDir = appSupport.appendingPathComponent("MoRead/Drafts", isDirectory: true)
        if !FileManager.default.fileExists(atPath: draftsDir.path) {
            try? FileManager.default.createDirectory(at: draftsDir, withIntermediateDirectories: true)
        }
        return draftsDir
    }

    private func handleSaveDraft(id: String, payload: [String: Any]) {
        guard let draftId = payload["id"] as? String, !draftId.isEmpty else {
            sendResponse(id: id, result: ["success": false, "error": "无效的草稿 ID"])
            return
        }
        let safeName = draftId.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let draftURL = draftsDirectory.appendingPathComponent("\(safeName).json")
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
            try? data.write(to: draftURL, options: .atomic)
            sendResponse(id: id, result: ["success": true])
        } else {
            sendResponse(id: id, result: ["success": false, "error": "草稿序列化失败"])
        }
    }

    private func handleGetAllDrafts(id: String) {
        let dir = draftsDirectory
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            sendResponse(id: id, result: ["drafts": []])
            return
        }
        var drafts: [[String: Any]] = []
        for file in files where file.pathExtension == "json" {
            if let data = try? Data(contentsOf: file),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                drafts.append(json)
            }
        }
        sendResponse(id: id, result: ["drafts": drafts])
    }

    private func handleDeleteDraft(id: String, payload: [String: Any]) {
        guard let draftId = payload["id"] as? String, !draftId.isEmpty else {
            sendResponse(id: id, result: ["success": false])
            return
        }
        let safeName = draftId.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let draftURL = draftsDirectory.appendingPathComponent("\(safeName).json")
        try? FileManager.default.removeItem(at: draftURL)
        sendResponse(id: id, result: ["success": true])
    }

    private func handleClearAllDrafts(id: String) {
        let dir = draftsDirectory
        if let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for file in files {
                try? FileManager.default.removeItem(at: file)
            }
        }
        sendResponse(id: id, result: ["success": true])
    }

    private func handleCheckConflict(id: String, payload: [String: Any]) {
        guard let filePath = payload["filePath"] as? String, !filePath.isEmpty,
              let baselineRevision = payload["baselineRevision"] as? String else {
            sendResponse(id: id, result: ["conflict": false])
            return
        }
        let url = URL(fileURLWithPath: NSString(string: filePath).expandingTildeInPath).standardizedFileURL
        guard let rawData = try? Data(contentsOf: url) else {
            sendResponse(id: id, result: ["conflict": true, "reason": "文件不存在或无法读取"])
            return
        }
        let currentRevision = SHA256.hash(data: rawData).map { String(format: "%02x", $0) }.joined()
        let conflict = currentRevision != baselineRevision
        sendResponse(id: id, result: [
            "conflict": conflict,
            "currentRevision": currentRevision
        ])
    }

    private func handleNewWindow(id: String) {
        DispatchQueue.main.async {
            #if !MOREAD_BRIDGE_INTEGRATION
            if let appDelegate = NSApp.delegate as? AppDelegate {
                appDelegate.menuNewWindow()
            }
            #endif
        }
        sendResponse(id: id, result: ["success": true])
    }

    // MARK: - File System Handlers (Strictly Read-Only)
    private func handleReadFile(id: String, payload: [String: Any]) {
        guard let filePath = payload["filePath"] as? String, !filePath.isEmpty else {
            sendResponse(id: id, result: ["success": false, "error": "无效的文件路径"])
            return
        }

        let expandedPath = NSString(string: filePath).expandingTildeInPath
        let url = URL(fileURLWithPath: expandedPath).standardizedFileURL
        let ext = url.pathExtension.lowercased()

        guard ext == "md" || ext == "markdown" else {
            sendResponse(id: id, result: ["success": false, "error": "仅支持读取 Markdown 文件"])
            return
        }

        guard isAuthorized(url.path) else {
            sendResponse(id: id, result: ["success": false, "error": "文件不在用户已授权的目录中"])
            return
        }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
            sendResponse(id: id, result: ["success": false, "error": "文件不存在: \(filePath)"])
            return
        }

        if isDir.boolValue {
            sendResponse(id: id, result: ["success": false, "error": "路径是一个目录，无法作为 Markdown 打开: \(filePath)"])
            return
        }

        // Strict size safety guard: reject files > 50MB
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        if fileSize > 50 * 1024 * 1024 {
            sendResponse(id: id, result: ["success": false, "error": "文件大小为 \(fileSize / (1024 * 1024))MB，超出 50MB 上限"])
            return
        }

        // Read strictly in read-only mode
        guard let rawData = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            sendResponse(id: id, result: ["success": false, "error": "无法读取文件数据: \(filePath)"])
            return
        }

        // Strip UTF-8 BOM if present (0xEF, 0xBB, 0xBF)
        var contentData = rawData
        let hasBOM = contentData.count >= 3 && contentData[0] == 0xEF && contentData[1] == 0xBB && contentData[2] == 0xBF
        if hasBOM {
            contentData = contentData.subdata(in: 3..<contentData.count)
        }

        // Decode as UTF-8 with fallback
        guard var content = String(data: contentData, encoding: .utf8) ??
                            String(data: contentData, encoding: .unicode) ??
                            String(data: contentData, encoding: .isoLatin1) else {
            sendResponse(id: id, result: ["success": false, "error": "文件不是有效的纯文本编码格式"])
            return
        }

        let hasCRLF = content.contains("\r\n")
        let lineEnding = hasCRLF ? "\r\n" : "\n"

        // Normalize CRLF -> LF
        content = content.replacingOccurrences(of: "\r\n", with: "\n")

        let isReadOnly = !FileManager.default.isWritableFile(atPath: url.path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let stats: [String: Any] = [
            "size": contentData.count,
            "mtime": mtime * 1000.0,
            "revision": SHA256.hash(data: rawData).map { String(format: "%02x", $0) }.joined(),
            "hasBOM": hasBOM,
            "lineEnding": lineEnding,
            "isReadOnly": isReadOnly
        ]

        // Start file watcher for live reload on modification
        DispatchQueue.main.async { [weak self] in
            self?.fileWatcher?.watch(filePath: url.path)
            self?.windowController?.allowLocalResources(forDocument: url.path)
        }

        sendResponse(id: id, result: [
            "success": true,
            "content": content,
            "stats": stats
        ])
    }

    private func handleWriteFile(id: String, payload: [String: Any]) {
        // Serialize app writes so a delayed save cannot overwrite a newer app revision.
        writeLock.lock()
        defer { writeLock.unlock() }
        guard let filePath = payload["filePath"] as? String, !filePath.isEmpty,
              let content = payload["content"] as? String else {
            sendResponse(id: id, result: ["success": false, "error": "无效的文件路径或内容"])
            return
        }

        let expandedPath = NSString(string: filePath).expandingTildeInPath
        let url = URL(fileURLWithPath: expandedPath).standardizedFileURL
        let ext = url.pathExtension.lowercased()

        guard ext == "md" || ext == "markdown" else {
            sendResponse(id: id, result: ["success": false, "error": "仅支持写入 Markdown 文件"])
            return
        }

        guard isAuthorized(url.path) else {
            sendResponse(id: id, result: ["success": false, "error": "文件不在用户已授权的目录中"])
            return
        }

        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
            sendResponse(id: id, result: ["success": false, "error": "目标路径是一个目录，无法写入"])
            return
        }

        let isReadOnly = !FileManager.default.isWritableFile(atPath: url.path)
        if FileManager.default.fileExists(atPath: url.path) && isReadOnly {
            sendResponse(id: id, result: ["success": false, "error": "文件在磁盘上为只读，无法直接写入。请使用“另存为”保存副本。"])
            return
        }

        var textToWrite = content
        let lineEnding = payload["lineEnding"] as? String ?? "\n"
        if lineEnding == "\r\n" {
            textToWrite = textToWrite.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r\n")
        }

        guard var data = textToWrite.data(using: .utf8) else {
            sendResponse(id: id, result: ["success": false, "error": "编码转换失败"])
            return
        }

        let hasBOM = payload["hasBOM"] as? Bool ?? false
        if hasBOM {
            var bomData = Data([0xEF, 0xBB, 0xBF])
            bomData.append(data)
            data = bomData
        }

        if let expectedRevision = payload["expectedRevision"] as? String {
            guard let currentData = try? Data(contentsOf: url),
                  SHA256.hash(data: currentData).map({ String(format: "%02x", $0) }).joined() == expectedRevision else {
                sendResponse(id: id, result: ["success": false, "error": "文件已在外部修改或无法读取，保存已停止；当前修改仍保留"])
                return
            }
        }

        // Suppress watcher before writing to prevent self-reload loop
        self.fileWatcher?.suppressNextChange(for: url.path, duration: 1.5)

        do {
            try data.write(to: url, options: .atomic)
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            sendResponse(id: id, result: [
                "success": true,
                "stats": [
                    "size": data.count,
                    "mtime": mtime * 1000.0,
                    "revision": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                ]
            ])
        } catch {
            sendResponse(id: id, result: ["success": false, "error": "写入文件失败: \(error.localizedDescription)"])
        }
    }

    private func handleSetWindowEdited(id: String, payload: [String: Any]) {
        let isEdited = payload["isEdited"] as? Bool ?? false
        DispatchQueue.main.async { [weak self] in
            self?.windowController?.window?.isDocumentEdited = isEdited
            self?.sendResponse(id: id, result: ["success": true])
        }
    }

    private func handleConfirmSaveDialog(id: String, payload: [String: Any]) {
        let fileName = payload["fileName"] as? String ?? "当前文档"
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.windowController?.window else {
                self?.sendResponse(id: id, result: ["action": "dont-save"])
                return
            }
            let alert = NSAlert()
            alert.messageText = "是否存储对文档“\(fileName)”所做的更改？"
            alert.informativeText = "如果不存储，您所做的更改将会丢失。"
            alert.addButton(withTitle: "存储")
            alert.addButton(withTitle: "取消")
            alert.addButton(withTitle: "不存储")
            alert.alertStyle = .warning

            alert.beginSheetModal(for: window) { response in
                switch response {
                case .alertFirstButtonReturn:
                    self.sendResponse(id: id, result: ["action": "save"])
                case .alertSecondButtonReturn:
                    self.sendResponse(id: id, result: ["action": "cancel"])
                default:
                    self.sendResponse(id: id, result: ["action": "dont-save"])
                }
            }
        }
    }

    private func handleReadFolder(id: String, payload: [String: Any]) {
        guard let folderPath = payload["folderPath"] as? String, !folderPath.isEmpty else {
            sendResponse(id: id, result: ["success": false, "error": "无效的文件夹路径"])
            return
        }

        let expandedPath = NSString(string: folderPath).expandingTildeInPath
        let url = URL(fileURLWithPath: expandedPath).standardizedFileURL

        guard isAuthorized(url.path) else {
            sendResponse(id: id, result: ["success": false, "error": "文件夹未获得用户授权"])
            return
        }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            sendResponse(id: id, result: ["success": false, "error": "指定的目录不存在"])
            return
        }

        let nodes = scanDirectory(url: url, depth: 0, maxDepth: 2)
        sendResponse(id: id, result: [
            "success": true,
            "nodes": nodes
        ])
    }

    private func scanDirectory(url: URL, depth: Int, maxDepth: Int) -> [[String: Any]] {
        guard depth < min(maxDepth, 2) else { return [] }

        let keys: [URLResourceKey] = [.isDirectoryKey, .nameKey]
        let options: FileManager.DirectoryEnumerationOptions = [.skipsHiddenFiles]

        guard let contents = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: options) else {
            return []
        }

        var dirNodes: [[String: Any]] = []
        var fileNodes: [[String: Any]] = []

        for item in contents {
            let name = item.lastPathComponent
            // Ignore system/dev folders
            if name == ".git" || name == "node_modules" || name == "dist" || name == ".DS_Store" || name == "dist-electron" || name == "dist-renderer" {
                continue
            }

            guard let res = try? item.resourceValues(forKeys: Set(keys)), let isDir = res.isDirectory else {
                continue
            }

            if isDir {
                let children = scanDirectory(url: item, depth: depth + 1, maxDepth: maxDepth)
                if !children.isEmpty {
                    dirNodes.append([
                        "name": name,
                        "path": item.path,
                        "isDirectory": true,
                        "children": children
                    ])
                }
            } else {
                let ext = item.pathExtension.lowercased()
                if ext == "md" || ext == "markdown" {
                    fileNodes.append([
                        "name": name,
                        "path": item.path,
                        "isDirectory": false
                    ])
                }
            }
        }

        dirNodes.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        fileNodes.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }

        return dirNodes + fileNodes
    }

    private func handleShowInFolder(id: String, payload: [String: Any]) {
        guard let filePath = payload["filePath"] as? String, !filePath.isEmpty else {
            sendResponse(id: id, result: ["success": false])
            return
        }
        let url = URL(fileURLWithPath: filePath)
        DispatchQueue.main.async {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
        sendResponse(id: id, result: ["success": true])
    }

    private func handleOpenExternal(id: String, payload: [String: Any]) {
        guard let urlString = payload["url"] as? String,
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            sendResponse(id: id, result: ["success": false, "error": "仅支持打开 HTTP/HTTPS 安全链接"])
            return
        }
        DispatchQueue.main.async {
            NSWorkspace.shared.open(url)
        }
        sendResponse(id: id, result: ["success": true])
    }

    // MARK: - Store Handlers
    private func handleGetSettings(id: String) {
        let settings = SettingsManager.shared.getSettings()
        if let recentFiles = settings["recentFiles"] as? [String] {
            recentFiles.forEach(authorizeFile)
        }
        sendResponse(id: id, result: settings)
    }

    private func handleSaveSettings(id: String, payload: [String: Any]) {
        SettingsManager.shared.saveSettings(payload)
        sendResponse(id: id, result: ["success": true])
    }

    private func handleClearAll(id: String) {
        SettingsManager.shared.clearAll()
        sendResponse(id: id, result: ["success": true])
    }

    // MARK: - Notifications and Responses to JS
    public func sendResponse(id: String, result: Any?, error: String? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.windowController?.webView else { return }

            let resultJson = toJsonString(result)
            let errorJson = toJsonString(error)
            let js = "window.handleNativeResponse(\(quoteJsString(id)), \(resultJson), \(errorJson));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    public func notifyOpenFile(_ filePath: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.windowController?.webView else { return }
            let js = "window.handleNativeEvent('app:open-file', \(quoteJsString(filePath)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    public func notifyOpenFolder(_ folderPath: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.windowController?.webView else { return }
            let js = "window.handleNativeEvent('app:open-folder', \(quoteJsString(folderPath)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    public func notifyFileChanged(_ filePath: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.windowController?.webView else { return }
            let js = "window.handleNativeEvent('file:changed', \(quoteJsString(filePath)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    public func notifyMenuAction(_ action: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.windowController?.webView else { return }
            let js = "window.handleNativeEvent('menu:action', \(quoteJsString(action)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    public func authorizeFile(_ filePath: String) {
        let directory = URL(fileURLWithPath: filePath).standardizedFileURL.deletingLastPathComponent().path
        authorizeDirectory(directory)
    }

    public func authorizeDirectory(_ directoryPath: String) {
        let directory = URL(fileURLWithPath: directoryPath).standardizedFileURL.path
        authorizationLock.lock()
        authorizedDirectories.insert(directory)
        authorizationLock.unlock()
    }

    private func isAuthorized(_ filePath: String) -> Bool {
        authorizationLock.lock()
        let directories = authorizedDirectories
        authorizationLock.unlock()
        return directories.contains { LocalFileAccessPolicy.isPath(filePath, inside: $0) }
    }
}

private func quoteJsString(_ str: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [str], options: []),
       let json = String(data: data, encoding: .utf8),
       json.hasPrefix("[") && json.hasSuffix("]") {
        return String(json.dropFirst().dropLast())
    }
    let escaped = str
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
    return "\"\(escaped)\""
}

private func toJsonString(_ obj: Any?) -> String {
    guard let obj = obj else { return "null" }
    if let str = obj as? String {
        return quoteJsString(str)
    }
    if let boolVal = obj as? Bool {
        return boolVal ? "true" : "false"
    }
    if let numVal = obj as? NSNumber {
        return numVal.stringValue
    }
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let json = String(data: data, encoding: .utf8) {
        return json
    }
    if let data = try? JSONSerialization.data(withJSONObject: [obj], options: []),
       let json = String(data: data, encoding: .utf8),
       json.hasPrefix("[") && json.hasSuffix("]") {
        return String(json.dropFirst().dropLast())
    }
    return "null"
}
