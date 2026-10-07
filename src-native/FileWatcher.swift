import Foundation

public final class FileWatcher: @unchecked Sendable {
    private var sources: [String: DispatchSourceFileSystemObject] = [:]
    private var fileDescriptors: [String: Int32] = [:]
    private let queue = DispatchQueue(label: "com.moread.filewatcher", qos: .utility)
    private var debounceWorkItems: [String: DispatchWorkItem] = [:]
    private let onChange: (String) -> Void
    private var isStopped = false
    private var suppressedPaths: [String: Date] = [:]

    public init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    deinit {
        stop()
    }

    public func suppressNextChange(for path: String, duration: TimeInterval = 1.5) {
        queue.async { [weak self] in
            self?.suppressedPaths[path] = Date().addingTimeInterval(duration)
        }
    }

    public func watch(filePath: String) {
        queue.async { [weak self] in
            guard let self = self, !self.isStopped else { return }
            if self.sources[filePath] != nil {
                return // Already watching
            }
            self.startWatching(path: filePath)
        }
    }

    public func unwatch(filePath: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.stopWatching(path: filePath)
        }
    }

    private func startWatching(path: String) {
        guard !isStopped else { return }

        let descriptor = open(path, O_EVTONLY)
        guard descriptor >= 0 else {
            return
        }
        fileDescriptors[path] = descriptor

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .extend, .attrib],
            queue: queue
        )

        src.setEventHandler { [weak self] in
            guard let self = self, !self.isStopped else { return }
            let flags = src.data

            // Handle atomic replace or delete by external editors
            if flags.contains(.delete) || flags.contains(.rename) {
                self.rearmWatcherAfterAtomicSave(path: path)
            }

            self.scheduleDebouncedNotification(path: path)
        }

        src.setCancelHandler { [weak self] in
            close(descriptor)
            guard let self = self else { return }
            if self.fileDescriptors[path] == descriptor {
                self.fileDescriptors.removeValue(forKey: path)
            }
        }

        sources[path] = src
        src.resume()
    }

    private func stopWatching(path: String) {
        debounceWorkItems[path]?.cancel()
        debounceWorkItems.removeValue(forKey: path)
        if let src = sources.removeValue(forKey: path) {
            src.cancel()
        }
        fileDescriptors.removeValue(forKey: path)
        suppressedPaths.removeValue(forKey: path)
    }

    private func rearmWatcherAfterAtomicSave(path: String) {
        // Many text editors write to a temporary file and atomically rename it.
        // Wait 100ms for filesystem to settle, then rebind descriptor.
        queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, !self.isStopped, self.sources[path] != nil else { return }
            if let existingSource = self.sources.removeValue(forKey: path) {
                existingSource.cancel()
            }
            if FileManager.default.fileExists(atPath: path) {
                self.startWatching(path: path)
            }
        }
    }

    private func scheduleDebouncedNotification(path: String) {
        debounceWorkItems[path]?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isStopped else { return }
            if let until = self.suppressedPaths[path], Date() < until {
                // Suppress notification triggered by app's own save
                return
            }
            DispatchQueue.main.async {
                self.onChange(path)
            }
        }
        debounceWorkItems[path] = workItem
        queue.asyncAfter(deadline: .now() + 0.2, execute: workItem)
    }

    public func stop() {
        queue.sync { [weak self] in
            guard let self = self else { return }
            self.isStopped = true
            for (_, item) in self.debounceWorkItems {
                item.cancel()
            }
            self.debounceWorkItems.removeAll()
            for (_, src) in self.sources {
                src.cancel()
            }
            self.sources.removeAll()
            self.fileDescriptors.removeAll()
            self.suppressedPaths.removeAll()
        }
    }
}
