#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "  墨读 MoRead - Native Swift/WebKit Build"
echo "=========================================="

APP_NAME="MoRead"
VERSION="1.0.1"
DIST_DIR="$(pwd)/dist"
APP_BUNDLE="${DIST_DIR}/${APP_NAME}.app"
CONTENTS="${APP_BUNDLE}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES_DIR="${CONTENTS}/Resources"
WEB_DIR="${RESOURCES_DIR}/web"

# 1. Build Frontend Web Bundle
echo "[1/6] Building Web Bundle..."
npm run build:web

# 2. Prepare App Bundle Structure
echo "[2/6] Preparing Bundle Structure..."
rm -rf "${APP_BUNDLE}"
mkdir -p "${MACOS_DIR}"
mkdir -p "${RESOURCES_DIR}"
mkdir -p "${WEB_DIR}"

# 3. Compile Swift Native App
echo "[3/6] Compiling Swift Native AppKit + WebKit Host..."
swiftc -O -target arm64-apple-macos14.0 \
  -framework Cocoa \
  -framework WebKit \
  -framework UniformTypeIdentifiers \
  src-native/main.swift \
  src-native/AppDelegate.swift \
  src-native/MainWindowController.swift \
  src-native/NativeBridge.swift \
  src-native/FileWatcher.swift \
  src-native/SettingsManager.swift \
  -o "${MACOS_DIR}/${APP_NAME}"

chmod +x "${MACOS_DIR}/${APP_NAME}"

# 4. Copy Resources
echo "[4/6] Copying Assets & Metadata..."
cp src-native/Info.plist "${CONTENTS}/Info.plist"
echo -n "APPL????" > "${CONTENTS}/PkgInfo"
cp src-native/AppIcon.icns "${RESOURCES_DIR}/AppIcon.icns"
cp -R dist-renderer/* "${WEB_DIR}/"

# 5. Codesign (Ad-hoc)
echo "[5/6] Applying Ad-hoc Codesign..."
codesign --force --deep --sign - "${APP_BUNDLE}"

# 6. Package DMG and ZIP
echo "[6/6] Packaging DMG and ZIP..."
DMG_PATH="${DIST_DIR}/${APP_NAME}-${VERSION}-arm64.dmg"
ZIP_PATH="${DIST_DIR}/${APP_NAME}-${VERSION}-arm64.zip"
DMG_STAGING="${DIST_DIR}/dmg-staging"

rm -f "${DMG_PATH}" "${ZIP_PATH}"
rm -rf "${DMG_STAGING}"

# Create Staging Directory with Applications drag-and-drop link
mkdir -p "${DMG_STAGING}"
cp -R "${APP_BUNDLE}" "${DMG_STAGING}/"
ln -s /Applications "${DMG_STAGING}/Applications"

# Create DMG
hdiutil create "${DMG_PATH}" -volname "${APP_NAME}" -srcfolder "${DMG_STAGING}" -ov -format UDZO
rm -rf "${DMG_STAGING}"

# Create ZIP
ditto -c -k --keepParent "${APP_BUNDLE}" "${ZIP_PATH}"

# Generate Checksums
cd "${DIST_DIR}"
shasum -a 256 "${APP_NAME}-${VERSION}-arm64.dmg" "${APP_NAME}-${VERSION}-arm64.zip" > SHA256SUMS.txt
cd - > /dev/null

echo "=========================================="
echo "  Build Completed Successfully!"
echo "  App Bundle: ${APP_BUNDLE}"
echo "  DMG Package: ${DMG_PATH}"
echo "  ZIP Package: ${ZIP_PATH}"
echo "=========================================="
ls -lh "${DIST_DIR}"
