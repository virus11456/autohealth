#!/usr/bin/env bash
# Compiles and runs the Foundation-only scoring core on any platform with a
# Swift toolchain (macOS or Linux). No Xcode needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
WORK="${CORE_CHECK_DIR:-$(mktemp -d)}"
PKG="$WORK/CoreCheck"
mkdir -p "$PKG/Sources/CoreCheck"
cat > "$PKG/Package.swift" <<'PKG'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "CoreCheck",
    targets: [ .executableTarget(name: "CoreCheck", path: "Sources/CoreCheck") ]
)
PKG
cp "$ROOT/AutoHealth/Core/"*.swift "$PKG/Sources/CoreCheck/"
cp "$HERE/CoreCheck/main.swift" "$PKG/Sources/CoreCheck/main.swift"
cd "$PKG"
swift run -c release 2>&1 | grep -v "^\[" || true
