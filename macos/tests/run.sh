#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
for suite in CoreValidation AutomationValidation; do
  xcrun swiftc -module-cache-path "$PWD/build/module-cache" -target arm64-apple-macosx14.0 Sources/Core.swift Sources/Automation.swift "tests/$suite.swift" -o "build/$suite"
  "build/$suite"
done
