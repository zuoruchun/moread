import Foundation

public final class FileWatcher: @unchecked Sendable {
    private struct FileIdentity: Equatable {
        let device: dev_t
        let inode: ino_t

        init(_ info: stat) {
            device = info.st_dev
            inode = info.st_ino
        }
    }

    private final class Watch {
        var source: DispatchSourceFileSystemObject?
        var directorySource: DispatchSourceFileSystemObject?
        var identity: FileIdentity?
        var sourceGeneration = UUID()
        var notificationGeneration = UUID()
        var notification: DispatchWorkItem?
    }

    private var watches: [String: Watch] = [:]
    private let queue = DispatchQueue(label: "com.moread.filewatcher", qos: .utility)
    private let queueKey = DispatchSpecificKey<Void>()
    private let onChange: (String) -> Void
    private var isStopped = false
    private var suppressedPaths: [String: Date] = [:]

    public init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
        queue.setSpecific(key: queueKey, value: ())
    }

    deinit {
        stop()
    }

    public func suppressNextChange(for path: String, duration: TimeInterval = 1.5) {
        queue.async { [weak self] in
            guard let self, !self.isStopped else { return }
            self.suppressedPaths[path] = Date().addingTimeInterval(duration)
        }
    }

    public func watch(filePath: String) {
        queue.async { [weak self] in
            guard let self = self, !self.isStopped else { return }
            if self.watches[filePath] != nil {
                return // Already watching
            }
            let watch = Watch()
            self.watches[filePath] = watch
            self.startDirectoryWatcher(path: filePath, watch: watch)
            self.refreshFileSource(path: filePath, watch: watch)
        }
    }

    public func unwatch(filePath: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.stopWatching(path: filePath)
        }
    }

    private func startDirectoryWatcher(path: String, watch: Watch) {
        // A file source follows its inode, so also watch the containing directory
        // to discover a replacement even when the original path was absent for a while.
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        let descriptor = open(directory, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename],
            queue: queue
        )
        source.setEventHandler { [weak self, weak watch] in
            guard let self, let watch, !self.isStopped, self.watches[path] === watch else { return }
            if self.refreshFileSource(path: path, watch: watch) {
                self.scheduleDebouncedNotification(path: path, watch: watch)
            }
        }
        source.setCancelHandler { close(descriptor) }
        watch.directorySource = source
        source.resume()
    }

    @discardableResult
    private func refreshFileSource(path: String, watch: Watch) -> Bool {
        var info = stat()
        let identity = stat(path, &info) == 0 ? FileIdentity(info) : nil
        guard identity != watch.identity else { return false }

        watch.source?.cancel()
        watch.source = nil
        watch.identity = nil
        watch.sourceGeneration = UUID()
        guard identity != nil else { return true }

        let descriptor = open(path, O_EVTONLY)
        guard descriptor >= 0 else { return true }
        guard fstat(descriptor, &info) == 0 else {
            close(descriptor)
            return true
        }
        watch.identity = FileIdentity(info)
        let generation = watch.sourceGeneration

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .extend, .attrib],
            queue: queue
        )

        src.setEventHandler { [weak self, weak watch] in
            guard let self, let watch, !self.isStopped, self.watches[path] === watch,
                  watch.sourceGeneration == generation else { return }
            self.refreshFileSource(path: path, watch: watch)
            self.scheduleDebouncedNotification(path: path, watch: watch)
        }

        src.setCancelHandler { close(descriptor) }

        watch.source = src
        src.resume()
        return true
    }

    private func stopWatching(path: String) {
        if let watch = watches.removeValue(forKey: path) {
            watch.notification?.cancel()
            watch.source?.cancel()
            watch.directorySource?.cancel()
        }
        suppressedPaths.removeValue(forKey: path)
    }

    private func scheduleDebouncedNotification(path: String, watch: Watch) {
        watch.notification?.cancel()
        let generation = UUID()
        watch.notificationGeneration = generation
        let workItem = DispatchWorkItem { [weak self, weak watch] in
            guard let self, let watch, !self.isStopped, self.watches[path] === watch,
                  watch.notificationGeneration == generation else { return }
            if let until = self.suppressedPaths[path], Date() < until {
                // Coalesce own saves, but check again afterwards: a genuine
                // external write may have arrived during the suppression window.
                self.scheduleDebouncedNotification(path: path, watch: watch)
                return
            }
            self.suppressedPaths.removeValue(forKey: path)
            watch.notification = nil
            DispatchQueue.main.async { [weak self, weak watch] in
                guard let self, let watch else { return }
                let isCurrent = self.queue.sync {
                    !self.isStopped && self.watches[path] === watch && watch.notificationGeneration == generation
                }
                guard isCurrent else { return }
                self.onChange(path)
            }
        }
        watch.notification = workItem
        let delay = max(0.2, suppressedPaths[path]?.timeIntervalSinceNow ?? 0)
        queue.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    public func stop() {
        // The final reference may be released by one of the watcher queue's
        // callbacks. Avoid synchronously dispatching back onto that same queue.
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            stopOnQueue()
        } else {
            queue.sync { stopOnQueue() }
        }
    }

    private func stopOnQueue() {
        isStopped = true
        for path in Array(watches.keys) {
            stopWatching(path: path)
        }
        suppressedPaths.removeAll()
    }
}
