import Cocoa
import WebKit

#if MOREAD_BRIDGE_INTEGRATION
// A minimal host for the production filesystem bridge, without application settings/dialogs.
public final class MainWindowController: @unchecked Sendable {
    public var webView: WKWebView!
    public var window: NSWindow?
    public func rendererDidBecomeReady() {}
    public func beginWindowDrag() {}
    public func forceCloseWindow() {}
    public func allowLocalResources(forDocument path: String) {}
    public func exportPDF(completion: (([String: Any]) -> Void)? = nil) { completion?(["success": false, "cancelled": true]) }
}
#endif

// Runs the production renderer in WKWebView with an isolated native bridge.
// File operations use temporary fixtures; settings stay in memory.
@MainActor
final class RendererTests: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var settings: [String: Any] = ["theme": "system", "fontSize": 16, "showSidebar": false, "recentFiles": [], "openMode": "edit"]
    let fixtures = FileManager.default.temporaryDirectory.appendingPathComponent("moread-renderer-\(UUID().uuidString)")
    var completed = false
    var phase = 0
    var timer: Timer?
    var passedChecks = 0
#if MOREAD_BRIDGE_INTEGRATION
    let productionBridge = NativeBridge()
    let productionHost = MainWindowController()
    let usingProductionBridge = true
#else
    let usingProductionBridge = false
#endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: fixtures, withIntermediateDirectories: true)
            try "# 1\\. **第一节**\n\n正文\n\n## 2\\. 第二节\n\n## 3\\. 第三节".write(to: fixtures.appendingPathComponent("未命名.md"), atomically: true, encoding: .utf8)
            try FileManager.default.createDirectory(at: fixtures.appendingPathComponent("nested"), withIntermediateDirectories: true)
            try "# 子目录".write(to: fixtures.appendingPathComponent("nested/另一个.md"), atomically: true, encoding: .utf8)
            try "# 自动保存测试\n".write(to: fixtures.appendingPathComponent("自动保存.md"), atomically: true, encoding: .utf8)
            try "# 公式编辑\n\n行内 $x+1$ 文字\n\n$$\ny^2\n$$\n".write(to: fixtures.appendingPathComponent("公式.md"), atomically: true, encoding: .utf8)
            try "# İXYZ\n\n中文 **XYZ** 和 XYZ\n\n```text\nXYZ \\\\ XYZ\n```\n\n$\\frac{x}{2}$\n\n前$x$后\n".write(to: fixtures.appendingPathComponent("查找替换.md"), atomically: true, encoding: .utf8)
            try #"""
            # 代码编辑测试

            ```bash
            qwen-start \
              --gpu 1 \
              --max-model-len 98304 \
              --gpu-memory-utilization 0.90
            ```

            ```python
            print("second block")
            ```

            ```not-a-language
            <script>window.__codeExecuted = true</script>
            ```

            ```text
            first


            ```

            ```text

            ```
            """#.write(to: fixtures.appendingPathComponent("代码.md"), atomically: true, encoding: .utf8)
        } catch { finish(false, "Fixture setup: \(error)"); return }
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(self, name: "nativeAPI")
        config.userContentController.add(self, name: "testResult")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 720), configuration: config)
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = webView
        window.title = "MoRead Renderer Regression"
        window.makeKeyAndOrderFront(nil)
#if MOREAD_BRIDGE_INTEGRATION
        productionHost.webView = webView
        productionHost.window = window
        productionBridge.windowController = productionHost
        productionBridge.authorizeDirectory(fixtures.path)
#endif
        let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("index.html")
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            if self?.completed == false { self?.finish(false, "Timed out") }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "testResult", let body = message.body as? [String: Any] {
            finish(body["success"] as? Bool ?? false, body["detail"] as? String ?? "No detail")
            return
        }
        guard let body = message.body as? [String: Any], let id = body["id"] as? String, let action = body["action"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
#if MOREAD_BRIDGE_INTEGRATION
        if ["fs:read-file", "fs:read-folder", "fs:write-file"].contains(action) {
            let path = payload["filePath"] as? String ?? payload["folderPath"] as? String ?? ""
            guard URL(fileURLWithPath: path).standardized.path.hasPrefix(fixtures.path) else {
                finish(false, "Production bridge attempted access outside isolated fixtures"); return
            }
            productionBridge.userContentController(userContentController, didReceive: message)
            return
        }
#endif
        if action == "test:reload" {
            passedChecks = payload["checks"] as? Int ?? 0
            phase = 2
            webView.reload()
            return
        }
        var result: Any = ["success": true]
        switch action {
        case "store:get-settings": result = settings
        case "store:save-settings": settings.merge(payload) { _, value in value }
        case "fs:read-file":
            let path = payload["filePath"] as? String ?? ""
            if let content = try? String(contentsOfFile: path, encoding: .utf8) {
                result = ["success": true, "content": content, "stats": ["size": content.utf8.count]]
            } else { result = ["success": false, "error": "File missing"] }
        case "fs:read-folder":
            let path = payload["folderPath"] as? String ?? ""
            result = ["success": true, "nodes": scan(URL(fileURLWithPath: path))]
        case "fs:write-file":
            let path = payload["filePath"] as? String ?? ""
            let content = payload["content"] as? String ?? ""
            guard URL(fileURLWithPath: path).standardized.path.hasPrefix(fixtures.path + "/") else {
                finish(false, "Attempted to write outside isolated fixtures"); return
            }
            do {
                try content.write(toFile: path, atomically: true, encoding: .utf8)
                result = ["success": true, "stats": ["size": content.utf8.count]]
            } catch { result = ["success": false, "error": String(describing: error)] }
        case "dialog:confirm-save": result = ["action": "dont-save"]
        default: break
        }
        let values = try! JSONSerialization.data(withJSONObject: [id, result], options: [.fragmentsAllowed])
        let json = String(data: values, encoding: .utf8)!
        webView.evaluateJavaScript("window.handleNativeResponse(...\(json))")
    }

    func scan(_ url: URL) -> [[String: Any]] {
        let entries = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return entries.compactMap { entry in
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir { return ["name": entry.lastPathComponent, "path": entry.path, "isDirectory": true, "children": scan(entry)] }
            guard entry.pathExtension.lowercased() == "md" else { return nil }
            return ["name": entry.lastPathComponent, "path": entry.path, "isDirectory": false]
        }
    }

    func poll() {
        guard !completed, phase != 1, phase != 3 else { return }
        let readiness = phase == 2 ? "Boolean(window.moreadApp && window.moreadApp.currentSettings.theme && !window.__rendererTestInitial)" : "Boolean(window.moreadApp && window.moreadApp.currentSettings.theme)"
        webView.evaluateJavaScript(readiness) { [weak self] result, _ in
            guard let self, result as? Bool == true else { return }
            if self.phase == 0 {
                self.phase = 1
                self.runInteractions()
            } else if self.phase == 2 {
                self.phase = 3
                self.webView.evaluateJavaScript("""
                (() => {
                  const a = window.moreadApp;
                  const ok = a.currentSettings.theme === 'dark' && a.settingsFontSizeEl.value === '20' && a.selectWidthEl.value === 'wide' && a.selectSaveModeEl.value === 'auto' && a.filesTabBtn.classList.contains('active') && a.btnToggleSidebarEl.getAttribute('aria-expanded') === 'true';
                  window.webkit.messageHandlers.testResult.postMessage({success: ok, detail: ok ? 'PASS: \(passedChecks + 1) renderer checks, including code editing/copy/save/undo and reload persistence' : 'Settings/sidebar persistence failed'});
                })()
                """)
            }
        }
    }

    func runInteractions() {
        let fixtureJSON = String(data: try! JSONSerialization.data(withJSONObject: [fixtures.path]), encoding: .utf8)!
        webView.evaluateJavaScript("""
        void (async () => {
          try {
            const root = \(fixtureJSON)[0], a = window.moreadApp;
            window.__rendererTestInitial = true;
            let checks = 0;
            const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
            const click = id => document.getElementById(id).click();
            check(document.querySelectorAll('.header-left button').length === 1, 'One sidebar button');
            check(document.querySelectorAll('.header-right button').length === 3 && !document.querySelector('.header-right select') && !document.getElementById('btn-settings') && !document.getElementById('btn-font-increase') && !document.querySelector('.status-left button'), 'Toolbar cleanup');
            check(document.getElementById('btn-welcome-new-file'), 'Welcome has new file action');
            click('btn-welcome-new-file');
            check(a.activeTab && !a.activeTab.filePath && a.isEditMode && a.markdownBodyEl.getAttribute('contenteditable') === 'true', 'Welcome new file is immediately editable');
            await a.closeTab(a.activeTab.id);
            await a.loadFile(root + '/未命名.md');
            check(a.docTitleEl.textContent === '未命名.md' && a.filesContentEl.textContent.includes('未命名.md'), 'Standalone file list');
            click('btn-toggle-sidebar'); click('tab-files'); click('btn-toggle-sidebar'); click('btn-toggle-sidebar');
            check(a.filesTabBtn.classList.contains('active') && a.btnToggleSidebarEl.getAttribute('aria-expanded') === 'true', 'Tab survives collapse');
            click('tab-outline');
            check([...document.querySelectorAll('.outline-link')].map(x => x.textContent).join('|') === '1. 第一节|2. 第二节|3. 第三节', 'Visible numbered outline');
            check([...document.querySelectorAll('.outline-link')].every(x => document.getElementById(x.getAttribute('href').slice(1))), 'Heading anchors');
            click('btn-toggle-source'); click('btn-toggle-source');
            check(!a.outlineContentEl.textContent.includes('\\\\'), 'Roundtrip outline escapes');
            const api = window.electronAPI, readFolder = api.readFolder;
            let release; api.readFolder = () => new Promise(resolve => { release = resolve; });
            const stale = a.loadFile(root + '/未命名.md');
            while (!release) await new Promise(r => setTimeout(r, 10));
            api.readFolder = readFolder;
            await a.loadFile(root + '/nested/另一个.md');
            release({success:true,nodes:[]}); await stale;
            check(a.filesContentEl.textContent.includes('另一个.md'), 'Stale folder result ignored');
            api.readFolder = async () => ({success:false,error:'Denied'});
            await a.loadFile(root + '/未命名.md');
            check(a.filesContentEl.textContent.includes('未命名.md') && a.filesContentEl.textContent.includes('无法读取文件夹'), 'Folder failure retains file');
            api.readFolder = readFolder;
            await a.loadFolderTree(root); await a.loadFile(root + '/nested/另一个.md');
            check(a.filesContentEl.textContent.includes('未命名.md') && a.filesContentEl.textContent.includes('另一个.md'), 'Nested file keeps folder root and expands');
            await a.loadFile(root + '/代码.md');
            const blocks = [...a.markdownBodyEl.querySelectorAll('.code-block-container')];
            check(blocks.length === 5 && blocks.every(b => b.querySelector('input.code-lang') && b.querySelector('textarea.code-editor')), 'Editable code controls survive DOMPurify');
            const expectedLines = [4, 1, 1, 3, 1];
            check(blocks.every((b, i) => {
              const display = b.querySelector('pre code');
              return Math.abs(display.getBoundingClientRect().height - parseFloat(getComputedStyle(display).lineHeight) * expectedLines[i]) < 1;
            }), 'Code display height has no fence separator row and preserves genuine blank rows');
            check(blocks[1].querySelector('textarea').value === 'print("second block")' && blocks[3].querySelector('textarea').value === 'first\\n\\n' && blocks[4].querySelector('textarea').value === '', 'Input values exclude only the closing fence separator');
            let code = blocks[0].querySelector('pre code'), language = blocks[0].querySelector('input.code-lang');
            let editor = blocks[0].querySelector('textarea.code-editor');
            editor.scrollIntoView({block:'center'});
            const editorRect = editor.getBoundingClientRect();
            check(document.elementFromPoint(editorRect.left + 20, editorRect.top + 20) === editor, 'Mouse clicks hit the code editor instead of the parent article');
            const initialCode = editor.value;
            const liveCode = () => editor.value;
            check(code.querySelector('.hljs-title')?.textContent === 'qwen-start' && code.querySelector('.hljs-attr')?.textContent === '--gpu' && code.querySelector('.hljs-number'), 'Bash CLI highlighting');
            check(getComputedStyle(code.querySelector('.hljs-title')).color !== getComputedStyle(code).color && getComputedStyle(code.querySelector('.hljs-number')).color !== getComputedStyle(code).color, 'Highlight colors differ from plain text');
            check(!blocks[2].querySelector('script') && !window.__codeExecuted, 'Unknown language escapes script');
            const selectCode = () => {
              editor.focus(); editor.select();
            };
            selectCode();
            const editedCode = 'def hello():\\n    return "中文"\\n\\n';
            document.execCommand('insertText', false, editedCode);
            check(a.isEdited && liveCode() === editedCode, 'Multiline code editing preserves indentation and trailing blank lines: ' + JSON.stringify({edited:a.isEdited,text:liveCode(),html:code.innerHTML}));
            document.execCommand('undo');
            check(liveCode() === initialCode, 'Native undo during code editing');
            document.execCommand('redo');
            check(liveCode() === editedCode, 'Native redo during code editing');
            const caretBeforeLanguage = editor.selectionStart;
            editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'中'}));
            editor.value = editedCode; editor.dispatchEvent(new InputEvent('input', {bubbles:true,isComposing:true,data:'中'}));
            editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'中'}));
            check(editor.value === editedCode && editor.selectionStart === caretBeforeLanguage, 'Composition events do not reset code value or caret');
            language.focus(); language.value = 'py'; language.dispatchEvent(new Event('input', {bubbles:true}));
            check(editor.value === editedCode && code.querySelector('.hljs-keyword')?.textContent === 'def', 'Rendered language edit recolors without changing code');
            let copied = null;
            Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {copied = text;}}});
            blocks[0].querySelector('.code-copy-btn').click();
            await new Promise(r => setTimeout(r, 0));
            check(copied === editedCode, 'Copy reads edited code, not stale cache');
            check(await a.saveCurrentFile(), 'Rendered code save succeeds');
            const saved = await api.readFile(root + '/代码.md');
            check(saved.content.includes('```py\\n' + editedCode + '\\n```') && saved.content.includes('print("second block")') && !saved.content.includes('代码语言') && !a.isEdited, 'Saved file preserves language, code, trailing lines and neighboring blocks');
            click('btn-toggle-source');
            check(a.sourceTextareaEl.value.includes('```py\\n' + editedCode + '\\n```'), 'Code edits survive switching to source');
            click('btn-toggle-source');
            code = a.markdownBodyEl.querySelector('.code-block-container pre code');
            language = a.markdownBodyEl.querySelector('input.code-lang');
            editor = a.markdownBodyEl.querySelector('textarea.code-editor');
            check(editor.value === editedCode && language.value === 'py', 'Source roundtrip preserves edited code');
            check(Math.abs(code.getBoundingClientRect().height - parseFloat(getComputedStyle(code).lineHeight) * editedCode.split('\\n').length) < 1, 'Edited trailing blank rows keep input and display geometry aligned');
            editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
            editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}));
            document.execCommand('insertText', false, '\\n');
            check(liveCode() === editedCode + '  \\n', 'Code Tab and Enter insert plaintext without exiting the block: ' + JSON.stringify({text:liveCode(),html:code.innerHTML}));
            const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'x = 1\\n    # 中文\\n'); clipboard.setData('text/html', '<h1>wrong rich text</h1>');
            editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:clipboard}));
            check(liveCode() === editedCode + '  \\nx = 1\\n    # 中文\\n' && !code.querySelector('h1'), 'Code paste strips formatting and preserves plaintext');
            const longLine = 'long_command --arg ' + 'x'.repeat(200);
            selectCode(); document.execCommand('insertText', false, longLine);
            editor.scrollLeft = 200; editor.dispatchEvent(new Event('scroll'));
            check(editor.scrollLeft > 0 && Math.abs(editor.scrollLeft - code.parentElement.scrollLeft) <= 1, 'Long code horizontal scrolling keeps highlighted layer aligned');
            language.focus(); language.value = 'not-a-language'; language.dispatchEvent(new Event('input', {bubbles:true}));
            check(editor.value === longLine && !code.querySelector('[class^="hljs-"]'), 'Unknown language retains plaintext safely');
            language.value = ''; language.dispatchEvent(new Event('input', {bubbles:true}));
            click('btn-toggle-source');
            check(a.sourceTextareaEl.value.includes('```\\n' + longLine), 'Clearing language produces an unlabelled fence');
            click('btn-toggle-source');
            await a.loadFile(root + '/公式.md');
            if (a.isSourceMode) click('btn-toggle-source');
            if (!a.isEditMode) await a.toggleEditMode();
            const formula = a.markdownBodyEl.querySelector('.math-inline-wrapper');
            check(formula && formula.querySelector('svg'), 'Inline formula initially rendered');
            formula.click();
            let mathEditor = formula.querySelector('textarea.math-editor');
            check(mathEditor && document.activeElement === mathEditor && mathEditor.value === 'x+1', 'One click edits rendered formula without source mode');
            const newFormula = String.raw`\\frac{中文+x}{2}`;
            mathEditor.select(); document.execCommand('insertText', false, newFormula);
            check(a.isEdited && formula.getAttribute('data-raw-formula') === newFormula, 'Formula input marks dirty and updates serialization');
            document.execCommand('undo');
            check(mathEditor.value === 'x+1' && formula.getAttribute('data-raw-formula') === 'x+1', 'Formula native undo updates saved source');
            document.execCommand('redo');
            check(mathEditor.value === newFormula, 'Formula native redo works');
            await new Promise(r => setTimeout(r, 250));
            check(await a.saveCurrentFile(), 'Save after delayed formula preview while editor is open');
            const mathSaved = await api.readFile(root + '/公式.md');
            check(mathSaved.content.includes('$' + newFormula + '$') && !mathSaved.content.includes('math-editor') && !mathSaved.content.includes('完成'), 'Real disk contains edited LaTeX and no controls');
            const mathDone = formula.querySelector('.math-editor-done');
            mathEditor.dispatchEvent(new FocusEvent('blur', {relatedTarget:mathDone}));
            mathDone.click();
            check(!formula.querySelector('textarea') && formula.querySelector('svg'), 'Done click after textarea blur closes editor and renders preview');
            const blockFormula = a.markdownBodyEl.querySelector('.math-block-wrapper');
            blockFormula.click(); mathEditor = blockFormula.querySelector('textarea');
            mathEditor.select(); document.execCommand('insertText', false, 'z=3');
            click('btn-toggle-source');
            check(a.isSourceMode && a.sourceTextareaEl.value.includes('z=3') && a.sourceTextareaEl.value.includes(newFormula), 'First source click preserves both formula edits');
            click('btn-toggle-source');
            check(a.markdownBodyEl.querySelector('.math-block-wrapper').getAttribute('data-raw-formula') === 'z=3', 'Math roundtrip preserves block source');
            check(await a.saveCurrentFile(), 'Save both math edits');
            await a.toggleEditMode();
            check(!a.isEditMode, 'Finish editing responds on first call');
            a.markdownBodyEl.querySelector('.math-inline-wrapper').click();
            check(!a.markdownBodyEl.querySelector('textarea.math-editor'), 'Read mode cannot change a formula');
            await a.loadFile(root + '/查找替换.md');
            if (a.isSourceMode) click('btn-toggle-source');
            if (!a.isEditMode) await a.toggleEditMode();
            const search = document.getElementById('search-input'), replacement = document.getElementById('replace-input');
            const query = text => { search.value = text; search.dispatchEvent(new Event('input')); };
            const count = () => document.getElementById('search-count').textContent;
            const originalSearchHTML = a.markdownBodyEl.innerHTML;
            a.openSearch(); query('xyz');
            check(count() === '1/5', 'Rendered search counts visible text and code only: ' + count());
            check(CSS.highlights && CSS.highlights.get('moread-search').size === 5, 'Actual WebKit supports nonmutating visible highlights');
            check([...CSS.highlights.get('moread-search')].every(range => range.toString() === 'XYZ'), 'Unicode search highlights original offsets');
            check(a.markdownBodyEl.innerHTML === originalSearchHTML && !a.isEdited, 'Searching never mutates editable DOM or marks dirty');
            query('前后'); check(count() === '无匹配', 'Search never joins text across a hidden formula boundary'); query('XYZ');
            check(a.markdownBodyEl.getBoundingClientRect().top > document.getElementById('search-bar').getBoundingClientRect().bottom, 'Search bar does not cover the first visible result at 500px');
            const highlightRegistry = CSS.highlights;
            highlightRegistry.clear(); Object.defineProperty(CSS, 'highlights', {configurable:true,value:undefined});
            a.searchController.performSearch();
            check(document.querySelectorAll('.search-render-overlay span').length > 0 && a.markdownBodyEl.innerHTML === originalSearchHTML && !a.isEdited, 'Fallback highlight overlay is visible and never changes editable text');
            Object.defineProperty(CSS, 'highlights', {configurable:true,value:highlightRegistry}); a.searchController.performSearch();
            click('btn-search-next');
            check(count() === '2/5' && [...CSS.highlights.get('moread-search-current')][0].toString() === 'XYZ', 'Next result updates persistent current highlight');
            replacement.value = '<literal & $1>'; click('btn-search-replace');
            check(a.isEdited && a.markdownBodyEl.textContent.includes('<literal & $1>') && !a.markdownBodyEl.querySelector('literal'), 'Rendered replacement is literal plaintext and marks dirty');
            a.markdownBodyEl.focus(); document.execCommand('undo');
            check(!a.markdownBodyEl.textContent.includes('<literal & $1>'), 'Rendered replacement supports native undo');
            query(String.fromCharCode(92,92)); replacement.value = 'code-edited';
            check(count() === '1/1', 'Rendered backslash search uses visible code ranges');
            click('btn-search-replace');
            check(a.markdownBodyEl.querySelector('textarea.code-editor').value.includes('code-edited'), 'Rendered code replacement updates its live editor');
            a.markdownBodyEl.querySelector('textarea.code-editor').focus(); document.execCommand('undo');
            check(a.markdownBodyEl.querySelector('textarea.code-editor').value.includes(String.fromCharCode(92,92)), 'Rendered code replacement has native undo');
            query('XYZ'); replacement.value = 'ALL'; click('btn-search-replace-all');
            check(count() === '无匹配' && a.markdownBodyEl.querySelector('strong').textContent === 'ALL' && a.markdownBodyEl.querySelector('textarea.code-editor').value.split('ALL').length === 3, 'Rendered Replace All preserves bold formatting and updates every code match');
            for (let undo = 0; undo < 8 && count() !== '1/5'; undo++) {
              document.execCommand('undo'); a.searchController.performSearch();
            }
            check(count() === '1/5' && a.markdownBodyEl.querySelector('strong').textContent === 'XYZ', 'Rendered Replace All can be fully undone across text and code editors');
            a.searchController.close();
            check(!CSS.highlights.has('moread-search'), 'Closing search removes decorations');
            click('btn-toggle-source');
            const sourceBeforeSearch = a.sourceTextareaEl.value;
            a.openSearch(); query('XYZ');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const searchViewport = a.sourceTextareaEl.getBoundingClientRect(), currentSourceRect = document.querySelector('.search-source-overlay mark.current').getBoundingClientRect();
            check(currentSourceRect.top >= searchViewport.top && currentSourceRect.bottom <= searchViewport.bottom, 'Source mode restores the active search result after deferred scrolling');
            check(count() === '1/5' && document.querySelectorAll('.search-source-overlay mark').length === 5 && document.querySelector('.search-source-overlay mark.current'), 'Source search has persistent yellow and current highlights');
            document.documentElement.dataset.theme = 'dark';
            check(getComputedStyle(document.querySelector('.search-source-overlay mark:not(.current)')).color === 'rgb(36, 36, 36)' && getComputedStyle(document.querySelector('.search-source-overlay mark.current')).backgroundColor === 'rgb(255, 155, 56)', 'Source highlights retain dark text on bright colors in dark theme');
            document.documentElement.dataset.theme = 'light';
            replacement.value = '替换😀$1'; click('btn-search-replace-all');
            check(a.isEdited && count() === '无匹配' && !a.sourceTextareaEl.value.includes('XYZ') && a.sourceTextareaEl.value.split('替换😀$1').length === 6, 'Replace All uses literal Unicode replacement and all five source matches');
            a.sourceTextareaEl.focus(); document.execCommand('undo');
            check(a.sourceTextareaEl.value === sourceBeforeSearch, 'Source Replace All is one native undo operation');
            a.searchController.performSearch(); query(String.fromCharCode(92, 92));
            check(count() === '1/1' && document.querySelector('.search-source-overlay mark').textContent === String.fromCharCode(92,92), 'Two literal backslashes are visible and highlighted in source');
            replacement.value = ''; click('btn-search-replace');
            check(!a.sourceTextareaEl.value.includes(String.fromCharCode(92,92)), 'Empty replacement deletes the selected match');
            a.sourceTextareaEl.focus(); document.execCommand('undo');
            check(a.sourceTextareaEl.value === sourceBeforeSearch, 'Empty replacement can be undone');
            query('XYZ');
            a.sourceTextareaEl.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'中'}));
            const beforeIMEReplace = a.sourceTextareaEl.value;
            click('btn-search-replace-all');
            check(a.sourceTextareaEl.value === beforeIMEReplace, 'Replacement is blocked during document composition');
            a.sourceTextareaEl.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'中'}));
            check(await a.saveCurrentFile() && (await api.readFile(root + '/查找替换.md')).content === sourceBeforeSearch, 'Search/undo roundtrip saves exact real disk bytes without decorations');
            await a.toggleEditMode(); a.searchController.refresh();
            check(document.getElementById('btn-search-replace').disabled && document.getElementById('btn-search-replace-all').disabled, 'Read mode disables replacement');
            const searchTab = a.activeTab;
            const cleanTab = a.createTab({rawContent:'# B 独有标记',isEditMode:true,isSourceMode:true}); a.switchTab(cleanTab.id);
            query('XYZ'); click('btn-search-replace-all');
            check(count() === '无匹配' && a.sourceTextareaEl.value === '# B 独有标记' && !cleanTab.isEdited, 'Switching tabs drops all old matches before replacement');
            await a.closeTab(cleanTab.id); a.switchTab(searchTab.id);
            a.searchController.close();
            await a.loadFile(root + '/自动保存.md');
            if (!a.isSourceMode) click('btn-toggle-source');
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const waitFor = async predicate => {
              for (let i = 0; i < 80; i++) {
                if (predicate()) return;
                await wait(50);
              }
            };
            const realWrite = api.writeFile;
            let writes = 0;
            api.writeFile = async (...args) => { writes++; return realWrite(...args); };
            const setSaveMode = mode => { a.selectSaveModeEl.value = mode; a.selectSaveModeEl.dispatchEvent(new Event('change')); };
            const typeSource = value => { a.sourceTextareaEl.value = value; a.sourceTextareaEl.dispatchEvent(new InputEvent('input', {bubbles:true,data:value})); };
            check(a.selectSaveModeEl.value === 'manual', 'Save mode defaults to manual for existing settings');
            typeSource('# 手动修改\\n'); await wait(1150);
            check(writes === 0 && a.isEdited && (await api.readFile(root + '/自动保存.md')).content === '# 自动保存测试\\n', 'Manual mode never writes on input');
            check(await a.saveCurrentFile() && writes === 1 && !a.isEdited, 'Manual save works with save setting');
            await a.saveCurrentFile(); check(writes === 1, 'Unmodified save does not rewrite the file');
            setSaveMode('auto');
            typeSource('# 自动修改一\\n'); await wait(300); typeSource('# 自动修改二\\n'); await wait(700);
            check(writes === 1 && a.isEdited, 'Auto save waits for idle after the latest edit');
            await waitFor(() => writes === 2 && !a.isEdited);
            check(writes === 2 && !a.isEdited && (await api.readFile(root + '/自动保存.md')).content === '# 自动修改二\\n', 'Auto save writes latest source through real filesystem bridge');
            typeSource('# 等待手动保存\\n'); setSaveMode('manual'); await wait(1150);
            check(writes === 2 && a.isEdited, 'Switching to manual cancels a pending auto save');
            check(await a.saveCurrentFile(), 'Manual save remains available after disabling auto save');
            setSaveMode('auto');
            a.sourceTextareaEl.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'中'}));
            typeSource('# 中文输入\\n'); const beforeComposition = writes; await wait(1150);
            check(writes === beforeComposition && a.isEdited, 'No automatic write during unfinished composition');
            a.sourceTextareaEl.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'中文'})); await waitFor(() => writes === beforeComposition + 1 && !a.isEdited);
            check(writes === beforeComposition + 1 && !a.isEdited, 'Automatic write resumes after composition ends');
            let failures = 0;
            api.writeFile = async () => { failures++; return {success:false,error:'Test save denied'}; };
            typeSource('# 必须保留\\n'); await waitFor(() => failures === 1 && a.errorBannerEl.textContent.includes('Test save denied'));
            check(failures === 1 && a.isEdited && a.errorBannerEl.textContent.includes('Test save denied'), 'Failed auto save keeps local edits and displays error: ' + JSON.stringify({failures,edited:a.isEdited,error:a.errorBannerEl.textContent,paused:a.autoSavePaused}));
            typeSource('# 继续保留\\n'); await wait(1150);
            check(failures === 1 && a.isEdited, 'Failure pauses automatic retries');
            const confirmSave = api.confirmSaveDialog, closeWindow = api.closeWindow;
            let closed = false;
            api.confirmSaveDialog = async () => ({action:'save'});
            api.closeWindow = async () => { closed = true; return {success:true}; };
            await a.loadFile(root + '/未命名.md'); await a.handleRequestClose();
            check(a.currentFilePath === root + '/自动保存.md' && a.sourceTextareaEl.value === '# 继续保留\\n' && !closed, 'Failed save blocks file switching and window closing');
            api.confirmSaveDialog = confirmSave; api.closeWindow = closeWindow;
            api.writeFile = realWrite;
            check(await a.saveCurrentFile() && !a.isEdited, 'Manual retry recovers after auto save failure');
            click('btn-toggle-source');
            const autoHeading = a.markdownBodyEl.querySelector('h1');
            autoHeading.textContent = '渲染自动保存'; autoHeading.dispatchEvent(new InputEvent('input', {bubbles:true,data:'渲染自动保存'}));
            await waitFor(() => !a.isEdited);
            check(!a.isEdited && (await api.readFile(root + '/自动保存.md')).content === '# 渲染自动保存\\n', 'Rendered text auto save uses live DOM');
            click('btn-toggle-source');
            typeSource('# 代码自动保存\\n\\n```python\\nprint(1)\\n```\\n'); click('btn-toggle-source');
            const autoCode = a.markdownBodyEl.querySelector('textarea.code-editor');
            autoCode.value = 'print("自动保存")'; autoCode.dispatchEvent(new InputEvent('input', {bubbles:true,data:'自动保存'}));
            await waitFor(() => !a.isEdited);
            check(!a.isEdited && (await api.readFile(root + '/自动保存.md')).content.includes('```python\\nprint("自动保存")\\n```'), 'Rendered code auto save preserves live code and fence separator');
            click('btn-toggle-source');
            if (\(usingProductionBridge)) {
              const diskBefore = await api.readFile(root + '/自动保存.md');
              const staleWrite = await api.writeFile(root + '/自动保存.md', '# must not overwrite', 'stale-revision');
              check(!staleWrite.success && (await api.readFile(root + '/自动保存.md')).content === diskBefore.content, 'Native fingerprint guard rejects stale disk revision');
            }
            typeSource('# 本地未保存\\n');
            await realWrite(root + '/自动保存.md', '# 外部更新\\n'); await wait(1450);
            check(a.isEdited && a.sourceTextareaEl.value === '# 本地未保存\\n' && (await api.readFile(root + '/自动保存.md')).content === '# 外部更新\\n', 'Automatic save never overwrites detected external changes');
            api.writeFile = realWrite;
            await a.loadFile(root + '/未命名.md');
            a.handleMenuAction('settings');
            check(a.settingsDialogEl.open, 'Settings opens');
            check(getComputedStyle(a.selectWidthEl).display !== 'none', 'Reading width is visible at 500px window size');
            a.selectWidthEl.value = 'wide'; a.selectWidthEl.dispatchEvent(new Event('change'));
            check(a.markdownBodyWrapperEl.classList.contains('width-wide'), 'Reading width setting applies');
            a.selectThemeEl.value = 'dark'; a.selectThemeEl.dispatchEvent(new Event('change'));
            a.settingsFontSizeEl.value = '20'; a.settingsFontSizeEl.dispatchEvent(new Event('change'));
            check(document.documentElement.dataset.theme === 'dark' && a.markdownBodyEl.style.fontSize === '20px', 'Settings applies');
            a.settingsFontSizeEl.value = '99'; a.settingsFontSizeEl.dispatchEvent(new Event('change'));
            check(a.settingsFontSizeEl.value === '28', 'Font clamp');
            a.settingsFontSizeEl.value = '20'; a.settingsFontSizeEl.dispatchEvent(new Event('change'));
            click('btn-close-settings'); click('tab-files');
            await window.electronAPI.saveSettings(a.currentSettings);
            window.webkit.messageHandlers.nativeAPI.postMessage({id:'reload-tests',action:'test:reload',payload:{checks}});
          } catch (error) {
            window.webkit.messageHandlers.testResult.postMessage({success:false,detail:String(error) + '\\n' + (error.stack || '')});
          }
        })();
        """) { [weak self] _, error in
            if let error { self?.finish(false, "JavaScript execution: \(error)") }
        }
    }

    func finish(_ success: Bool, _ detail: String) {
        guard !completed else { return }
        completed = true
        timer?.invalidate()
        print(detail)
        try? FileManager.default.removeItem(at: fixtures)
        exit(success ? 0 : 1)
    }
}

@main
struct TestRendererSuite {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = RendererTests()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
