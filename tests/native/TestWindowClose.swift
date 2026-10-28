import Cocoa
import WebKit

// Compile with run-window-close.py to redirect all application storage to a temporary directory.
@MainActor
final class WindowCloseTests {
    let delegate = AppDelegate()
    var passed = 0
    var nativeCancelClicked = false

    func findButton(_ title: String, in view: NSView) -> NSButton? {
        if let button = view as? NSButton, button.title == title { return button }
        return view.subviews.lazy.compactMap { self.findButton(title, in: $0) }.first
    }

    func check(_ condition: Bool, _ message: String) {
        guard condition else { print("FAIL: \(message)"); exit(1) }
        passed += 1
        print("PASS: \(message)")
    }

    func clickSheetButton(_ title: String, window: NSWindow) -> Timer {
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self, weak window] timer in
            MainActor.assumeIsolated {
                guard let self, let content = window?.attachedSheet?.contentView,
                      let button = self.findButton(title, in: content) else { return }
                button.performClick(nil)
                timer.invalidate()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.add(timer, forMode: .modalPanel)
        return timer
    }

    func javascript(_ controller: MainWindowController, _ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            controller.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) {
                continuation.resume(with: $0)
            }
        }
    }

    func run() async throws {
        print("Loading production window")
        for _ in 0..<100 {
            if let controller = delegate.activeWindowController,
               (try? await javascript(controller, "return Boolean(window.moreadApp?.currentSettings.theme);")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let controller = delegate.activeWindowController, let window = controller.window else {
            check(false, "Production window did not load"); return
        }
        _ = try await javascript(controller, """
            const a = window.moreadApp;
            a.openNewEmptyTab();
            if (!a.isSourceMode) a.toggleSourceView();
            a.sourceTextareaEl.value = '# unsaved window content'; a.markAsEdited();
            window.__closePrompts = 0;
            window.__originalConfirmSave = window.electronAPI.confirmSaveDialog;
            window.electronAPI.confirmSaveDialog = async () => { window.__closePrompts++; return {action:'cancel'}; };
            // Deliberately stale native flag: renderer state must still protect this document.
            await window.electronAPI.setDocumentEdited(false);
            """)
        check(!controller.windowShouldClose(window), "Native close waits for renderer even when dirty flag is stale")
        try await Task.sleep(nanoseconds: 350_000_000)
        let cancelState = try await javascript(controller, "return window.__closePrompts === 1 && window.moreadApp.isEdited;") as? Bool
        check(cancelState == true && delegate.windowControllers.contains(where: { $0 === controller }), "Canceled native close preserves window and edits")

        _ = try await javascript(controller, "window.electronAPI.confirmSaveDialog = window.__originalConfirmSave;")
        let cancelTimer = Timer(timeInterval: 0.1, repeats: true) { [weak self, weak window] timer in
            MainActor.assumeIsolated {
                guard let self, let content = window?.attachedSheet?.contentView,
                      let button = self.findButton("取消", in: content) else { return }
                self.nativeCancelClicked = true
                button.performClick(nil)
                timer.invalidate()
            }
        }
        RunLoop.main.add(cancelTimer, forMode: .common)
        RunLoop.main.add(cancelTimer, forMode: .modalPanel)
        DispatchQueue.main.async { NSApp.terminate(nil) }
        try await Task.sleep(nanoseconds: 700_000_000)
        cancelTimer.invalidate()
        let quitState = try await javascript(controller, "return window.moreadApp.isEdited;") as? Bool
        check(nativeCancelClicked && quitState == true && delegate.windowControllers.count == 1, "Actual NSApplication termination shows a native save sheet and cancellation retains edits")

        _ = try await javascript(controller, "window.__originalSaveAs = window.electronAPI.saveAsDialog; window.electronAPI.confirmSaveDialog = async () => ({action:'save'}); window.electronAPI.saveAsDialog = async () => ({canceled:false,success:false,error:'Synthetic write failure'});")
        DispatchQueue.main.async { NSApp.terminate(nil) }
        try await Task.sleep(nanoseconds: 450_000_000)
        let failureState = try await javascript(controller, "return window.moreadApp.isEdited && window.moreadApp.errorBannerEl.textContent.includes('Synthetic write failure');") as? Bool
        check(failureState == true && delegate.windowControllers.count == 1, "Failed Save As aborts actual application termination")

        let documents = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("Documents/Moread")
        _ = try await javascript(controller, "window.electronAPI.saveAsDialog = window.__originalSaveAs; window.electronAPI.confirmSaveDialog = window.__originalConfirmSave;")
        let saveCancelTimer = clickSheetButton("取消", window: window)
        let saveCanceled = try await javascript(controller, "return await window.moreadApp.saveCurrentFile();") as? Bool
        saveCancelTimer.invalidate()
        check(saveCanceled == false && !FileManager.default.fileExists(atPath: documents.path), "Canceling the new save choices preserves the untitled document without creating files")
        let chooseTimer = clickSheetButton("选择位置…", window: window)
        _ = try await javascript(controller, "window.__chooseResult = window.moreadApp.saveCurrentFile();")
        for _ in 0..<40 {
            if window.attachedSheet is NSSavePanel { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        chooseTimer.invalidate()
        check(window.attachedSheet is NSSavePanel, "Choose Location still opens the original native save panel")
        (window.attachedSheet as? NSSavePanel)?.cancel(nil)
        let chooseCanceled = try await javascript(controller, "return await window.__chooseResult;") as? Bool
        check(chooseCanceled == false, "Canceling the location panel retains the untitled edits")
        let documentsTimer = clickSheetButton("保存到文稿", window: window)
        _ = try await javascript(controller, "document.dispatchEvent(new KeyboardEvent('keydown', {key:'s', ctrlKey:true, bubbles:true}));")
        for _ in 0..<60 {
            if (try? await javascript(controller, "return Boolean(window.moreadApp.activeTab.filePath) && !window.moreadApp.isEdited;")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        documentsTimer.invalidate()
        let firstURL = documents.appendingPathComponent("未命名.md")
        check((try? String(contentsOf: firstURL, encoding: .utf8)) == "# unsaved window content", "Ctrl+S save choice creates Documents/Moread and saves real bytes")
        _ = try await javascript(controller, "window.moreadApp.sourceTextareaEl.value = '# updated Documents file'; window.moreadApp.markAsEdited(); await window.moreadApp.saveCurrentFile();")
        check((try? String(contentsOf: firstURL, encoding: .utf8)) == "# updated Documents file" && !FileManager.default.fileExists(atPath: documents.appendingPathComponent("未命名 (2).md").path), "Subsequent Save updates the same Documents file")

        let savedURL = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("quit-save.md")
        try "# baseline".write(to: savedURL, atomically: true, encoding: .utf8)
        controller.nativeBridge.authorizeFile(savedURL.path)
        let pathJSON = String(data: try JSONSerialization.data(withJSONObject: [savedURL.path]), encoding: .utf8)!
        _ = try await javascript(controller, """
            const a = window.moreadApp;
            await a.loadFile(\(pathJSON)[0]);
            if (!a.isEditMode) await a.toggleEditMode();
            if (!a.isSourceMode) a.toggleSourceView();
            a.sourceTextareaEl.value = '# saved by application quit'; a.markAsEdited();
            a.openNewEmptyTab();
            if (!a.isSourceMode) a.toggleSourceView();
            a.sourceTextareaEl.value = '# new document saved on quit'; a.markAsEdited();
            window.electronAPI.confirmSaveDialog = async (title, untitled) => untitled ? window.__originalConfirmSave(title, untitled) : ({action:'save'});
            """)
        _ = clickSheetButton("保存到文稿", window: window)
        let finalChecks = passed + 3
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            guard (try? String(contentsOf: savedURL, encoding: .utf8)) == "# saved by application quit" else {
                print("FAIL: application quit did not persist the document"); exit(1)
            }
            guard (try? String(contentsOf: documents.appendingPathComponent("未命名 (2).md"), encoding: .utf8)) == "# new document saved on quit" else {
                print("FAIL: native quit sheet did not save an untitled document to Documents"); exit(1)
            }
            print("PASS: \(finalChecks) production-window/NSApplication close checks (native cancel sheet and real disk save; other dialog answers controlled)")
            fflush(stdout)
        }
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

@main
struct WindowCloseMain {
    @MainActor static func main() {
        setbuf(stdout, nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let tests = WindowCloseTests()
        app.delegate = tests.delegate
        DispatchQueue.main.async {
            Task { @MainActor in
                do { try await tests.run() }
                catch { print("FAIL: \(error)"); exit(1) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            print("FAIL: Production window close test timed out"); exit(1)
        }
        app.run()
    }
}
