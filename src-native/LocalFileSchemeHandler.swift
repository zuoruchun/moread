import Foundation
import WebKit
import UniformTypeIdentifiers
import Darwin
import CryptoKit

public enum LocalFileAccessPolicy {
    public static func canonicalPath(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    }

    // Authorized roots are resolved once when the native user grants access.
    public static func isPath(_ candidatePath: String, inside allowedDirectory: String) -> Bool {
        let candidate = canonicalPath(candidatePath)
        let root = URL(fileURLWithPath: allowedDirectory).standardizedFileURL.path
        return candidate == root || candidate.hasPrefix(root == "/" ? "/" : root + "/")
    }

    private static func failure(_ description: String) -> NSError {
        NSError(domain: "com.moread.file-access", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }

    private static func validateDescriptor(_ descriptor: Int32, roots: Set<String>, directory: Bool = false) throws -> stat {
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              (info.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG) else {
            throw failure("路径不是可访问的普通文件或目录")
        }
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(descriptor, F_GETPATH, &path) == 0,
              roots.contains(where: { isPath(String(cString: path), inside: $0) }) else {
            throw failure("文件不在用户已授权的目录中")
        }
        return info
    }

    public static func readFile(at path: String, allowedDirectories: Set<String>, maximumSize: Int) throws -> Data {
        let resolved = canonicalPath(path)
        guard allowedDirectories.contains(where: { isPath(resolved, inside: $0) }) else {
            throw failure("文件不在用户已授权的目录中")
        }
        // Nonblocking open prevents FIFOs/devices from hanging before the type check.
        let descriptor = open(resolved, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw failure("无法打开文件") }
        defer { close(descriptor) }
        let info = try validateDescriptor(descriptor, roots: allowedDirectories)
        guard info.st_size <= maximumSize else { throw failure("文件超过大小限制") }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, min($0.count, maximumSize - data.count + 1)) }
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw failure("读取文件失败")
            }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= maximumSize else { throw failure("文件超过大小限制") }
        }
        return data
    }

    public static func writeFile(_ data: Data, at path: String, allowedDirectories: Set<String>, expectedRevision: String? = nil) throws {
        let target = URL(fileURLWithPath: canonicalPath(path))
        guard allowedDirectories.contains(where: { isPath(target.path, inside: $0) }) else {
            throw failure("文件不在用户已授权的目录中")
        }
        let parent = open(target.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parent >= 0 else { throw failure("无法打开目标目录") }
        defer { close(parent) }
        _ = try validateDescriptor(parent, roots: allowedDirectories, directory: true)

        if let expectedRevision {
            let current = try readFile(at: target.path, allowedDirectories: allowedDirectories, maximumSize: 50 * 1024 * 1024)
            guard SHA256.hash(data: current).map({ String(format: "%02x", $0) }).joined() == expectedRevision else {
                throw failure("文件已在外部修改，保存已停止；当前修改仍保留")
            }
        }
        let name = target.lastPathComponent
        var original = stat()
        let exists = fstatat(parent, name, &original, AT_SYMLINK_NOFOLLOW) == 0
        guard !exists || (original.st_mode & S_IFMT) == S_IFREG else { throw failure("目标不是普通文件") }
        let temporaryName = ".moread-" + UUID().uuidString
        let descriptor = openat(parent, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw failure("无法创建保存文件") }
        defer {
            close(descriptor)
            unlinkat(parent, temporaryName, 0)
        }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure("写入文件失败") }
                offset += count
            }
        }
        if exists {
            let originalDescriptor = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard originalDescriptor >= 0 else { throw failure("无法读取原文件元数据") }
            defer { close(originalDescriptor) }
            _ = try validateDescriptor(originalDescriptor, roots: allowedDirectories, directory: false)
            guard fcopyfile(originalDescriptor, descriptor, nil, copyfile_flags_t(COPYFILE_XATTR | COPYFILE_ACL)) == 0 else {
                throw failure("无法保留原文件元数据")
            }
        }
        if exists { guard fchmod(descriptor, original.st_mode & 0o777) == 0 else { throw failure("无法保留文件权限") } }
        guard fsync(descriptor) == 0 else { throw failure("无法同步保存内容") }
        _ = try validateDescriptor(parent, roots: allowedDirectories, directory: true)
        guard renameat(parent, temporaryName, parent, name) == 0 else { throw failure("无法替换保存文件") }
    }
}

public final class LocalFileSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var allowedDirectories = Set<String>()
    private let maximumFileSize = 25 * 1024 * 1024

    public func allowDocument(at filePath: String) {
        let directory = URL(fileURLWithPath: LocalFileAccessPolicy.canonicalPath(filePath)).deletingLastPathComponent().path
        lock.lock()
        allowedDirectories.insert(directory)
        lock.unlock()
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.host == "local",
              let components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false),
              let rawPath = components.queryItems?.first(where: { $0.name == "path" })?.value else {
            fail(urlSchemeTask, code: 400, description: "Invalid local resource URL")
            return
        }

        let fileURL = URL(fileURLWithPath: rawPath).standardizedFileURL
        guard isAllowed(fileURL.path) else {
            fail(urlSchemeTask, code: 403, description: "Local resource is outside the opened document directory")
            return
        }

        guard let type = UTType(filenameExtension: fileURL.pathExtension), type.conforms(to: .image) else {
            fail(urlSchemeTask, code: 415, description: "Only local image resources are supported")
            return
        }

        lock.lock()
        let directories = allowedDirectories
        lock.unlock()
        guard let data = try? LocalFileAccessPolicy.readFile(at: fileURL.path, allowedDirectories: directories, maximumSize: maximumFileSize) else {
            fail(urlSchemeTask, code: 404, description: "Local image could not be read")
            return
        }

        let response = URLResponse(
            url: requestURL,
            mimeType: type.preferredMIMEType ?? "application/octet-stream",
            expectedContentLength: data.count,
            textEncodingName: nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    private func isAllowed(_ path: String) -> Bool {
        lock.lock()
        let directories = allowedDirectories
        lock.unlock()
        return directories.contains { LocalFileAccessPolicy.isPath(path, inside: $0) }
    }

    private func fail(_ task: any WKURLSchemeTask, code: Int, description: String) {
        task.didFailWithError(NSError(
            domain: "com.moread.local-resource",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: description]
        ))
    }
}
