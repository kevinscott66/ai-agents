#!/bin/sh
set -eu
cd "$(dirname "$0")"
(cd ../agent/miniapp && bun run build --mode native)
agent_build="${AGENT_IOS_BUILD_DIR:-$PWD/build}"
mkdir -p "$agent_build"
xcodebuild -project Agent.xcodeproj -scheme Agent -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$agent_build/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' DEBUG_INFORMATION_FORMAT=dwarf build
mkdir -p "$agent_build/package/Payload"
ditto "$agent_build/DerivedData/Build/Products/Release-iphoneos/Agent.app" "$agent_build/package/Payload/Agent.app"
(cd "$agent_build/package" && /usr/bin/zip -qry "$agent_build/Agent-unsigned.ipa" Payload)
