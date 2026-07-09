#!/bin/sh
set -eu

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required to build the native Keychain helper." >&2
  echo "Install them first: xcode-select --install" >&2
  echo "Then re-run: strava-mcp-bridge setup (or npm run setup)." >&2
  exit 1
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export CLANG_MODULE_CACHE_PATH="$ROOT_DIR/.build/module-cache"
export SWIFT_MODULE_CACHE_PATH="$ROOT_DIR/.build/module-cache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"
mkdir -p "$ROOT_DIR/bin"

swiftc "$ROOT_DIR/native/keychain-helper.swift" -O -o "$ROOT_DIR/bin/strava-keychain-helper"
