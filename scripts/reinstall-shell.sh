#!/usr/bin/env bash
# 将本地新构建的壳层二进制替换到已安装的 App 里（临时修复/快速替换安装用）。
# runtime/harness/seed 不动：只有 Contents/MacOS/dsh-desktop 被替换（替换前自动备份到 /tmp）。
# 用法:
#   ./scripts/reinstall-shell.sh              # 用 target/release 里的 bundle 二进制
#   ./scripts/reinstall-shell.sh --full       # 同时重跑 pnpm run shell:build
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
APP="/Applications/DeepSeek Harness Desktop.app"
NAME="DeepSeek Harness Desktop"

if [ "${1:-}" = "--full" ]; then
  echo "==> rebuild shell (tauri build --bundles app)"
  (cd "$ROOT" && pnpm run shell:build)
fi

BIN_CANDIDATES=(
  "$ROOT/src-tauri/target/release/bundle/macos/$NAME.app/Contents/MacOS/dsh-desktop"
  "$ROOT/src-tauri/target/release/dsh-desktop"
)
BIN=""
for c in "${BIN_CANDIDATES[@]}"; do
  if [ -f "$c" ]; then BIN="$c"; break; fi
done
if [ -z "$BIN" ]; then
  echo "x 未找到已构建的 dsh-desktop 二进制，先运行: (cd \"$ROOT\" && pnpm run shell:build)" >&2
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "x 未找到已安装的 App: $APP" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
cp "$APP/Contents/MacOS/dsh-desktop" "/tmp/dsh-desktop.broken.$TS.bak"
cp "$BIN" "$APP/Contents/MacOS/dsh-desktop"
chmod +x "$APP/Contents/MacOS/dsh-desktop"

echo "==> 已替换 $APP/Contents/MacOS/dsh-desktop (来自 $BIN)"
echo "    旧二进制备份: /tmp/dsh-desktop.broken.$TS.bak"
echo "==> 现在可打开 App; 若 Gatekeeper 提示，右键->打开 或 xattr -dr com.apple.quarantine \"$APP\""