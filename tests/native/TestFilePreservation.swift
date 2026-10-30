import Foundation
import Darwin
import CryptoKit

@main
struct FilePreservationTests {
    static func pump(_ seconds: Double) {
        let end = Date(timeIntervalSinceNow: seconds)
        while Date() < end { _ = RunLoop.current.run(mode: .default, before: min(end, Date(timeIntervalSinceNow: 0.02))) }
    }

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("moread-preservation-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tagged = root.appendingPathComponent("tagged.md")
        let baseline = Data("# baseline\n".utf8)
        try baseline.write(to: tagged)
        let attribute = "com.apple.metadata:_kMDItemUserTags"
        let tags = try PropertyListSerialization.data(fromPropertyList: ["Review\n6"], format: .binary, options: 0)
        let setResult = tags.withUnsafeBytes { setxattr(tagged.path, attribute, $0.baseAddress, $0.count, 0, 0) }
        let beforeSize = getxattr(tagged.path, attribute, nil, 0, 0, 0)
        let revision = SHA256.hash(data: baseline).map { String(format: "%02x", $0) }.joined()
        try LocalFileAccessPolicy.writeFile(Data("# edited\n".utf8), at: tagged.path, allowedDirectories: [root.path], expectedRevision: revision)
        let afterSize = getxattr(tagged.path, attribute, nil, 0, 0, 0)
        let afterErrno = errno
        precondition(setResult == 0 && beforeSize > 0 && afterSize == beforeSize, "Finder tags must survive atomic saves")
        var restored = Data(count: afterSize)
        let readSize = restored.withUnsafeMutableBytes { getxattr(tagged.path, attribute, $0.baseAddress, $0.count, 0, 0) }
        precondition(readSize == tags.count && restored == tags, "Finder tag bytes must remain unchanged")
        print("xattr: set=\(setResult), beforeBytes=\(beforeSize), afterBytes=\(afterSize), afterErrno=\(afterErrno), body=\(try String(contentsOf: tagged, encoding: .utf8).debugDescription)")

        let live = root.appendingPathComponent("live")
        let moved = root.appendingPathComponent("old")
        try FileManager.default.createDirectory(at: live, withIntermediateDirectories: true)
        let file = live.appendingPathComponent("document.md")
        try Data("initial".utf8).write(to: file)
        var events = 0
        let watcher = FileWatcher { path in if path == file.path { events += 1 } }
        watcher.watch(filePath: file.path)
        pump(0.3)
        try Data("control edit".utf8).write(to: file)
        pump(0.6)
        let controlEvents = events
        try FileManager.default.moveItem(at: live, to: moved)
        pump(0.6)
        let afterRename = events
        try FileManager.default.createDirectory(at: live, withIntermediateDirectories: true)
        try Data("recreated".utf8).write(to: file)
        pump(0.6)
        let afterRecreate = events
        try Data("edited after recreate".utf8).write(to: file)
        pump(0.6)
        let afterEdit = events
        watcher.stop()
        precondition(controlEvents > 0 && afterRecreate > afterRename && afterEdit > afterRecreate, "Parent directory replacement must restore notifications")
        print("watcher: control=\(controlEvents), afterParentRename=\(afterRename), afterParentRecreate=\(afterRecreate), afterEdit=\(afterEdit)")
        print("PASS: file metadata and directory replacement regressions")
        print("fixtureRoot=\(root.path)")
    }
}
