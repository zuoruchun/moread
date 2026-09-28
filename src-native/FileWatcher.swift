import Foundation

public final class FileWatcher: @unchecked Sendable {
    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: Int32 = -1
    private let queue = DispatchQueue(label: "com.moread.filewatcher", qos: .utility)
    private var debounceWorkItem: DispatchWorkItem?
    private var currentFilePath: String?
    private let onChange: (String) -> Void
    private var isStopped = false

    public init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    deinit {
        stop()
    }

    public func watch(filePath: String) {
        stop()
        isStopped = false
        currentFilePath = filePath
        startWatching(path: filePath)
    }

    private func startWatching(path: String) {
        guard !isStopped else { return }

        fileDescriptor = open(path, O_EVTONLY)
        guard fileDescriptor >= 0 else {
            return
        }

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
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
            guard let self = self else { return }
            if self.fileDescriptor >= 0 {
                close(self.fileDescriptor)
                self.fileDescriptor = -1
            }
        }

        self.source = src
        src.resume()
    }

    private func rearmWatcherAfterAtomicSave(path: String) {
        // Many text editors write to a temporary file and atomically rename it.
        // Wait 100ms for filesystem to settle, then rebind descriptor.
        queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, !self.isStopped, self.currentFilePath == path else { return }
            if let existingSource = self.source {
                existingSource.cancel()
                self.source = nil
            }
            if FileManager.default.fileExists(atPath: path) {
                self.startWatching(path: path)
            }
        }
    }

    private func scheduleDebouncedNotification(path: String) {
        debounceWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isStopped else { return }
            DispatchQueue.main.async {
                self.onChange(path)
            }
        }
        debounceWorkItem = workItem
        queue.asyncAfter(deadline: .now() + 0.2, execute: workItem)
    }

    public func stop() {
        isStopped = true
        debounceWorkItem?.cancel()
        debounceWorkItem = nil
        currentFilePath = nil
        if let src = source {
            src.cancel()
            source = nil
        }
    }
}
