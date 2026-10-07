import Cocoa
import WebKit
import PDFKit

// Exercises the production renderer snapshot AND the production print exporter.
// No user files/settings are written. Export artifacts are retained for visual inspection.
@MainActor
final class PDFExportTests: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var webView: WKWebView!
    var window: NSWindow!
    var exporter: PDFExporter?
    var started = false
    var finished = false
    var checks = 0
    let fixtures = FileManager.default.temporaryDirectory.appendingPathComponent("moread-pdf-test-\(UUID().uuidString)")
    var output: URL { URL(fileURLWithPath: CommandLine.arguments[2]) }
    var settings: [String: Any] = ["theme": "dark", "fontSize": 24, "contentWidth": "wide", "saveMode": "manual", "openMode": "edit", "allowRemoteImages": false, "recentFiles": []]

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: fixtures, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='480' height='100'><rect width='480' height='100' fill='#0969da'/><text x='20' y='55' fill='white' font-size='26'>LOCAL IMAGE</text></svg>"
            try svg.write(to: fixtures.appendingPathComponent("图 片.svg"), atomically: true, encoding: .utf8)
            let paragraphs = (1...35).map { "段落 \($0)：这是中文分页测试，检查阅读宽度、深色主题不会影响白底导出。PARA\($0)MARK\n\n" }.joined()
            let code = (1...140).map { String(format: "print('MARK_CODE_%03d')", $0) }.joined(separator: "\n")
            let table = (1...100).map { String(format: "| ROWMARK%03d | 中文表格第 %d 行 |", $0, $0) }.joined(separator: "\n")
            let markdown = "# 分页测试\n\n![本地图片](<图 片.svg>)\n\n![remote](https://example.invalid/private.png)\n\n$$\\int_0^1 x^2\\,\\mathrm{d}x = \\frac{1}{3}$$\n\n" + paragraphs + "## 超长代码\n\n```python\n" + code + "\n```\n\n## 跨页表格\n\n| 标记 | 内容 |\n| --- | --- |\n" + table + "\n\n## 最后一个标题\n\nDOCUMENTENDMARK\n"
            try markdown.write(to: fixtures.appendingPathComponent("测试 文档.md"), atomically: true, encoding: .utf8)
            try "# 短文档\n\nMARK_SHORT_END\n".write(to: fixtures.appendingPathComponent("short.md"), atomically: true, encoding: .utf8)
        } catch { finish(false, "Fixture setup: \(error)"); return }
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(self, name: "nativeAPI")
        config.userContentController.add(self, name: "testResult")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1040, height: 720), configuration: config)
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        window.title = "MoRead PDF Regression"
        window.makeKeyAndOrderFront(nil)
        let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("index.html")
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish(false, "Test timed out") }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "testResult", let body = message.body as? [String: Any] {
            checks += body["checks"] as? Int ?? 0
            finish(body["success"] as? Bool ?? false, body["detail"] as? String ?? "No result")
            return
        }
        guard let body = message.body as? [String: Any], let id = body["id"] as? String, let action = body["action"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        var result: Any = ["success": true]
        switch action {
        case "store:get-settings": result = settings
        case "store:save-settings": settings.merge(payload) { _, new in new }
        case "fs:read-file":
            let path = payload["filePath"] as? String ?? ""
            guard path.hasPrefix(fixtures.path + "/") else { finish(false, "Read outside fixtures"); return }
            if let content = try? String(contentsOfFile: path, encoding: .utf8) {
                result = ["success": true, "content": content, "stats": ["size": content.utf8.count, "revision": "fixture"]]
            } else { result = ["success": false, "error": "Missing fixture"] }
        case "fs:read-folder": result = ["success": true, "nodes": []]
        case "drafts:get-all": result = ["success": true, "drafts": []]
        case "fs:write-file": finish(false, "PDF export must not save Markdown"); return
        case "test:pdf":
            print("Starting PDF request"); fflush(stdout)
            guard let snapshot = payload["snapshot"] as? [String: Any], let html = snapshot["html"] as? String,
                  let name = payload["name"] as? String, ["long", "rendered", "short", "empty", "missing-image", "write-failure"].contains(name) else {
                finish(false, "Invalid PDF request"); return
            }
            guard html.count > 10000 else { finish(false, "Export CSS missing"); return }
            let target = name == "write-failure" ? output.appendingPathComponent("nonexistent/subdir.pdf") : output.appendingPathComponent(name + ".pdf")
            let job = PDFExporter()
            exporter = job
            job.export(html: html, filePath: snapshot["filePath"] as? String, to: target) { [weak self] exported in
                guard let self else { return }
                self.exporter = nil
                do {
                    if name == "write-failure" {
                        if case .success = exported { throw self.failure("Write failure reported success") }
                        self.checks += 1
                    } else {
                        try exported.get()
                        try self.validatePDF(target, name: name)
                    }
                    self.respond(id, ["success": true])
                } catch { self.finish(false, "\(name): \(error)") }
            }
            return
        case "app:renderer-ready":
            print("Renderer ready"); fflush(stdout)
            respond(id, result)
            if !started { started = true; runTests() }
            return
        default: break
        }
        respond(id, result)
    }

    func validatePDF(_ url: URL, name: String) throws {
        guard let pdf = PDFDocument(url: url), pdf.pageCount > 0 else { throw failure("Invalid PDF") }
        if name == "long" || name == "rendered" {
            guard pdf.pageCount >= 5 else { throw failure("Expected multiple real pages, got \(pdf.pageCount)") }
        } else if pdf.pageCount != 1 { throw failure("Short/empty document has extra pages: \(pdf.pageCount)") }
        // PDFKit sometimes inserts line breaks within a word; don't confuse extraction with clipping.
        let text = (pdf.string ?? "").precomposedStringWithCompatibilityMapping.filter { !$0.isWhitespace }
        for pageIndex in 0..<pdf.pageCount {
            let bounds = pdf.page(at: pageIndex)!.bounds(for: .mediaBox)
            guard abs(bounds.width - 595.28) < 1, abs(bounds.height - 841.89) < 1 else { throw failure("Not A4: \(bounds)") }
            if name != "empty", (pdf.page(at: pageIndex)?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw failure("Unexpected blank page \(pageIndex + 1)")
            }
        }
        if name == "long" || name == "rendered" {
            for i in 1...140 { guard text.contains(String(format: "MARK_CODE_%03d", i)) else { throw failure("Missing code line \(i)") } }
            for i in 1...100 { guard text.contains(String(format: "ROWMARK%03d", i)) else { throw failure("Missing table row \(i)") } }
            for i in 1...35 { guard text.contains("PARA\(i)MARK") else { throw failure("Missing paragraph \(i)") } }
            guard text.contains("DOCUMENTENDMARK"), !text.contains("图片未能加载") else { throw failure("End or local image missing") }
        }
        if name == "long" { guard text.contains("UNSAVEDSOURCEMARK") else { throw failure("Unsaved source missing") } }
        if name == "rendered" { guard text.contains("UNSAVEDRENDEREDMARK") else { throw failure("Unsaved rendered edit missing") } }
        if name == "missing-image" { guard text.contains("图片未能加载") else { throw failure("Missing-image fallback missing") } }
        guard !text.contains("未打开文件"), !text.contains("源码"), !text.contains("复制") else { throw failure("Application chrome printed") }
        checks += 1
        print("PASS \(name): \(pdf.pageCount) A4 pages, content complete")
    }

    func respond(_ id: String, _ result: Any) {
        let data = try! JSONSerialization.data(withJSONObject: [id, result], options: [.fragmentsAllowed])
        webView.evaluateJavaScript("window.handleNativeResponse(...\(String(data: data, encoding: .utf8)!))")
    }

    func runTests() {
        let data = try! JSONSerialization.data(withJSONObject: [fixtures.path], options: [])
        let path = String(data: data, encoding: .utf8)!
        webView.evaluateJavaScript("""
        (async () => {
          let checks = 0;
          const assert = (ok, reason) => { if (!ok) throw new Error(reason); checks++; };
          const a = window.moreadApp, root = \(path)[0];
          const state = () => JSON.stringify({tabs:a.tabs, active:a.activeTabId, source:a.sourceTextareaEl.value,
            selection:[a.sourceTextareaEl.selectionStart,a.sourceTextareaEl.selectionEnd], dom:a.markdownBodyEl.innerHTML,
            mode:a.isSourceMode, scroll:a.getScrollRatio()});
          const exportNow = async name => {
            const before = state();
            const snapshot = a.prepareForPDFExport();
            assert(state() === before, name + ': snapshot mutated editor');
            assert(snapshot.html.includes('--text-primary: #24292f'), 'White print theme missing');
            assert(!snapshot.html.includes('<button'), 'Copy button leaked');
            assert(!snapshot.html.includes('<img src="https:'), 'Remote image privacy bypass');
            const result = await new Promise(resolve => {
              const id = 'pdf_' + name;
              const original = window.handleNativeResponse;
              window.handleNativeResponse = (responseID, data, error) => {
                if (responseID === id) { window.handleNativeResponse = original; resolve(data); }
                else original(responseID,data,error);
              };
              window.webkit.messageHandlers.nativeAPI.postMessage({id, action:'test:pdf',payload:{name,snapshot}});
            });
            assert(result.success, name + ': export failed');
            assert(state() === before, name + ': export mutated editor');
          };
          try {
            assert(a.prepareForPDFExport() === null, 'Welcome screen must not export');
            await a.loadFile(root + '/测试 文档.md');
            a.toggleSourceView();
            a.sourceTextareaEl.value += '\\nUNSAVEDSOURCEMARK\\n';
            a.sourceTextareaEl.dispatchEvent(new Event('input',{bubbles:true}));
            a.sourceTextareaEl.setSelectionRange(2,9);
            await exportNow('long');
            a.toggleSourceView();
            const p = document.createElement('p'); p.textContent = 'UNSAVEDRENDEREDMARK';
            a.markdownBodyEl.appendChild(p);
            a.markdownBodyEl.dispatchEvent(new Event('input',{bubbles:true}));
            await exportNow('rendered');
            const renderedID = a.activeTabId;
            const savedBefore = a.activeTab.savedContent;
            const code = a.markdownBodyEl.querySelector('.code-editor');
            code.value += '\\nprint("TABCODEMARK")';
            code.dispatchEvent(new Event('input',{bubbles:true}));
            const language = a.markdownBodyEl.querySelector('input.code-lang');
            language.value = 'javascript';
            language.dispatchEvent(new Event('input',{bubbles:true}));
            a.markdownBodyEl.querySelector('.math-block-wrapper').setAttribute('data-raw-formula','x^3');
            await a.loadFile(root + '/short.md');
            const shortID = a.activeTabId;
            const shortSaved = a.activeTab.savedContent;
            a.switchTab(renderedID);
            assert(a.markdownBodyEl.textContent.includes('UNSAVEDRENDEREDMARK'), 'Rendered edits lost switching tabs');
            assert(a.markdownBodyEl.querySelector('.code-editor').value.includes('TABCODEMARK'), 'Code edits lost switching tabs');
            assert(a.markdownBodyEl.querySelector('input.code-lang').value === 'javascript', 'Code language lost switching tabs');
            assert(a.markdownBodyEl.querySelector('.math-block-wrapper').getAttribute('data-raw-formula') === 'x^3', 'Formula lost switching tabs');
            assert(a.activeTab.isEdited && a.activeTab.savedContent === savedBefore, 'Switch incorrectly marked edits saved');
            a.switchTab(shortID);
            assert(a.activeTab.savedContent === shortSaved && !a.activeTab.isEdited, 'Edits contaminated other tab');
            a.switchTab(renderedID);
            a.toggleSourceView();
            a.sourceTextareaEl.value += '\\nSOURCEAFTERSWITCHMARK';
            a.sourceTextareaEl.dispatchEvent(new Event('input',{bubbles:true}));
            a.switchTab(shortID);
            a.switchTab(renderedID);
            assert(a.sourceTextareaEl.value.includes('SOURCEAFTERSWITCHMARK'), 'Source edits lost switching tabs');
            a.switchTab(shortID);
            await exportNow('short');
            await exportNow('write-failure');
            a.toggleSourceView();
            a.sourceTextareaEl.value = '';
            await exportNow('empty');
            a.sourceTextareaEl.value = '![missing](absent.png)';
            await exportNow('missing-image');
            window.webkit.messageHandlers.testResult.postMessage({success:true,checks,detail:'Editor state, privacy and actual PDF regression passed'});
          } catch (error) { window.webkit.messageHandlers.testResult.postMessage({success:false,checks,detail:String(error.stack || error)}); }
        })();
        """)
    }

    func failure(_ reason: String) -> NSError { NSError(domain: "PDFTest", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
    func finish(_ success: Bool, _ reason: String) {
        guard !finished else { return }
        finished = true
        try? FileManager.default.removeItem(at: fixtures)
        print("\(success ? "PASS" : "FAIL") \(checks) PDF checks: \(reason)")
        fflush(stdout)
        exit(success ? 0 : 1)
    }
}

@main
struct PDFTestMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = PDFExportTests()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
