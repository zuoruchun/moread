import Cocoa
import WebKit
import CryptoKit

// Production bridge host with every persistent location injected into a temporary fixture.
public final class MainWindowController: @unchecked Sendable {
    public var webView: WKWebView!
    public var window: NSWindow?
    public func rendererDidBecomeReady() {}
    public func beginWindowDrag() {}
    public func forceCloseWindow() {}
    public func allowLocalResources(forDocument path: String) {}
    public func exportPDF(completion: (([String: Any]) -> Void)? = nil) { completion?(["success": false]) }
}

@MainActor
final class BridgeSecurityTests: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let fixture = FileManager.default.temporaryDirectory.appendingPathComponent("moread-bridge-security-\(UUID().uuidString)")
    let host = MainWindowController()
    var bridge: NativeBridge!
    var settings: SettingsManager!
    var finished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let allowed = fixture.appendingPathComponent("allowed")
            let outside = fixture.appendingPathComponent("outside")
            let drafts = fixture.appendingPathComponent("drafts")
            for url in [allowed, outside, drafts] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
            try Data("# allowed\n".utf8).write(to: allowed.appendingPathComponent("doc.md"))
            try Data("# unapproved\n".utf8).write(to: outside.appendingPathComponent("secret.md"))
            try FileManager.default.createSymbolicLink(at: allowed.appendingPathComponent("escape.md"), withDestinationURL: outside.appendingPathComponent("secret.md"))
            try FileManager.default.createSymbolicLink(at: allowed.appendingPathComponent("escape-dir"), withDestinationURL: outside)
            let legacy: [String: Any] = ["id": "legacy:/document", "content": "legacy content"]
            try JSONSerialization.data(withJSONObject: legacy).write(to: drafts.appendingPathComponent("legacy__document.json"))
            try Data("blocking regular file".utf8).write(to: fixture.appendingPathComponent("blocked"))
            settings = SettingsManager(configURL: fixture.appendingPathComponent("settings/config.json"))
            bridge = NativeBridge(settingsManager: settings, draftsDirectory: drafts)
            let configuration = WKWebViewConfiguration()
            configuration.userContentController.add(self, name: "nativeAPI")
            configuration.userContentController.add(self, name: "result")
            host.webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 200), configuration: configuration)
            host.webView.navigationDelegate = self
            host.window = NSWindow(contentRect: host.webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
            host.window?.contentView = host.webView
            bridge.windowController = host
            host.webView.loadHTMLString("<!doctype html><html><body>Isolated bridge security regression</body></html>", baseURL: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.finish(false, "Timed out") }
        } catch { finish(false, "Fixture setup failed: \(error)") }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "result" {
            finish(body["success"] as? Bool ?? false, body["detail"] as? String ?? "Missing result")
            return
        }
        if body["action"] as? String == "test:grant" {
            bridge.authorizeDirectory(fixture.appendingPathComponent("allowed").path, persist: true)
            bridge.sendResponse(id: body["id"] as! String, result: ["success": true])
        } else if body["action"] as? String == "test:restart" {
            bridge.stopWatchingFiles()
            bridge = NativeBridge(settingsManager: SettingsManager(configURL: fixture.appendingPathComponent("settings/config.json")), draftsDirectory: fixture.appendingPathComponent("drafts"))
            bridge.windowController = host
            bridge.sendResponse(id: body["id"] as! String, result: ["success": true])
        } else if body["action"] as? String == "test:watcher-fds" {
            let watchedRoot = LocalFileAccessPolicy.canonicalPath(fixture.appendingPathComponent("allowed").path)
            var count = 0
            for descriptor in 0..<min(getdtablesize(), 8192) {
                var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
                if fcntl(descriptor, F_GETPATH, &bytes) == 0,
                   LocalFileAccessPolicy.isPath(String(cString: bytes), inside: watchedRoot) { count += 1 }
            }
            bridge.sendResponse(id: body["id"] as! String, result: ["count": count])
        } else if body["action"] as? String == "test:blocked-drafts" {
            bridge.stopWatchingFiles()
            bridge = NativeBridge(settingsManager: settings, draftsDirectory: fixture.appendingPathComponent("blocked"))
            bridge.windowController = host
            bridge.sendResponse(id: body["id"] as! String, result: ["success": true])
        } else {
            bridge.userContentController(userContentController, didReceive: message)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let encoded = String(data: try! JSONSerialization.data(withJSONObject: ["root": fixture.path]), encoding: .utf8)!
        webView.evaluateJavaScript("window.fixture = \(encoded);") { [weak self] _, error in
            if let error { self?.finish(false, "Fixture injection: \(error)"); return }
            self?.host.webView.evaluateJavaScript(Self.script) { [weak self] _, error in
                if let error { self?.finish(false, "Security script: \(error)") }
            }
        }
    }

    func finish(_ success: Bool, _ detail: String) {
        guard !finished else { return }
        finished = true
        bridge?.stopWatchingFiles()
        let secret = fixture.appendingPathComponent("outside/secret.md")
        let intact = (try? String(contentsOf: secret, encoding: .utf8)) == "# unapproved\n"
        print("\(success && intact ? "PASS" : "FAIL"): \(detail); external fixture bytes intact=\(intact)")
        try? FileManager.default.removeItem(at: fixture)
        exit(success && intact ? 0 : 1)
    }

    static let script = #"""
    (() => {
      const pending = new Map(); let serial = 0; let passed = 0;
      window.handleNativeResponse = (id, result, error) => { const p = pending.get(id); pending.delete(id); error ? p.reject(error) : p.resolve(result); };
      window.handleNativeEvent = () => {};
      const api = (action, payload = {}) => new Promise((resolve, reject) => { const id = String(++serial); pending.set(id, {resolve, reject}); window.webkit.messageHandlers.nativeAPI.postMessage({id, action, payload}); });
      const check = (value, message) => { if (!value) throw new Error(message); passed++; };
      const root = window.fixture.root, allowed = root + '/allowed/doc.md', outside = root + '/outside/secret.md';
      (async () => {
        await api('store:save-settings', {recentFiles: [outside], trustedDirectories: [root + '/outside']});
        await api('store:get-settings');
        check(!(await api('fs:read-file', {filePath: outside})).success, 'Recent settings self-authorized read');
        check(!(await api('fs:write-file', {filePath: outside, content: 'corrupt'})).success, 'Recent settings self-authorized write');
        const conflict = await api('fs:check-conflict', {filePath: outside, baselineRevision: ''});
        check(conflict.conflict && !conflict.currentRevision, 'Conflict check disclosed unauthorized hash');
        await api('test:grant');
        check((await api('fs:read-file', {filePath: allowed})).content === '# allowed\n', 'Native user grant did not enable access');
        await api('test:restart');
        check((await api('fs:read-file', {filePath: allowed})).success, 'Native grant was not persisted');
        check(!(await api('fs:read-file', {filePath: outside})).success, 'Restart trusted renderer settings');
        const escape = root + '/allowed/escape.md';
        check(!(await api('fs:read-file', {filePath: escape})).success, 'File symlink escaped root');
        check(!(await api('fs:write-file', {filePath: escape, content: 'corrupt'})).success, 'Write symlink escaped root');
        const linkedConflict = await api('fs:check-conflict', {filePath: escape, baselineRevision: ''});
        check(linkedConflict.conflict && !linkedConflict.currentRevision, 'Symlink conflict disclosed hash');
        const tree = await api('fs:read-folder', {folderPath: root + '/allowed'});
        check(tree.success && !JSON.stringify(tree.nodes).includes('escape'), 'Folder tree exposes external symlinks');
        const read = await api('fs:read-file', {filePath: allowed});
        check((await api('fs:write-file', {filePath: allowed, content: '# changed\n', expectedRevision: read.stats.revision})).success, 'Authorized write failed');
        check(!(await api('fs:write-file', {filePath: allowed, content: 'stale', expectedRevision: read.stats.revision})).success, 'Stale revision overwrote newer bytes');
        check((await api('fs:read-file', {filePath: allowed})).content === '# changed\n', 'Wrong disk bytes after conflict');
        const ids = ['a/b:c', 'a_b_c', '../outside/secret', '文'.repeat(300)];
        for (const [index, id] of ids.entries()) check((await api('drafts:save', {id, content: 'draft-' + index})).success, 'Draft save failed: ' + index);
        const all = (await api('drafts:get-all')).drafts;
        check(ids.every((id, index) => all.some(d => d.id === id && d.content === 'draft-' + index)), 'Draft IDs collided or escaped');
        check(all.some(d => d.id === 'legacy:/document' && d.content === 'legacy content'), 'Legacy draft was not readable');
        check((await api('drafts:delete', {id: ids[0]})).success, 'Draft delete failed');
        const left = (await api('drafts:get-all')).drafts;
        check(!left.some(d => d.id === ids[0]) && left.some(d => d.id === ids[1]), 'Draft delete removed colliding ID');
        await api('drafts:save', {id: 'legacy:/document', content: 'migrated'});
        const migrated = (await api('drafts:get-all')).drafts.filter(d => d.id === 'legacy:/document');
        check(migrated.length === 1 && migrated[0].content === 'migrated', 'Legacy migration duplicated draft');
        const previewed = {id:'conditional', content:'old preview', timestamp:1, savedContent:'baseline'};
        await api('drafts:save', previewed);
        await api('drafts:save', {...previewed, content:'newer content', timestamp:2});
        const refused = await api('drafts:delete', {id:previewed.id, expectedDraft:previewed});
        check(!refused.success && refused.conflict, 'Stale preview deleted a newly updated draft');
        const current = (await api('drafts:get-all')).drafts.find(d => d.id === previewed.id);
        check(current.content === 'newer content', 'Conditional deletion altered current draft');
        check((await api('drafts:delete', {id:current.id, expectedDraft:current})).success, 'Matching preview could not delete its draft');
        check(!(await api('drafts:get-all')).drafts.some(d => d.id === current.id), 'Conditional deletion did not remove matching draft');
        check(!(await api('drafts:delete', {id:current.id, expectedDraft:current})).success, 'Deleted snapshot falsely appeared current');
        await api('test:restart');
        const outstanding = Array.from({length: 20}, () => api('fs:read-file', {filePath: root + '/allowed/doc.md'}));
        await api('fs:unwatch-file', {filePath: root + '/allowed/doc.md'});
        await Promise.all(outstanding);
        await new Promise(resolve => setTimeout(resolve, 300));
        check((await api('test:watcher-fds')).count === 0, 'A completed stale read revived a closed file watcher');
        await api('fs:read-file', {filePath: root + '/allowed/doc.md'});
        await new Promise(resolve => setTimeout(resolve, 100));
        check((await api('test:watcher-fds')).count >= 2, 'A reopened file did not resume watching');
        await api('fs:unwatch-file', {filePath: root + '/allowed/../allowed/doc.md'});
        await new Promise(resolve => setTimeout(resolve, 100));
        check((await api('test:watcher-fds')).count === 0, 'Normalized unwatch path did not release descriptors');
        await api('test:blocked-drafts');
        check(!(await api('drafts:save', {id: 'must-fail', content: 'preserve editing'})).success, 'Failed draft write falsely reported success');
        window.webkit.messageHandlers.result.postMessage({success: true, detail: passed + ' production bridge checks passed'});
      })().catch(error => window.webkit.messageHandlers.result.postMessage({success: false, detail: String(error)}));
    })();
    """#
}

@main struct BridgeSecurityRunner {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = BridgeSecurityTests()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
