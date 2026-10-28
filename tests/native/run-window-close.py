"""Run the production window/termination regression with isolated app storage."""
import json
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="moread-window-close-") as folder:
    root = Path(folder)
    settings = (repo / "src-native/SettingsManager.swift").read_text()
    original = "let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!"
    assert settings.count(original) == 1
    settings = settings.replace(original, f"let appSupport = URL(fileURLWithPath: {json.dumps(str(root))})")
    (root / "SettingsManager.swift").write_text(settings)
    bridge = (repo / "src-native/NativeBridge.swift").read_text()
    original = "self.init(settingsManager: .shared)"
    assert bridge.count(original) == 1
    bridge = bridge.replace(original, f"self.init(settingsManager: .shared, draftsDirectory: URL(fileURLWithPath: {json.dumps(str(root / 'Drafts'))}), documentsDirectory: URL(fileURLWithPath: {json.dumps(str(root / 'Documents'))}))")
    (root / "NativeBridge.swift").write_text(bridge)
    sources = [repo / "src-native" / name for name in [
        "AppDelegate.swift", "MainWindowController.swift", "PDFExporter.swift",
        "FileWatcher.swift", "LocalFileSchemeHandler.swift",
    ]]
    subprocess.run([
        "swiftc", "-parse-as-library", "-module-cache-path", "/tmp/moread-window-close-module-cache",
        "-target", "arm64-apple-macos14.0", "-framework", "Cocoa", "-framework", "WebKit",
        "-framework", "UniformTypeIdentifiers", "-framework", "PDFKit",
        *map(str, sources), str(root / "SettingsManager.swift"), str(root / "NativeBridge.swift"),
        str(repo / "tests/native/TestWindowClose.swift"), "-o", str(root / "window-close-tests"),
    ], cwd=repo, check=True, timeout=120)
    subprocess.run([str(root / "window-close-tests"), str(root)], cwd=repo, check=True, timeout=35)
