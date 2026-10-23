#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QQ_APP="/Applications/QQ.app"
QQ_PKG="$QQ_APP/Contents/Resources/app/package.json"
CONTAINER="$HOME/Library/Containers/com.tencent.qq/Data"
DOCS="$CONTAINER/Documents"
NAPCAT_HOME="${NAPCAT_HOME:-$DOCS/napcat}"
LOADER="$DOCS/loadNapCat.js"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/Library/Caches}/qq-bridge-napcat"
CACHE_ZIP="$CACHE_DIR/NapCat.Shell.zip"
VERSION="${NAPCAT_VERSION:-v4.18.41}"
SHA256="${NAPCAT_SHA256:-6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b}"
URL="https://github.com/NapNeko/NapCatQQ/releases/download/$VERSION/NapCat.Shell.zip"
PROXY="https://gh-proxy.com/$URL"

say() { print -r -- "$*"; }
die() { print -r -- "错误：$*" >&2; exit 1; }

[[ -d "$QQ_APP" ]] || die "未安装 $QQ_APP"
[[ -f "$QQ_PKG" ]] || die "未找到 $QQ_PKG"
mkdir -p "$CACHE_DIR" "$DOCS" "$NAPCAT_HOME"

if [[ ! -f "$NAPCAT_HOME/napcat.mjs" ]]; then
  say "下载 NapCat $VERSION ..."
  if [[ ! -f "$CACHE_ZIP" ]] || ! print -r -- "$(shasum -a 256 "$CACHE_ZIP" | awk '{print $1}')" | grep -qx "$SHA256"; then
    rm -f "$CACHE_ZIP"
    curl -fL --connect-timeout 20 --max-time 600 --retry 2 -o "$CACHE_ZIP.part" "$PROXY" || \
      curl -fL --connect-timeout 20 --max-time 600 --retry 2 -o "$CACHE_ZIP.part" "$URL"
    mv "$CACHE_ZIP.part" "$CACHE_ZIP"
  fi
  actual="$(shasum -a 256 "$CACHE_ZIP" | awk '{print $1}')"
  [[ "$actual" == "$SHA256" ]] || die "NapCat 校验失败：$actual"
  unzip -oq "$CACHE_ZIP" -d "$NAPCAT_HOME"
fi
[[ -f "$NAPCAT_HOME/napcat.mjs" ]] || die "NapCat 解压后缺少 napcat.mjs"

cat > "$LOADER" <<'JS'
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadNapcat = process.argv.includes('--no-sandbox');
const appDir = path.join(process.resourcesPath, 'app');
const packageJson = require(path.join(appDir, 'package.json'));

if (loadNapcat) {
  (async () => {
    await import(pathToFileURL(path.join(__dirname, 'napcat/napcat.mjs')).href);
  })();
} else {
  const entry = ((version) => {
    if (version >= 29271) return './application.asar/app_launcher/index.js';
    if (version >= 28060) return './application/app_launcher/index.js';
    return './app_launcher/index.js';
  })(packageJson.buildVersion);
  require(path.join(appDir, entry));
  setImmediate(() => {
    if (global.launcher && global.launcher.installPathPkgJson) {
      global.launcher.installPathPkgJson.main = entry;
    }
  });
}
JS
chmod 644 "$LOADER"

CURRENT_MAIN="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("main",""))' "$QQ_PKG")"
if [[ "$CURRENT_MAIN" == "$LOADER" ]]; then
  say "QQ 入口已指向 NapCat。"
  exit 0
fi

say "需要管理员权限修改 QQ 入口（只改 package.json 的 main 字段）。"
say "如果系统提示“不允许”，到 系统设置 → 隐私与安全性 → App 管理，允许 Terminal 后重试。"

PATCHER="$(mktemp /tmp/qq-napcat-patch.XXXXXX.py)"
trap 'rm -f "$PATCHER"' EXIT
cat > "$PATCHER" <<'PY'
import json, sys
pkg, loader = sys.argv[1], sys.argv[2]
with open(pkg, 'r', encoding='utf-8') as f:
    data = json.load(f)
if not __import__('os').path.exists(pkg + '.bak'):
    with open(pkg + '.bak', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
data['main'] = loader
with open(pkg, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
chmod 700 "$PATCHER"

if ! sudo /usr/bin/python3 "$PATCHER" "$QQ_PKG" "$LOADER"; then
  say "修改失败。请在 系统设置 → 隐私与安全性 → App 管理 中允许 Terminal，然后重新运行。"
  open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppManagement" 2>/dev/null || true
  exit 1
fi

sudo chown root:wheel "$QQ_PKG"
sudo chmod 644 "$QQ_PKG"
say "完成。启动 QQ 后 NapCat 会加载；WebUI 默认在 http://127.0.0.1:6099。"
