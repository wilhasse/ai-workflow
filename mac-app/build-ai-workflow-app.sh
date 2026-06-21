#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/mac-app/AiWorkflowNative"
DIST_DIR="$ROOT_DIR/mac-app/dist"
APP_NAME="${AI_WORKFLOW_APP_NAME:-AI Workflow}"
APP_DIR="$DIST_DIR/$APP_NAME.app"
OPEN_APP=false

for arg in "$@"; do
  case "$arg" in
    --open)
      OPEN_APP=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--open]" >&2
      exit 64
      ;;
  esac
done

swift build -c release --package-path "$PACKAGE_DIR"
BIN_DIR="$(swift build -c release --package-path "$PACKAGE_DIR" --show-bin-path)"
BIN_PATH="$BIN_DIR/AiWorkflowNative"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/AiWorkflowNative"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>AiWorkflowNative</string>
  <key>CFBundleIdentifier</key>
  <string>local.ai-workflow.native</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo "Built $APP_DIR"

if [[ "$OPEN_APP" == "true" ]]; then
  open "$APP_DIR"
fi
