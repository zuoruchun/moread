import Foundation
import Darwin

// Real filesystem events and descriptors, confined to a temporary directory.
@main
struct FileWatcherTests {
    static var checks = 0
    static var failures = 0

    static func check(_ condition: Bool, _ message: String) {
        checks += 1
        if !condition { failures += 1 }
        print("\(condition ? "PASS" : "FAIL"): \(message)")
    }

    static func pump(_ seconds: TimeInterval) {
        let deadline = Date(timeIntervalSinceNow: seconds)
        while Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: min(deadline, Date(timeIntervalSinceNow: 0.02)))
        }
    }

    static func wait(_ condition: () -> Bool, timeout: TimeInterval = 2) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !condition() && Date() < deadline { pump(0.02) }
        return condition()
    }

    static func descriptorCount(in root: URL) -> Int {
        guard let resolved = realpath(root.path, nil) else { return -1 }
        defer { free(resolved) }
        let prefix = String(cString: resolved)
        return ((try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd")) ?? []).filter { name in
            guard let fd = Int32(name) else { return false }
            var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
            guard fcntl(fd, F_GETPATH, &path) == 0 else { return false }
            let value = String(cString: path)
            return value == prefix || value.hasPrefix(prefix + "/")
        }.count
    }

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("moread-watcher-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("阅读位置.md")
        try "initial".write(to: file, atomically: true, encoding: .utf8)
        var events = 0
        var notificationsOnMainThread = true
        let watcher = FileWatcher { path in
            notificationsOnMainThread = notificationsOnMainThread && Thread.isMainThread
            if path == file.path { events += 1 }
        }
        defer { watcher.stop() }
        watcher.watch(filePath: file.path)
        Thread.sleep(forTimeInterval: 0.15)

        try FileManager.default.removeItem(at: file)
        check(wait { events > 0 }, "deleting a watched file sends a notification")
        pump(0.45)
        let beforeRestore = events
        try "restored".write(to: file, atomically: true, encoding: .utf8)
        check(wait { events > beforeRestore }, "recreating a deleted path restores notifications after a long gap")
        let beforeWrite = events
        try "restored and edited".write(to: file, atomically: false, encoding: .utf8)
        check(wait { events > beforeWrite }, "in-place writes after restoration stay watched")

        let renamed = root.appendingPathComponent("moved.md")
        try FileManager.default.moveItem(at: file, to: renamed)
        pump(0.45)
        let beforeRenameRestore = events
        try "new inode".write(to: file, atomically: true, encoding: .utf8)
        check(wait { events > beforeRenameRestore }, "a renamed file can be replaced at its original path")
        let beforeBurst = events
        for index in 0..<15 {
            try "atomic \(index)".write(to: file, atomically: true, encoding: .utf8)
            Thread.sleep(forTimeInterval: 0.01)
        }
        check(wait { events > beforeBurst }, "rapid atomic replacements produce a final notification")
        pump(0.3)
        let beforePostBurst = events
        try "after burst".write(to: file, atomically: false, encoding: .utf8)
        check(wait { events > beforePostBurst }, "the final inode remains watched after rapid replacements")

        let beforeSuppression = events
        watcher.suppressNextChange(for: file.path, duration: 0.8)
        try "self save".write(to: file, atomically: true, encoding: .utf8)
        pump(0.3)
        check(events == beforeSuppression, "own saves remain coalesced during suppression")
        try "external overwrite during suppression".write(to: file, atomically: true, encoding: .utf8)
        check(wait { events > beforeSuppression }, "suppression ends with a recheck for genuine external writes")

        pump(0.3)
        let beforeSibling = events
        try "unrelated".write(to: root.appendingPathComponent("sibling.md"), atomically: true, encoding: .utf8)
        pump(0.4)
        check(events == beforeSibling, "unrelated files in the parent directory do not trigger reloads")

        // Block the main queue until an event is already queued for delivery.
        let beforeUnwatch = events
        try "queued notification".write(to: file, atomically: false, encoding: .utf8)
        Thread.sleep(forTimeInterval: 0.5)
        watcher.unwatch(filePath: file.path)
        Thread.sleep(forTimeInterval: 0.05)
        pump(0.3)
        check(events == beforeUnwatch, "unwatch invalidates callbacks already queued on the main thread")
        check(wait { descriptorCount(in: root) == 0 }, "unwatch closes both file and directory descriptors")

        watcher.watch(filePath: file.path)
        Thread.sleep(forTimeInterval: 0.1)
        try "old watch".write(to: file, atomically: false, encoding: .utf8)
        Thread.sleep(forTimeInterval: 0.4)
        watcher.unwatch(filePath: file.path)
        watcher.watch(filePath: file.path)
        Thread.sleep(forTimeInterval: 0.1)
        pump(0.3)
        check(events == beforeUnwatch, "rewatching the same path cannot revive an old queued callback")
        try "new watch".write(to: file, atomically: false, encoding: .utf8)
        check(wait { events > beforeUnwatch }, "rewatching the same path still delivers new changes")

        pump(0.3)
        let beforeStop = events
        try "queued before stop".write(to: file, atomically: false, encoding: .utf8)
        Thread.sleep(forTimeInterval: 0.4)
        watcher.stop()
        pump(0.3)
        check(events == beforeStop, "stop invalidates callbacks already queued on the main thread")
        check(wait { descriptorCount(in: root) == 0 }, "stop closes all watcher descriptors")

        let missing = root.appendingPathComponent("missing.md")
        var missingEvents = 0
        let missingWatcher = FileWatcher { _ in missingEvents += 1 }
        missingWatcher.watch(filePath: missing.path)
        Thread.sleep(forTimeInterval: 0.1)
        try "created later".write(to: missing, atomically: true, encoding: .utf8)
        check(wait { missingEvents > 0 }, "watching an absent file starts when its path appears")
        try FileManager.default.removeItem(at: missing)
        Thread.sleep(forTimeInterval: 0.05)
        missingWatcher.unwatch(filePath: missing.path)
        Thread.sleep(forTimeInterval: 0.15)
        let beforeCancelledRestore = missingEvents
        try "must not rearm".write(to: missing, atomically: true, encoding: .utf8)
        pump(0.4)
        check(missingEvents == beforeCancelledRestore, "unwatch during deletion cancels recovery and pending debounce")
        missingWatcher.stop()

        var resourceWatcher: FileWatcher? = FileWatcher { _ in }
        for index in 0..<50 {
            let item = root.appendingPathComponent("resource-\(index).md")
            try "fixture".write(to: item, atomically: false, encoding: .utf8)
            resourceWatcher?.watch(filePath: item.path)
        }
        check(wait { descriptorCount(in: root) >= 50 }, "resource regression opens fifty real watched files")
        for index in 0..<50 {
            resourceWatcher?.unwatch(filePath: root.appendingPathComponent("resource-\(index).md").path)
        }
        check(wait { descriptorCount(in: root) == 0 }, "closing fifty watches returns descriptor count to baseline")
        resourceWatcher?.watch(filePath: file.path)
        check(wait { descriptorCount(in: root) > 0 }, "deinitialization regression has active descriptors")
        resourceWatcher = nil
        check(wait { descriptorCount(in: root) == 0 }, "deinitialization closes active descriptors without an explicit stop")
        check(notificationsOnMainThread, "notifications stay on the main thread")

        print("\(checks - failures)/\(checks) FileWatcher checks passed")
        exit(failures == 0 ? 0 : 1)
    }
}
