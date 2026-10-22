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
    var lastCheck = "renderer startup"
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
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
#if MOREAD_BRIDGE_INTEGRATION
        productionHost.webView = webView
        productionHost.window = window
        productionBridge.windowController = productionHost
        productionBridge.authorizeDirectory(fixtures.path)
#endif
        let renderer = CommandLine.arguments.count > 1 ? URL(fileURLWithPath: CommandLine.arguments[1]) : Bundle.main.resourceURL!.appendingPathComponent("web")
        let url = renderer.appendingPathComponent("index.html")
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            if let self, !self.completed {
                self.webView.evaluateJavaScript("JSON.stringify({visibility:document.visibilityState,frames:window.__frameProbe||0})") { value, _ in
                    self.finish(false, "Timed out after: \(self.lastCheck); window visible=\(self.window.isVisible), occlusion=\(self.window.occlusionState.rawValue); \(String(describing: value))")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "testResult", let body = message.body as? [String: Any] {
            finish(body["success"] as? Bool ?? false, body["detail"] as? String ?? "No detail")
            return
        }
        guard let body = message.body as? [String: Any], let id = body["id"] as? String, let action = body["action"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        if action == "test:checkpoint" {
            lastCheck = payload["detail"] as? String ?? "unknown check"
            return
        }
#if MOREAD_BRIDGE_INTEGRATION
        if ["fs:read-file", "fs:read-folder", "fs:write-file", "fs:unwatch-file"].contains(action) {
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
        let readiness = phase == 2 ? "Boolean(window.moreadApp && window.moreadApp.currentSettings.theme && !window.__rendererTestInitial)" : "Boolean(window.moreadApp && window.moreadApp.currentSettings.theme && document.visibilityState === 'visible')"
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

    let pasteRegressionScript = #"""
    async (a, api, root, check) => {
      const file = root + '/正文粘贴.md';
      const baseline = '# 原文标题\n\n前缀 TARGET 后缀\n\n尾部保留。\n';
      const originalConfirm = api.confirmSaveDialog;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const select = (node, start, end = start) => {
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      };
      const paste = (target, text, html) => {
        target.focus();
        const data = new DataTransfer();
        if (text !== null) data.setData('text/plain', text);
        if (html) data.setData('text/html', html);
        const event = new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data});
        target.dispatchEvent(event);
        // Synthetic clipboard events have no default editing action. Emulate the old plaintext path.
        if (!event.defaultPrevented && target === a.markdownBodyEl && a.isEditMode) document.execCommand('insertText', false, text || '');
        return event;
      };
      const reset = text => {
        a.setSourceMode(true); a.sourceTextareaEl.value = text; a.markAsEdited(); a.setSourceMode(false);
      };
      const append = () => { a.markdownBodyEl.focus(); const range = document.createRange(); range.selectNodeContents(a.markdownBodyEl); range.collapse(false); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); };
      try {
        api.confirmSaveDialog = async () => ({action:'dont-save'});
        a.selectSaveModeEl.value = 'manual'; a.selectSaveModeEl.dispatchEvent(new Event('change'));
        await api.writeFile(file, baseline); await a.loadFile(file); await a.setEditMode(true); a.setSourceMode(false);
        const paragraph = a.markdownBodyEl.querySelector('p').firstChild;
        select(paragraph, 3, 9);
        const before = a.getTabContent(a.activeTab);
        const markdown = '**公式编号与 Label 规范**\n\n- ✅ **默认不滥用编号**：使用 `equation*` / `align*`。\n- ✅ **精准加标**：保留 `\\label{eq:one}`。\n\n行内 $x+1$。\n\n$$\nx^2+y^2=1\n$$\n\n```python\nprint("中文")\n    # indent\n```\n';
        const event = paste(a.markdownBodyEl, markdown, '<pre><code>clipboard editor formatting</code></pre>');
        check(event.defaultPrevented && a.markdownBodyEl.querySelector('strong')?.textContent === '公式编号与 Label 规范', 'Rendered paste must interpret Markdown immediately instead of leaving literal asterisks: ' + a.markdownBodyEl.innerHTML.slice(0,700));
        check(a.markdownBodyEl.querySelectorAll('li').length === 2 && a.markdownBodyEl.querySelectorAll('li strong').length === 2, 'Pasted lists and nested emphasis render immediately');
        check(a.markdownBodyEl.querySelector('p').textContent.includes('前缀') && a.markdownBodyEl.textContent.includes('后缀') && a.markdownBodyEl.textContent.includes('尾部保留。') && !a.markdownBodyEl.textContent.includes('TARGET'), 'Paste replaces only the selection and preserves neighboring text');
        check(a.markdownBodyEl.querySelector('.math-inline-wrapper svg') && a.markdownBodyEl.querySelector('.math-block-wrapper svg'), 'Pasted inline and display formulas render');
        check(a.markdownBodyEl.querySelector('.math-inline-wrapper').getAttribute('role') === 'button', 'New formula remains editable');
        check(a.markdownBodyEl.querySelector('textarea.code-editor')?.value === 'print("中文")\n    # indent' && a.markdownBodyEl.querySelector('input.code-lang').value === 'python', 'Pasted fence preserves code, indentation and language');
        check(a.isEdited && a.statusSaveBadgeEl.textContent === '未保存', 'Rendered paste marks its document dirty');
        const inserted = a.getTabContent(a.activeTab);
        check(inserted.includes('**公式编号与 Label 规范**') && inserted.includes('`\\label{eq:one}`') && inserted.includes('$$\nx^2+y^2=1\n$$'), 'Pasted Markdown serializes without escaping formatting or formula sources');
        document.execCommand('undo');
        check(a.getTabContent(a.activeTab) === before, 'One native undo restores the pre-paste selection and document: ' + JSON.stringify({before,after:a.getTabContent(a.activeTab),html:a.markdownBodyEl.innerHTML}));
        await wait(0); document.execCommand('redo'); await wait(0);
        check(a.getTabContent(a.activeTab) === inserted, 'Native redo restores formatted paste and code values');
        check([...a.markdownBodyEl.querySelectorAll('[data-paste-protected]')].every(node => node.contentEditable === 'false'), 'Formula and code protection is restored after native redo');
        check(await a.saveCurrentFile(), 'Rendered paste saves successfully');
        const disk = await api.readFile(file);
        check(disk.content === inserted && !disk.content.includes('clipboard editor formatting'), 'Real disk save matches rendered Markdown rather than clipboard HTML');
        a.setSourceMode(true);
        check(a.sourceTextareaEl.value === inserted, 'Switching to source preserves pasted Markdown');
        a.setSourceMode(false);
        check(a.markdownBodyEl.querySelectorAll('li').length === 2 && a.markdownBodyEl.querySelector('.math-block-wrapper svg'), 'Pasted content survives source/body roundtrip');

        reset('左 TARGET 右\n');
        select(a.markdownBodyEl.querySelector('p').firstChild, 2, 8);
        paste(a.markdownBodyEl, '**加粗** 与 `行内代码`');
        check(a.markdownBodyEl.querySelectorAll('p').length === 1 && a.markdownBodyEl.querySelector('p').textContent.replace(/\u00a0/g, ' ') === '左 加粗 与 行内代码 右', 'Inline Markdown stays in the surrounding paragraph: ' + JSON.stringify({html:a.markdownBodyEl.innerHTML,markdown:a.getTabContent(a.activeTab)}));
        check(a.markdownBodyEl.querySelector('strong') && a.markdownBodyEl.querySelector('code'), 'Inline formatting is immediately visible');
        reset('含有 `TARGET` 的代码。\n');
        select(a.markdownBodyEl.querySelector('code').firstChild, 0, 6);
        paste(a.markdownBodyEl, '**literal**');
        check(a.markdownBodyEl.querySelector('code').textContent === '**literal**' && !a.markdownBodyEl.querySelector('code strong'), 'Pasting into inline code keeps literal Markdown');

        reset('# 重复标题\n\n末尾\n'); append();
        paste(a.markdownBodyEl, '\n# 重复标题\n\n## 子节\n');
        const headings = [...a.markdownBodyEl.querySelectorAll('h1,h2')];
        check(headings.length === 3 && new Set(headings.map(h => h.id)).size === 3, 'Pasted duplicate headings get distinct anchors');
        check([...a.outlineContentEl.querySelectorAll('a')].length === 3 && [...a.outlineContentEl.querySelectorAll('a')].every(link => headings.some(h => '#'+h.id === link.getAttribute('href'))), 'Outline immediately includes pasted headings with working anchors');
        document.execCommand('undo');
        check(a.outlineContentEl.querySelectorAll('a').length === 1, 'Undo removes pasted headings from the outline');

        reset('保留文档。\n'); append();
        window.__pasteInjected = false;
        paste(a.markdownBodyEl, '\n**安全文本**\n\n<img src="https://example.invalid/paste.png" onerror="window.__pasteInjected=true"><script>window.__pasteInjected=true</script>');
        await wait(50);
        check(!window.__pasteInjected && !a.markdownBodyEl.querySelector('script, [onerror]'), 'Paste sanitizes executable Markdown HTML');
        check(!a.markdownBodyEl.querySelector('img[src^="https://"]') && a.markdownBodyEl.querySelector('.remote-image-blocked'), 'Paste respects blocked network image settings');
        reset('富文本 TARGET 尾部\n');
        select(a.markdownBodyEl.querySelector('p').firstChild, 4, 10);
        paste(a.markdownBodyEl, null, '<strong>加粗网页文字</strong>');
        check(a.markdownBodyEl.querySelector('strong')?.textContent === '加粗网页文字' && a.markdownBodyEl.textContent.includes('尾部'), 'HTML-only clipboard has a sanitized Markdown fallback');

        reset('开头保留。\n'); append();
        paste(a.markdownBodyEl, '\r\n> 引用 **粗体**\r\n\r\n| 参数 | 数值 |\r\n| --- | --- |\r\n| alpha | 1 |\r\n\r\n- [ ] 未完成\r\n- [x] 已完成\r\n');
        check(a.markdownBodyEl.querySelector('blockquote strong')?.textContent === '粗体' && a.markdownBodyEl.querySelectorAll('table tr').length === 2, 'CRLF clipboard renders quotes and GFM tables: ' + JSON.stringify({html:a.markdownBodyEl.innerHTML,markdown:a.getTabContent(a.activeTab)}));
        check(a.markdownBodyEl.querySelectorAll('.task-list-item-checkbox').length === 2 && a.markdownBodyEl.querySelector('.task-list-item-checkbox[checked]'), 'Pasted task list preserves completion states');
        reset('结尾粘贴\n'); append();
        paste(a.markdownBodyEl, '\n```text\nliteral **code**\n```\n');
        const codeAfterPaste = a.markdownBodyEl.querySelector('textarea.code-editor');
        check(codeAfterPaste.value === 'literal **code**', 'Fence paste at document end keeps Markdown literal');
        const codeClipboard = new DataTransfer(); codeClipboard.setData('text/plain', '\n**still code**');
        codeAfterPaste.focus(); codeAfterPaste.setSelectionRange(codeAfterPaste.value.length, codeAfterPaste.value.length);
        codeAfterPaste.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:codeClipboard}));
        check(codeAfterPaste.value === 'literal **code**\n**still code**' && !a.markdownBodyEl.querySelector('.code-block-container strong'), 'Nested code editor keeps its existing plaintext paste behavior');

        reset('空文本剪贴板\n'); append();
        paste(a.markdownBodyEl, '', '<strong>HTML 内容</strong><img src="https://example.invalid/clipboard.png" onerror="window.__pasteInjected=true">');
        check(a.markdownBodyEl.querySelector('strong')?.textContent === 'HTML 内容', 'Empty plaintext clipboard uses its HTML content instead of dropping it');
        check(!a.markdownBodyEl.querySelector('img[src^="https://"], [onerror]') && a.markdownBodyEl.querySelector('.remote-image-blocked') && !window.__pasteInjected, 'HTML fallback keeps image privacy and script sanitization');

        reset('只读文档\n'); await a.saveCurrentFile(); await a.setEditMode(false);
        append(); const unchanged = a.markdownBodyEl.innerHTML;
        const readEvent = paste(a.markdownBodyEl, '**must not insert**');
        check(!readEvent.defaultPrevented && a.markdownBodyEl.innerHTML === unchanged && !a.isEdited, 'Read mode rejects rendered paste edits');
        await a.setEditMode(true); a.setSourceMode(true);
        const sourceEvent = paste(a.sourceTextareaEl, '**source stays literal**');
        check(!sourceEvent.defaultPrevented, 'Source textarea retains native plain text paste');
        a.setSourceMode(false); append();
        a.markdownBodyEl.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'中'}));
        const composingData = new DataTransfer(); composingData.setData('text/plain','**输入中**');
        const composing = new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:composingData});
        a.markdownBodyEl.dispatchEvent(composing);
        check(!composing.defaultPrevented, 'Rendered Markdown conversion does not interrupt an unfinished IME composition');
        a.markdownBodyEl.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
        await a.closeTab(a.activeTab.id);
      } finally { api.confirmSaveDialog = originalConfirm; }
    }
    """#

    let bugRegressionScript = #"""
    async (a, api, root, check) => {
      const originalConfirm = api.confirmSaveDialog;
      const originalSaveDraft = api.saveDraft, originalGetDrafts = api.getAllDrafts, originalDeleteDraft = api.deleteDraft;
      const originalEdited = api.setDocumentEdited, originalUnwatch = api.unwatchFile;
      const drafts = new Map(), unwatched = [];
      let nativeDirty = false;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      api.confirmSaveDialog = async () => ({action:'dont-save'});
      api.saveDraft = async draft => { drafts.set(draft.id, structuredClone(draft)); return {success:true}; };
      api.getAllDrafts = async () => ({drafts:[...drafts.values()]});
      api.deleteDraft = async id => { drafts.delete(id); return {success:true}; };
      api.setDocumentEdited = async dirty => { nativeDirty = dirty; return originalEdited(dirty); };
      api.unwatchFile = async path => { unwatched.push(path); return originalUnwatch ? originalUnwatch(path) : {success:true}; };
      try {
        a.selectSaveModeEl.value = 'manual'; a.selectSaveModeEl.dispatchEvent(new Event('change'));
        for (const tab of [...a.tabs]) check(await a.closeTab(tab.id), 'Close preexisting tab without losing test isolation');
        const original = '# Exact source\n\n[reference][ref]\n\n[ref]: https://example.com\n\n<!-- retain comment -->\n';
        await api.writeFile(root + '/roundtrip.md', original);
        a.currentSettings.openMode = 'read';
        await a.loadFile(root + '/roundtrip.md');
        a.toggleSourceView();
        check(a.sourceTextareaEl.value === original && !a.isEdited, 'Read-only source toggle preserves references and comments byte for byte');
        const paths = ['multi-A.md','multi-B.md','multi-C.md'].map(name => root + '/' + name);
        for (const path of paths) await api.writeFile(path, '# ' + path + '\n');
        await Promise.all(paths.map(path => a.loadFile(path)));
        check(paths.every(path => a.tabs.some(tab => tab.filePath === path)), 'Concurrent open retains all three files');

        const tab = a.tabs.find(tab => tab.filePath === paths[0]);
        a.switchTab(tab.id);
        if (!a.isEditMode) await a.toggleEditMode();
        if (!a.isSourceMode) a.toggleSourceView();
        a.sourceTextareaEl.value = '# recover this edit\n'; a.markAsEdited();
        a.switchTab(a.tabs.find(tab => tab.filePath === paths[1]).id);
        await wait(1750);
        check([...drafts.values()].some(draft => draft.filePath === paths[0] && draft.content === '# recover this edit\n' && typeof draft.savedContent === 'string'), 'Draft debounce retains inactive document and disk baseline');
        check(nativeDirty, 'Inactive dirty document keeps native window dirty');
        api.confirmSaveDialog = async () => ({action:'cancel'});
        check(!await a.prepareToClose() && a.tabs.includes(tab) && tab.isEdited, 'Quit cancellation retains the dirty document');
        api.confirmSaveDialog = async () => ({action:'dont-save'});
        check(await a.prepareToClose() && a.isPreparedToClose(), 'Explicit discard permits close approval');
        a.switchTab(tab.id); a.sourceTextareaEl.value += 'later edit\n'; a.markAsEdited();
        check(!a.isPreparedToClose(), 'A later edit invalidates an earlier application quit approval');
        check(await a.closeTab(tab.id) && unwatched.includes(paths[0]), 'Closing the last tab for a path releases its watcher');
        check(!nativeDirty, 'Closing the only dirty tab resets native dirty state');

        window.__draftFilenameExecuted = false;
        const hostileName = 'x<img src=x onerror="window.__draftFilenameExecuted=true">.md';
        a.renderDraftRecoveryList([{id:'hostile', filePath:hostileName, content:'# harmless', timestamp:Date.now()}]);
        await wait(150);
        check(a.draftRecoveryListEl.textContent.includes(hostileName) && !a.draftRecoveryListEl.querySelector('img') && !window.__draftFilenameExecuted, 'Draft filenames display as text without executing HTML');
        const hostileDraft = {id:'hostile-preview', filePath:hostileName, content:'<img src=x onerror="window.__draftFilenameExecuted=true">\n# 草稿正文', timestamp:1};
        const otherDraft = {id:'leave-this-draft', content:'# Keep this draft', timestamp:2};
        drafts.set(hostileDraft.id, hostileDraft); drafts.set(otherDraft.id, otherDraft);
        await a.checkCrashRecoveryDrafts(true);
        check(a.draftRecoveryDialogEl.open && document.getElementById('btn-recover-drafts').disabled, 'Recovery opens with no destructive default selection');
        check(document.getElementById('draft-recovery-preview').textContent.includes(hostileDraft.content) && !document.getElementById('draft-recovery-preview').querySelector('img'), 'Preview shows literal untrusted draft text');
        document.getElementById('btn-later-drafts').click();
        check(!a.draftRecoveryDialogEl.open && drafts.has(hostileDraft.id) && drafts.has(otherDraft.id), 'Later preserves every draft');
        a.openSettings(); document.getElementById('btn-manage-drafts').click();
        await wait(100);
        check(a.draftRecoveryDialogEl.open && !a.settingsDialogEl.open, 'Settings reopens recovery after Later');
        const row = [...a.draftRecoveryListEl.children].find(row => row.dataset.draftId === hostileDraft.id);
        row.querySelector('input').click();
        check(!document.getElementById('btn-recover-drafts').disabled && document.getElementById('btn-recover-drafts').textContent.includes('1'), 'Checkbox updates selected recovery count');
        await a.recoverSelectedDrafts();
        const recovered = a.tabs.find(tab => tab.recoveredDraftId === hostileDraft.id);
        check(recovered && recovered.filePath === null && recovered.rawContent === hostileDraft.content && drafts.has(otherDraft.id), 'Only selected draft restored intact as detached legacy copy');
        check(a.draftRecoveryDialogEl.open && a.draftRecoveryListEl.children.length === 1 && !window.__draftFilenameExecuted, 'Remaining draft stays available and preview caused no injection');
        const discard = a.draftRecoveryListEl.querySelector('.draft-item-discard');
        discard.click();
        check(drafts.has(otherDraft.id) && discard.textContent === '确认丢弃', 'Discard requires explicit second action');
        a.draftRecoveryListEl.querySelector('.draft-item-actions button:last-child').click();
        check(drafts.has(otherDraft.id) && discard.textContent === '丢弃', 'Cancel discard preserves draft');
        await a.discardRecoveryDraft(otherDraft);
        check(!drafts.has(otherDraft.id) && a.draftRecoveryListEl.children.length === 0 && document.getElementById('btn-recover-drafts').disabled, 'Individual discard updates the empty state');
        document.getElementById('btn-later-drafts').click();
        await a.closeTab(recovered.id);

        a.switchTab(a.tabs.find(tab => tab.filePath === paths[1]).id);
        await a.setEditMode(true); a.setSourceMode(true);
        a.sourceTextareaEl.value += '\n# saved state'; a.markAsEdited();
        const write = api.writeFile; let releaseSave;
        api.writeFile = (...args) => new Promise(resolve => { releaseSave = async () => resolve(await write(...args)); });
        const savingTab = a.activeTab, pendingSave = a.saveTab(savingTab);
        for (let i=0; i<50 && !releaseSave; i++) await wait(10);
        check(a.statusSaveBadgeEl.textContent === '正在保存…' && a.statusSavePolicyEl.textContent === '手动保存', 'Save progress and policy are visible');
        a.switchTab(a.tabs.find(tab => tab.filePath === paths[2]).id);
        check(a.statusSaveBadgeEl.textContent === '已保存', 'Other tab does not inherit saving state');
        await releaseSave(); await pendingSave; api.writeFile = write;
        a.switchTab(savingTab.id);
        await wait(2600);
        check(a.statusSaveBadgeEl.textContent === '已保存' && getComputedStyle(a.statusSaveBadgeEl).display !== 'none', 'Saved status remains visible after old timeout');


        a.switchTab(a.tabs.find(tab => tab.filePath === paths[1]).id);
        if (!a.isEditMode) await a.toggleEditMode();
        if (a.isSourceMode) a.toggleSourceView();
        const heading = a.markdownBodyEl.querySelector('h1');
        heading.textContent = 'unsaved rendered setting edit';
        heading.dispatchEvent(new InputEvent('input', {bubbles:true,data:'edit'}));
        a.selectRemoteImagesEl.value = a.selectRemoteImagesEl.value === 'allow' ? 'block' : 'allow';
        a.selectRemoteImagesEl.dispatchEvent(new Event('change'));
        check(a.markdownBodyEl.textContent.includes('unsaved rendered setting edit') && a.isEdited, 'Remote image setting preserves current rendered edits');
        check(await a.saveCurrentFile() && (await api.readFile(paths[1])).content.includes('unsaved rendered setting edit'), 'Preserved rendered edit reaches the correct disk file');
        for (const remaining of [...a.tabs]) await a.closeTab(remaining.id);
      } finally {
        api.confirmSaveDialog = originalConfirm;
        api.saveDraft = originalSaveDraft; api.getAllDrafts = originalGetDrafts; api.deleteDraft = originalDeleteDraft;
        api.setDocumentEdited = originalEdited; api.unwatchFile = originalUnwatch;
        a.currentSettings.openMode = 'edit';
        a.selectSaveModeEl.value = 'auto'; a.selectSaveModeEl.dispatchEvent(new Event('change'));
      }
    }
    """#

    func runInteractions() {
        let fixtureJSON = String(data: try! JSONSerialization.data(withJSONObject: [fixtures.path]), encoding: .utf8)!
        webView.evaluateJavaScript("""
        void (async () => {
          try {
            const root = \(fixtureJSON)[0], a = window.moreadApp;
            window.__rendererTestInitial = true;
            requestAnimationFrame(() => { window.__frameProbe = 1; });
            let checks = 0;
            const check = (ok, message) => { if (!ok) throw new Error(message); checks++; window.webkit.messageHandlers.nativeAPI.postMessage({id:'checkpoint',action:'test:checkpoint',payload:{detail:message}}); };
            const click = id => document.getElementById(id).click();
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const waitFor = async predicate => {
              for (let i = 0; i < 80; i++) {
                if (predicate()) return;
                await wait(50);
              }
            };
            check(document.querySelectorAll('.header-left button').length === 1, 'One sidebar button');
            check(document.querySelectorAll('.header-right button').length === 5 && document.querySelectorAll('.toolbar-segmented').length === 2 && !document.querySelector('.header-right select') && !document.getElementById('btn-settings') && !document.getElementById('btn-font-increase') && !document.querySelector('.status-left button'), 'Toolbar cleanup');
            check(document.getElementById('btn-welcome-new-file'), 'Welcome has new file action');
            check(['btn-mode-read','btn-toggle-edit','btn-view-rendered','btn-toggle-source','btn-search'].every(id => document.getElementById(id).disabled), 'Document controls disabled on welcome');
            click('btn-welcome-new-file');
            check(a.activeTab && !a.activeTab.filePath && a.isEditMode && a.markdownBodyEl.getAttribute('contenteditable') === 'true', 'Welcome new file is immediately editable');
            await a.closeTab(a.activeTab.id);
            check(document.getElementById('btn-toggle-edit').disabled && a.statusSaveBadgeEl.textContent === '未打开文件', 'Closing last tab clears mode and save status');
            await a.loadFile(root + '/未命名.md');
            check(a.docTitleEl.textContent === '未命名.md' && a.filesContentEl.textContent.includes('未命名.md'), 'Standalone file list');
            const pressed = id => document.getElementById(id).getAttribute('aria-pressed') === 'true';
            click('btn-mode-read'); await waitFor(() => !a.isEditMode);
            check(pressed('btn-mode-read') && pressed('btn-view-rendered') && a.sourceTextareaEl.readOnly, 'Read/body mode is explicit');
            click('btn-toggle-source'); click('btn-toggle-source');
            check(a.isSourceMode && !a.isEditMode && pressed('btn-toggle-source') && a.sourceTextareaEl.readOnly, 'Read/source selection is idempotent');
            click('btn-toggle-edit'); click('btn-toggle-edit');
            check(a.isEditMode && a.isSourceMode && pressed('btn-toggle-edit') && !a.sourceTextareaEl.readOnly, 'Edit/source selection is idempotent');
            click('btn-view-rendered');
            check(a.isEditMode && !a.isSourceMode && pressed('btn-view-rendered') && a.markdownBodyEl.contentEditable === 'true', 'Edit/body mode is explicit');
            check([...document.querySelectorAll('.header-right button')].every(el => el.getBoundingClientRect().right <= innerWidth), 'Mode controls fit the narrow native window');
            await (\(pasteRegressionScript))(a, window.electronAPI, root, check);

            click('btn-toggle-sidebar'); click('tab-files'); click('btn-toggle-sidebar'); click('btn-toggle-sidebar');
            check(a.filesTabBtn.classList.contains('active') && a.btnToggleSidebarEl.getAttribute('aria-expanded') === 'true', 'Tab survives collapse');
            click('tab-outline');
            check([...document.querySelectorAll('.outline-link')].map(x => x.textContent).join('|') === '1. 第一节|2. 第二节|3. 第三节', 'Visible numbered outline');
            check([...document.querySelectorAll('.outline-link')].every(x => document.getElementById(x.getAttribute('href').slice(1))), 'Heading anchors');
            click('btn-toggle-source'); click('btn-view-rendered');
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
            click('btn-view-rendered');
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
            click('btn-view-rendered');
            await a.loadFile(root + '/公式.md');
            if (a.isSourceMode) click('btn-view-rendered');
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
            click('btn-view-rendered');
            check(a.markdownBodyEl.querySelector('.math-block-wrapper').getAttribute('data-raw-formula') === 'z=3', 'Math roundtrip preserves block source');
            check(await a.saveCurrentFile(), 'Save both math edits');
            await a.toggleEditMode();
            check(!a.isEditMode, 'Finish editing responds on first call');
            a.markdownBodyEl.querySelector('.math-inline-wrapper').click();
            check(!a.markdownBodyEl.querySelector('textarea.math-editor'), 'Read mode cannot change a formula');
            await a.loadFile(root + '/查找替换.md');
            if (a.isSourceMode) click('btn-view-rendered');
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
            const failedSaveTab = a.activeTab;
            await a.loadFile(root + '/未命名.md'); await a.handleRequestClose();
            check(a.tabs.includes(failedSaveTab) && failedSaveTab.isEdited && failedSaveTab.rawContent === '# 继续保留\\n' && !closed, 'Opening another tab retains failed-save edits and failed save blocks window closing');
            api.confirmSaveDialog = confirmSave; api.closeWindow = closeWindow;
            api.writeFile = realWrite;
            a.switchTab(failedSaveTab.id);
            check(await a.saveCurrentFile() && !a.isEdited, 'Manual retry recovers after auto save failure');
            click('btn-view-rendered');
            const autoHeading = a.markdownBodyEl.querySelector('h1');
            autoHeading.textContent = '渲染自动保存'; autoHeading.dispatchEvent(new InputEvent('input', {bubbles:true,data:'渲染自动保存'}));
            await waitFor(() => !a.isEdited);
            check(!a.isEdited && (await api.readFile(root + '/自动保存.md')).content === '# 渲染自动保存\\n', 'Rendered text auto save uses live DOM');
            click('btn-toggle-source');
            typeSource('# 代码自动保存\\n\\n```python\\nprint(1)\\n```\\n'); click('btn-view-rendered');
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
            await (\(bugRegressionScript))(a, api, root, check);
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
        if CommandLine.arguments.count == 1 {
            try? detail.write(to: Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("renderer-result.log"), atomically: true, encoding: .utf8)
        }
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
        app.setActivationPolicy(.regular)
        app.run()
    }
}
