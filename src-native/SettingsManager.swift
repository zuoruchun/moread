import Foundation

public final class SettingsManager: @unchecked Sendable {
    public static let shared = SettingsManager()

    private let lock = NSLock()
    private let fileManager = FileManager.default
    private let configURL: URL

    private init() {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let appDir = appSupport.appendingPathComponent("moread", isDirectory: true)

        if !fileManager.fileExists(atPath: appDir.path) {
            try? fileManager.createDirectory(at: appDir, withIntermediateDirectories: true, attributes: nil)
        }
        self.configURL = appDir.appendingPathComponent("moread-config.json")
    }

    public func getSettings() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        let defaults: [String: Any] = [
            "theme": "system",
            "readingWidth": "standard",
            "fontSize": 16,
            "recentFiles": []
        ]

        guard fileManager.fileExists(atPath: configURL.path),
              let data = try? Data(contentsOf: configURL),
              let json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
            return defaults
        }

        var merged = defaults
        for (k, v) in json {
            merged[k] = v
        }
        return merged
    }

    public func saveSettings(_ newSettings: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }

        var current = getSettingsInternal()
        for (k, v) in newSettings {
            current[k] = v
        }

        if let data = try? JSONSerialization.data(withJSONObject: current, options: [.prettyPrinted]) {
            try? data.write(to: configURL, options: .atomic)
        }
    }

    public func clearAll() {
        lock.lock()
        defer { lock.unlock() }

        let defaults: [String: Any] = [
            "theme": "system",
            "readingWidth": "standard",
            "fontSize": 16,
            "recentFiles": []
        ]

        if let data = try? JSONSerialization.data(withJSONObject: defaults, options: [.prettyPrinted]) {
            try? data.write(to: configURL, options: .atomic)
        }
    }

    private func getSettingsInternal() -> [String: Any] {
        let defaults: [String: Any] = [
            "theme": "system",
            "readingWidth": "standard",
            "fontSize": 16,
            "recentFiles": []
        ]

        guard fileManager.fileExists(atPath: configURL.path),
              let data = try? Data(contentsOf: configURL),
              let json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
            return defaults
        }

        var merged = defaults
        for (k, v) in json {
            merged[k] = v
        }
        return merged
    }
}
