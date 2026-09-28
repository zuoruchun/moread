import Foundation
import WebKit
import UniformTypeIdentifiers

public enum LocalFileAccessPolicy {
    public static func isPath(_ candidatePath: String, inside allowedDirectory: String) -> Bool {
        let candidate = URL(fileURLWithPath: candidatePath).standardizedFileURL.path
        let root = URL(fileURLWithPath: allowedDirectory).standardizedFileURL.path
        return candidate == root || candidate.hasPrefix(root + "/")
    }
}

public final class LocalFileSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var allowedDirectories = Set<String>()
    private let maximumFileSize = 25 * 1024 * 1024

    public func allowDocument(at filePath: String) {
        let directory = URL(fileURLWithPath: filePath).standardizedFileURL.deletingLastPathComponent().path
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

        guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let fileSize = (attributes[.size] as? NSNumber)?.intValue,
              fileSize <= maximumFileSize,
              let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
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
