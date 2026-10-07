import Foundation

public final class SettingsManager: @unchecked Sendable {
    public static let shared = SettingsManager()

    private let lock = NSLock()
    private let fileManager = FileManager.default
    private let configURL: URL

    private convenience init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let appDir = appSupport.appendingPathComponent("moread", isDirectory: true)
        self.init(configURL: appDir.appendingPathComponent("moread-config.json"))
    }

    public init(configURL: URL) {
        self.configURL = configURL
        let parent = configURL.deletingLastPathComponent()
        if !fileManager.fileExists(atPath: parent.path) {
            try? fileManager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: nil)
        }
    }

    public func getSettings() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        let defaults = defaultSettings()

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

        let defaults = defaultSettings()

        if let data = try? JSONSerialization.data(withJSONObject: defaults, options: [.prettyPrinted]) {
            try? data.write(to: configURL, options: .atomic)
        }
    }

    private func getSettingsInternal() -> [String: Any] {
        let defaults = defaultSettings()

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

    private func defaultSettings() -> [String: Any] {
        [
            "theme": "system",
            "readingWidth": "standard",
            "fontSize": 16,
            "saveMode": "manual",
            "openMode": "read",
            "recentFiles": [],
            "showSidebar": false,
            "allowRemoteImages": false
        ]
    }
}
