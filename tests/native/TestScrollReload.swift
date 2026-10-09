import Cocoa
import WebKit

// Production renderer + FileWatcher; isolated fixtures and in-memory settings.
@MainActor
final class ScrollReloadTests: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var webView: WKWebView!
    var window: NSWindow!
    var started = false
    var watcher: FileWatcher?
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("moread-scroll-\(UUID().uuidString)")
    var fileURL: URL { root.appendingPathComponent("阅读 位置.md") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let content = "# Synthetic scroll document\n\n" + (1...180).map { "Paragraph \($0): 阅读位置测试。\n\n" }.joined()
            try content.write(to: fileURL, atomically: true, encoding: .utf8)
        } catch { finish(false, "Fixture setup: \(error)"); return }
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(self, name: "nativeAPI")
        config.userContentController.add(self, name: "testResult")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 650), configuration: config)
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        window.title = "MoRead isolated scroll regression"
        window.orderFront(nil)
        let renderer = URL(fileURLWithPath: CommandLine.arguments[1])
        webView.loadFileURL(renderer.appendingPathComponent("index.html"), allowingReadAccessTo: renderer)
        watcher = FileWatcher { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.webView.evaluateJavaScript("window.__metadataEvents = (window.__metadataEvents || 0) + 1; window.handleNativeEvent('file:changed', \(self.json([self.fileURL.path]))[0]);")
            }
        }
        watcher?.watch(filePath: fileURL.path)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.finish(false, "Timeout") }
    }

    func json(_ value: Any) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8)!
    }

    func finish(_ success: Bool, _ detail: String) {
        print(detail)
        watcher?.stop()
        try? FileManager.default.removeItem(at: root)
        exit(success ? 0 : 1)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "testResult", let result = message.body as? [String: Any] {
            finish(result["success"] as? Bool ?? false, result["detail"] as? String ?? "No detail")
            return
        }
        guard let body = message.body as? [String: Any], let id = body["id"] as? String, let action = body["action"] as? String else { return }
        var result: Any = ["success": true]
        switch action {
        case "store:get-settings": result = ["theme": "light", "openMode": "read", "saveMode": "manual", "fontSize": 16, "recentFiles": []]
        case "drafts:get-all": result = ["drafts": []]
        case "fs:read-file": result = ["success": true, "content": try! String(contentsOf: fileURL, encoding: .utf8), "stats": ["revision": "unchanged"]]
        case "fs:read-folder": result = ["success": true, "nodes": []]
        case "fs:write-file": finish(false, "FAIL: unexpected write")
        case "test:touch-metadata":
            do { try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: fileURL.path) }
            catch { finish(false, "Metadata touch: \(error)") }
        default: break
        }
        webView.evaluateJavaScript("window.handleNativeResponse(...\(json([id, result])))")
        if action == "app:renderer-ready", !started { started = true; runTests() }
    }

    func runTests() {
        webView.evaluateJavaScript("""
        (async () => {
          const a = window.moreadApp, path = \(json([fileURL.path]))[0];
          let checks = 0;
          const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
          const wait = () => new Promise(r => setTimeout(r,120));
          const near = ratio => Math.abs(a.getScrollRatio()-ratio)<0.015;
          const move = ratio => { const el = a.isSourceMode ? a.sourceTextareaEl : a.markdownScrollWrapperEl; el.scrollTop = ratio*(el.scrollHeight-el.clientHeight); };
          await a.loadFile(path); await wait();
          const tab = a.activeTab, original = tab.rawContent;
          move(0.6);
          const firstNode = a.markdownBodyEl.firstChild;
          await a.reloadTabFromDisk(tab); await wait();
          check(near(0.6),'Unchanged reload reset scroll');
          check(a.markdownBodyEl.firstChild===firstNode,'Unchanged reload replaced DOM');
          for(let i=0;i<5;i++) window.handleNativeEvent('file:changed',path);
          await wait(); check(near(0.6),'Repeated notifications reset scroll');
          move(0.8);
          window.webkit.messageHandlers.nativeAPI.postMessage({id:'metadata',action:'test:touch-metadata',payload:{}});
          await new Promise(r=>setTimeout(r,700));
          check(window.__metadataEvents>0,'Real FileWatcher did not deliver metadata notification');
          check(near(0.8),'Metadata-only event reset scroll');
          check(a.markdownBodyEl.firstChild===firstNode,'Metadata-only event replaced DOM');

          const read = window.electronAPI.readFile;
          window.electronAPI.readFile = async () => ({success:true,content: original+'\\nExtra paragraph\\n',stats:{revision:'r2'}});
          await a.reloadTabFromDisk(tab); await wait();
          check(near(0.8),'Changed content failed to preserve rendered position');
          check(a.markdownBodyEl.textContent.includes('Extra paragraph'),'Changed content not rendered');
          a.toggleSourceView(); await wait(); move(0.55);
          window.electronAPI.readFile = async () => ({success:true,content: original+'\\nUpdated paragraph\\n',stats:{revision:'r3'}});
          await a.reloadTabFromDisk(tab); await wait();
          check(near(0.55),'Changed content failed to preserve source position');
          check(a.sourceTextareaEl.value.includes('Updated paragraph'),'Source content not refreshed');

          let finish;
          window.electronAPI.readFile = () => new Promise(r=>{finish=r;});
          const pending = a.reloadTabFromDisk(tab);
          move(0.75);
          finish({success:true,content:original+'\\nDelayed update\\n',stats:{revision:'r4'}});
          await pending; await wait(); check(near(0.75),'Scroll during async read was lost');

          a.toggleSourceView(); await wait();
          const other = a.createTab({title:'Other',rawContent:original,savedContent:original,scrollRatio:0.3});
          a.renderActiveTabContent(); a.switchTab(other.id); await wait();
          check(near(0.3),'Old render callback moved another tab');
          move(0.4); a.renderActiveTabContent(); move(0.65); await wait();
          check(near(0.65),'Render callback undid new user scrolling');
          other.filePath = path + '.other.md';
          await a.toggleEditMode();
          const paragraph = a.markdownBodyEl.querySelector('p');
          paragraph.textContent += ' Unsaved rendered edit';
          paragraph.dispatchEvent(new Event('input',{bubbles:true}));
          move(0.5);
          window.electronAPI.readFile = async () => ({success:true,content:other.savedContent,stats:{revision:'metadata-r5'}});
          await a.reloadTabFromDisk(other); await wait();
          check(other.isEdited && !other.externalConflict,'Metadata event lost edits or raised false conflict');
          check(a.markdownBodyEl.querySelector('p')===paragraph && paragraph.textContent.includes('Unsaved rendered edit'),'Metadata event replaced edited DOM');
          check(near(0.5),'Metadata event reset dirty rendered position');
          window.electronAPI.readFile = read;
          window.webkit.messageHandlers.testResult.postMessage({success:true,detail:'PASS: '+checks+' WKWebView scroll/reload checks with production FileWatcher'});
        })().catch(error => window.webkit.messageHandlers.testResult.postMessage({success:false,detail:'FAIL: '+String(error)}));
        """)
    }
}

@main
struct ScrollReloadMain {
    @MainActor static func main() {
        let app = NSApplication.shared, delegate = ScrollReloadTests()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
