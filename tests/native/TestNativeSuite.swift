import Foundation
import CommonCrypto

@main
struct TestRunner {
    static var passedCount = 0
    static var failedCount = 0

    static func assertTrue(_ condition: Bool, _ message: String) {
        if condition {
            passedCount += 1
            print("  ✓ PASS: \(message)")
        } else {
            failedCount += 1
            print("  ✗ FAIL: \(message)")
        }
    }

    static func assertEqual<T: Equatable>(_ a: T, _ b: T, _ message: String) {
        if a == b {
            passedCount += 1
            print("  ✓ PASS: \(message)")
        } else {
            failedCount += 1
            print("  ✗ FAIL: \(message) - expected: \(b), got: \(a)")
        }
    }

    static func computeSHA256(url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    static func main() {
        print("==========================================")
        print("  MoRead Native Swift Target Test Suite")
        print("==========================================")

        let cwd = FileManager.default.currentDirectoryPath
        let fixturesURL = URL(fileURLWithPath: cwd).appendingPathComponent("tests/fixtures")

        // Store initial hashes for immutability check
        let fixtureFiles = (try? FileManager.default.contentsOfDirectory(at: fixturesURL, includingPropertiesForKeys: nil)) ?? []
        var initialHashes: [URL: String] = [:]
        for file in fixtureFiles {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue {
                if let h = computeSHA256(url: file) {
                    initialHashes[file] = h
                }
            }
        }

        // ----------------------------------------------------
        // Test 1: Standard File Reading
        // ----------------------------------------------------
        print("\n[Group 1: File Reading & Encoding]")
        do {
            let standardURL = fixturesURL.appendingPathComponent("standard.md")
            let data = try Data(contentsOf: standardURL)
            let content = String(data: data, encoding: .utf8)!
            assertTrue(content.contains("# 墨读 MoRead 标准排版测试"), "Standard markdown file read cleanly")
            assertTrue(content.contains("四、代码块高亮"), "Code blocks present in standard doc")
        } catch {
            assertTrue(false, "Failed to read standard doc: \(error)")
        }

        // ----------------------------------------------------
        // Test 2: BOM Stripping
        // ----------------------------------------------------
        do {
            let bomURL = fixturesURL.appendingPathComponent("bom.md")
            var rawData = try Data(contentsOf: bomURL)
            assertTrue(rawData.count >= 3 && rawData[0] == 0xEF && rawData[1] == 0xBB && rawData[2] == 0xBF, "bom.md fixture contains UTF-8 BOM prefix")

            // Simulate NativeBridge BOM stripping logic
            if rawData.count >= 3 && rawData[0] == 0xEF && rawData[1] == 0xBB && rawData[2] == 0xBF {
                rawData = rawData.subdata(in: 3..<rawData.count)
            }
            let content = String(data: rawData, encoding: .utf8)!
            assertTrue(!content.hasPrefix("\u{FEFF}"), "UTF-8 BOM is completely removed from content string")
            assertTrue(content.hasPrefix("# UTF-8 BOM 测试文档"), "Document begins with title after BOM strip")
        } catch {
            assertTrue(false, "BOM test failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 3: CRLF Normalization
        // ----------------------------------------------------
        do {
            let crlfURL = fixturesURL.appendingPathComponent("crlf.md")
            let rawData = try Data(contentsOf: crlfURL)
            let rawString = String(data: rawData, encoding: .utf8)!
            assertTrue(rawString.contains("\r\n"), "crlf.md fixture has Windows \\r\\n line endings")

            let normalized = rawString.replacingOccurrences(of: "\r\n", with: "\n")
            assertTrue(!normalized.contains("\r\n"), "Normalized content has NO \\r\\n")
            assertTrue(normalized.contains("\n"), "Normalized content preserves standard \\n")
        } catch {
            assertTrue(false, "CRLF test failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 4: Special Path Handling
        // ----------------------------------------------------
        do {
            let specialURL = fixturesURL.appendingPathComponent("special paths/测试文档 #1 [2026] 🏷️.md")
            assertTrue(FileManager.default.fileExists(atPath: specialURL.path), "Special path file exists on disk")

            let data = try Data(contentsOf: specialURL)
            let content = String(data: data, encoding: .utf8)!
            assertTrue(content.contains("特殊路径与字符集测试"), "Read file with spaces, '#', brackets, and emojis")
        } catch {
            assertTrue(false, "Special path test failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 5: Empty File Handling
        // ----------------------------------------------------
        do {
            let emptyURL = fixturesURL.appendingPathComponent("empty.md")
            let data = try Data(contentsOf: emptyURL)
            let content = String(data: data, encoding: .utf8)!
            assertEqual(content, "", "Empty file correctly decodes to empty string without crash")
        } catch {
            assertTrue(false, "Empty file test failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 6: Large File Benchmarks (1MB & 10MB)
        // ----------------------------------------------------
        print("\n[Group 2: Large File Performance Benchmarks]")
        do {
            let mb1URL = fixturesURL.appendingPathComponent("1mb-doc.md")
            let start1 = CFAbsoluteTimeGetCurrent()
            let data1 = try Data(contentsOf: mb1URL, options: .mappedIfSafe)
            _ = String(data: data1, encoding: .utf8)
            let time1 = (CFAbsoluteTimeGetCurrent() - start1) * 1000.0
            print(String(format: "  1MB read + decode time: %.2f ms (Size: %d bytes)", time1, data1.count))
            assertTrue(time1 < 100.0, "1MB file reads and decodes in under 100ms")

            let mb10URL = fixturesURL.appendingPathComponent("10mb-doc.md")
            if FileManager.default.fileExists(atPath: mb10URL.path) {
                let start10 = CFAbsoluteTimeGetCurrent()
                let data10 = try Data(contentsOf: mb10URL, options: .mappedIfSafe)
                _ = String(data: data10, encoding: .utf8)
                let time10 = (CFAbsoluteTimeGetCurrent() - start10) * 1000.0
                print(String(format: "  10MB read + decode time: %.2f ms (Size: %d bytes)", time10, data10.count))
                assertTrue(time10 < 500.0, "10MB file reads and decodes in under 500ms")
            }
        } catch {
            assertTrue(false, "Large file benchmark failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 7: Error Boundaries & Directory Traversal
        // ----------------------------------------------------
        print("\n[Group 3: Error Boundaries & Safety]")
        do {
            let nonExistent = fixturesURL.appendingPathComponent("does-not-exist.md")
            assertTrue(!FileManager.default.fileExists(atPath: nonExistent.path), "Non-existent path correctly recognized")

            var isDir: ObjCBool = false
            _ = FileManager.default.fileExists(atPath: fixturesURL.path, isDirectory: &isDir)
            assertTrue(isDir.boolValue, "Directory path identified, guarded from being read as file")

            let allowedRoot = fixturesURL.appendingPathComponent("special paths").path
            let allowedImage = fixturesURL.appendingPathComponent("special paths/image.png").path
            let traversalTarget = fixturesURL.appendingPathComponent("outside.png").path
            assertTrue(LocalFileAccessPolicy.isPath(allowedImage, inside: allowedRoot), "Local image inside the document directory is allowed")
            assertTrue(!LocalFileAccessPolicy.isPath(traversalTarget, inside: allowedRoot), "Local image directory traversal is rejected")
        }

        // ----------------------------------------------------
        // Test 8: Folder Tree Scanning
        // ----------------------------------------------------
        print("\n[Group 4: Folder Tree Structure]")
        do {
            let keys: [URLResourceKey] = [.isDirectoryKey, .nameKey]
            let contents = try FileManager.default.contentsOfDirectory(at: fixturesURL, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
            var mdCount = 0
            var dirCount = 0
            for item in contents {
                if let res = try? item.resourceValues(forKeys: Set(keys)) {
                    if res.isDirectory == true {
                        dirCount += 1
                    } else if item.pathExtension.lowercased() == "md" {
                        mdCount += 1
                    }
                }
            }
            assertTrue(mdCount >= 8, "Scanned at least 8 markdown files in fixtures directory")
            assertTrue(dirCount >= 1, "Scanned subdirectories (e.g. 'special paths')")
        } catch {
            assertTrue(false, "Folder tree scan failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 9: Settings Persistence
        // ----------------------------------------------------
        print("\n[Group 5: Settings Persistence]")
        do {
            let settingsURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("moread_settings_test_\(UUID().uuidString)")
                .appendingPathComponent("moread-config.json")
            let settingsManager = SettingsManager(configURL: settingsURL)
            let initial = settingsManager.getSettings()
            assertTrue(initial["theme"] != nil, "Settings contains theme property")
            assertTrue(initial["readingWidth"] != nil, "Settings contains readingWidth property")
            assertEqual(initial["saveMode"] as? String, "manual", "Save mode defaults to manual")
            settingsManager.saveSettings(["saveMode": "auto"])
            assertEqual(settingsManager.getSettings()["saveMode"] as? String, "auto", "Auto save mode persists")
            settingsManager.saveSettings(["saveMode": "manual"])
            assertEqual(settingsManager.getSettings()["saveMode"] as? String, "manual", "Manual save mode persists")

            settingsManager.saveSettings(["theme": "dark", "fontSize": 18])
            let updated = settingsManager.getSettings()
            assertEqual(updated["theme"] as? String, "dark", "Theme updated to dark and persisted")
            assertEqual(updated["fontSize"] as? Int, 18, "FontSize updated to 18 and persisted")

            try? FileManager.default.removeItem(at: settingsURL.deletingLastPathComponent())
        }

        // ----------------------------------------------------
        // Test 10: File Watcher Modification Detection
        // ----------------------------------------------------
        print("\n[Group 6: FileWatcher Live Notification]")
        do {
            let tempDir = FileManager.default.temporaryDirectory
            let tempFile = tempDir.appendingPathComponent("moread_watch_test_\(UUID().uuidString).md")
            try "Initial Content\n".write(to: tempFile, atomically: true, encoding: .utf8)

            var changeDetected = false

            let watcher = FileWatcher { path in
                if path == tempFile.path {
                    changeDetected = true
                }
            }
            watcher.watch(filePath: tempFile.path)

            // Allow watcher dispatch source to register
            Thread.sleep(forTimeInterval: 0.1)

            // Simulate external write
            let handle = try FileHandle(forWritingTo: tempFile)
            handle.seekToEndOfFile()
            handle.write("Modified Line\n".data(using: .utf8)!)
            try handle.close()

            // Pump the RunLoop to allow debounced main queue dispatch
            let deadline = Date(timeIntervalSinceNow: 1.5)
            while !changeDetected && Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
            }

            watcher.stop()
            assertTrue(changeDetected, "FileWatcher correctly detected file modification and notified")
            try? FileManager.default.removeItem(at: tempFile)

            let firstFile = tempDir.appendingPathComponent("moread_watch_first_\(UUID().uuidString).md")
            let secondFile = tempDir.appendingPathComponent("moread_watch_second_\(UUID().uuidString).md")
            try "First\n".write(to: firstFile, atomically: true, encoding: .utf8)
            try "Second\n".write(to: secondFile, atomically: true, encoding: .utf8)
            var switchedPath: String?
            let switchingWatcher = FileWatcher { switchedPath = $0 }
            switchingWatcher.watch(filePath: firstFile.path)
            switchingWatcher.watch(filePath: secondFile.path)
            Thread.sleep(forTimeInterval: 0.1)
            let secondHandle = try FileHandle(forWritingTo: secondFile)
            secondHandle.seekToEndOfFile()
            secondHandle.write("Changed\n".data(using: .utf8)!)
            try secondHandle.close()

            let switchDeadline = Date(timeIntervalSinceNow: 1.5)
            while switchedPath == nil && Date() < switchDeadline {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
            }
            switchingWatcher.stop()
            assertTrue(switchedPath == secondFile.path, "FileWatcher survives an immediate switch to a second document")
            try? FileManager.default.removeItem(at: firstFile)
            try? FileManager.default.removeItem(at: secondFile)
        } catch {
            assertTrue(false, "FileWatcher test failed: \(error)")
        }

        // ----------------------------------------------------
        // Test 11: File Immutability Guarantee (Read-Only)
        // ----------------------------------------------------
        print("\n[Group 7: Zero File Modification / SHA-256 Immutability Check]")
        var allHashesMatch = true
        for (file, originalHash) in initialHashes {
            let currentHash = computeSHA256(url: file)
            if currentHash != originalHash {
                print("  ✗ HASH MISMATCH for \(file.lastPathComponent)!")
                allHashesMatch = false
            }
        }
        assertTrue(allHashesMatch, "All \(initialHashes.count) test fixtures have 100% identical SHA-256 hashes (Strictly Read-Only Guarantee)")

        // ----------------------------------------------------
        // Test 12: File Writing & Atomic Save & Suppression
        // ----------------------------------------------------
        print("\n[Group 8: File Writing & Self-Reload Suppression]")
        do {
            let tempDir = FileManager.default.temporaryDirectory
            let testSaveFile = tempDir.appendingPathComponent("moread_save_test_\(UUID().uuidString).md")
            let initialContent = "# Initial Content\n"
            try initialContent.write(to: testSaveFile, atomically: true, encoding: .utf8)

            var watcherTriggered = false
            let saveWatcher = FileWatcher { _ in watcherTriggered = true }
            saveWatcher.watch(filePath: testSaveFile.path)
            Thread.sleep(forTimeInterval: 0.1)

            // Test atomic write with suppression
            saveWatcher.suppressNextChange(for: testSaveFile.path, duration: 1.0)
            let updatedContent = "# Updated WYSIWYG Content\n\n- [x] Item 1\n"
            let data = updatedContent.data(using: .utf8)!
            try data.write(to: testSaveFile, options: .atomic)

            // Wait to verify suppression prevented notification
            let waitDeadline = Date(timeIntervalSinceNow: 0.5)
            while Date() < waitDeadline {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }
            assertTrue(!watcherTriggered, "suppressNextChange correctly suppressed notification during save")

            // Verify content on disk
            let readBack = try String(contentsOf: testSaveFile, encoding: .utf8)
            assertEqual(readBack, updatedContent, "Saved markdown content matches exact atomic write")

            saveWatcher.stop()
            try? FileManager.default.removeItem(at: testSaveFile)
        } catch {
            assertTrue(false, "Save & suppression test failed: \(error)")
        }

        // ----------------------------------------------------
        // Summary
        // ----------------------------------------------------
        print("\n==========================================")
        print("  Test Results: \(passedCount) Passed, \(failedCount) Failed")
        print("==========================================")

        if failedCount > 0 {
            exit(1)
        } else {
            exit(0)
        }
    }
}
