#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
root="$PWD"
core="$root/OpenFluxCore"
build="$core/build"
mkdir -p "$build/device" "$build/simulator"
for slice in device simulator; do
  sdk=iphoneos
  target=arm64-apple-ios17.0
  if [ "$slice" = simulator ]; then sdk=iphonesimulator; target=arm64-apple-ios17.0-simulator; fi
  sysroot=$(xcrun --sdk "$sdk" --show-sdk-path)
  clang=$(xcrun --find clang)
  (cd "$core" && GOOS=ios GOARCH=arm64 CGO_ENABLED=1 \
    CC="$clang -isysroot $sysroot -target $target" \
    CGO_CFLAGS="-isysroot $sysroot -target $target" \
    CGO_LDFLAGS="-isysroot $sysroot -target $target" \
    go build -mod=readonly -buildmode=c-archive -tags mobile -trimpath -ldflags='-s -w' \
    -o "$build/$slice/liboflux.a" .)
done
# Replace only this script's generated artifact.
rm -rf "$root/Agent/OpenFlux.xcframework"
xcodebuild -create-xcframework -library "$build/device/liboflux.a" \
  -library "$build/simulator/liboflux.a" -output "$root/Agent/OpenFlux.xcframework"
