import Cocoa

// Exercise the production delegate callbacks with a recording window host.
// This tests native routing, not LaunchServices/Finder UI or real window geometry.
public final class RecordingBridge {
    public func notifyMenuAction(_ action: String) {}
}
public final class MainWindowController {
    public var window: NSWindow?
    public var currentFolderPath: String?
    public let nativeBridge = RecordingBridge()
    public var opened: [String] = []
    public var presentations = 0
    public var closeAllowed = true
    public var closeApprovalValid = true
    public var approvalRequests = 0
    public var canceledApprovals = 0
    public func cancelCloseApproval() { canceledApprovals += 1 }
    public var onApproval: (() -> Void)?
    public func requestCloseApproval(completion: @escaping (Bool) -> Void) {
        approvalRequests += 1
        onApproval?()
        completion(closeAllowed)
    }
    public func validateCloseApproval(completion: @escaping (Bool) -> Void) {
        completion(closeApprovalValid)
    }
    public init(initialFolderPath: String? = nil) { currentFolderPath = initialFolderPath }
    public func presentWindow() { presentations += 1 }
    public func openFiles(_ paths: [String]) { opened += paths }
    public func showOpenFileDialog() {}
    public func showOpenFolderDialog() {}
    public func saveDocument() {}
    public func exportPDF() {}
    public func zoomIn() {}
    public func zoomOut() {}
    public func zoomActual() {}
}

@main
struct AppLifecycleTests {
    @MainActor static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("moread-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = root.appendingPathComponent("中文 空格.MD").path
        let second = root.appendingPathComponent("another.markdown").path
        try "# First".write(toFile: first, atomically: true, encoding: .utf8)
        try "# Second".write(toFile: second, atomically: true, encoding: .utf8)
        var checks = 0
        func check(_ condition: Bool, _ message: String) {
            guard condition else { print("FAIL: \(message)"); exit(1) }
            checks += 1
        }
        func launch(_ delegate: AppDelegate) {
            delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        }

        let cold = AppDelegate()
        check(cold.application(app, openFile: first), "Cold launch accepts file")
        _ = cold.application(app, openFile: first)
        _ = cold.application(app, openFile: second)
        check(cold.windowControllers.isEmpty, "Cold requests wait until launch completes")
        launch(cold)
        check(cold.windowControllers.count == 1, "One startup window")
        check(cold.windowControllers[0].opened == [first, second], "Startup queue deduplicated and ordered")
        let original = cold.windowControllers[0]
        _ = cold.application(app, openFile: second)
        check(cold.windowControllers.count == 1 && original.opened.last == second, "Warm open uses existing window")
        _ = cold.applicationShouldHandleReopen(app, hasVisibleWindows: false)
        check(cold.windowControllers.count == 1 && original.presentations > 1, "Hidden/minimized Dock reopen reuses window")
        cold.removeWindowController(original)
        check(cold.windowControllers.isEmpty, "Close removes the window")
        check(cold.application(app, openFile: first), "Warm zero-window process accepts Finder open")
        check(cold.windowControllers.count == 1, "Warm open immediately creates a window")
        check(cold.windowControllers[0].opened == [first], "Warm open delivers the file, not welcome screen")
        let reopened = cold.windowControllers[0]
        _ = cold.applicationShouldHandleReopen(app, hasVisibleWindows: true)
        check(cold.windowControllers.count == 1 && reopened.opened == [first], "Dock does not duplicate delivery")
        for _ in 0..<5 {
            cold.removeWindowController(cold.windowControllers[0])
            _ = cold.application(app, openFile: second)
            check(cold.windowControllers.count == 1 && cold.windowControllers[0].opened == [second], "Repeated close/reopen remains usable")
        }
        cold.removeWindowController(cold.windowControllers[0])
        _ = cold.applicationShouldHandleReopen(app, hasVisibleWindows: false)
        check(cold.windowControllers.count == 1 && cold.windowControllers[0].opened.isEmpty, "Empty Dock reopen creates welcome window")
        check(!cold.application(app, openFile: root.appendingPathComponent("missing.md").path), "Missing file rejected")
        check(!cold.application(app, openFile: root.path), "Directory rejected")
        check(!cold.application(app, openFile: first + ".txt"), "Non-Markdown rejected")

        let earlyDock = AppDelegate()
        _ = earlyDock.applicationShouldHandleReopen(app, hasVisibleWindows: false)
        _ = earlyDock.application(app, openFile: first)
        launch(earlyDock)
        check(earlyDock.windowControllers.count == 1 && earlyDock.windowControllers[0].opened == [first], "Reopen before startup does not create duplicate startup windows")

        let quitting = AppDelegate()
        let firstWindow = MainWindowController(), secondWindow = MainWindowController()
        quitting.windowControllers = [firstWindow, secondWindow]
        var approved: Bool?
        quitting.requestTerminationApproval { approved = $0 }
        check(approved == true && firstWindow.approvalRequests == 1 && secondWindow.approvalRequests == 1, "Quit checks every window before approval")
        check(quitting.windowControllers.count == 2, "Approval leaves all windows open until the application exits")
        firstWindow.closeAllowed = false
        let priorSecondRequests = secondWindow.approvalRequests
        quitting.requestTerminationApproval { approved = $0 }
        check(approved == false && secondWindow.approvalRequests == priorSecondRequests, "Cancel or failed save aborts quit without processing another window")
        check(firstWindow.canceledApprovals == 1 && secondWindow.canceledApprovals == 1, "Canceled quit resumes editing in every window")
        firstWindow.closeAllowed = true
        secondWindow.onApproval = { firstWindow.closeApprovalValid = false }
        quitting.requestTerminationApproval { approved = $0 }
        check(approved == false, "Editing an earlier window during a later confirmation aborts quit")
        firstWindow.closeApprovalValid = true
        secondWindow.onApproval = { quitting.windowControllers.append(MainWindowController()) }
        quitting.requestTerminationApproval { approved = $0 }
        check(approved == false, "Opening a new window while confirming aborts quit")
        secondWindow.onApproval = { quitting.removeWindowController(firstWindow) }
        quitting.windowControllers = [firstWindow, secondWindow]
        quitting.requestTerminationApproval { approved = $0 }
        check(approved == false, "Changing the window set while confirming invalidates quit approval")
        let empty = AppDelegate()
        check(empty.applicationShouldTerminate(app) == .terminateNow, "Zero-window application exits immediately")
        print("PASS: \(checks) production AppDelegate lifecycle checks")
    }
}
