#!/bin/sh
set -eu
cd "$(dirname "$0")"
app="$PWD/build/Агент.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun swiftc -module-cache-path "$PWD/build/module-cache" -swift-version 5 -target arm64-apple-macosx14.0 -O -o "$app/Contents/MacOS/AgentDesktop" Sources/*.swift
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>tech.dobropalm.agent.mac</string>
<key>CFBundleName</key><string>Агент</string><key>CFBundleExecutable</key><string>AgentDesktop</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.3.0</string><key>CFBundleVersion</key><string>4</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Диктовка задач Агенту по нажатию микрофона.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Локальное распознавание продиктованных задач.</string>
</dict></plist>
PLIST
agent_server="${AGENT_SERVER_URL:-}"
if [ -z "$agent_server" ] && [ -f build/server-url.txt ]; then agent_server="$(cat build/server-url.txt)"; fi
if [ -n "$agent_server" ]; then
  /usr/bin/plutil -insert AgentServerURL -string "$agent_server" "$app/Contents/Info.plist"
fi
codesign --force --sign - "$app"
printf '%s\n' "$app"
