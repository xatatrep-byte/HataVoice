# Shared by mac.sh and iphone.sh (sourced, not run). Bash 3.2: the one every Mac has.
#
# Rust, Node.js and pnpm go into .tools inside the source folder, so deleting the folder removes them. Only Apple's own
# tools (Xcode or its command line tools) and, for the iPhone, Homebrew live outside it.

set -Eeuo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS="$SRC/.tools"
LOG="${HV_LOG:-$SRC/build.log}"
NODE_LINE="v24"        # the line the owner's PC builds with
PNPM_VERSION="12.15.0" # the one in build.yml and on the owner's PC
mkdir -p "$TOOLS"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Something the friend can fix: say what, no log needed.
stop() {
  printf '\n\033[1;33m%s\033[0m\n' "$*"
  exit 1
}

on_error() {
  printf '\n\033[1;31mСборка остановилась с ошибкой (строка %s).\033[0m\n' "$1"
  printf 'Весь вывод сохранён в файле:\n  %s\nПришли этот файл тому, кто дал тебе программу.\n' "$LOG"
}
trap 'on_error $LINENO' ERR

check_mac() {
  local version major
  version=$(sw_vers -productVersion)
  major=${version%%.*}
  [ "$major" -ge "$1" ] || stop "Нужна macOS $1 или новее, а на этом Маке $version."
  note "macOS $version, $(uname -m)"
}

check_path() {
  case "$SRC" in
    *" "*) stop "В пути к папке есть пробел: $SRC
Перенеси папку HataVoice, например, в «Загрузки» (чтобы путь был без пробелов) и запусти снова." ;;
  esac
}

need_space_gb() {
  local free
  free=$(df -g "$SRC" | awk 'NR == 2 { print $4 }')
  [ "${free:-0}" -ge "$1" ] || stop "Свободно ${free} ГБ, а для сборки нужно около $1 ГБ. Освободи место и запусти снова."
}

# Files from a downloaded archive carry the quarantine mark, and copies made from them keep it.
unquarantine() {
  xattr -dr com.apple.quarantine "$1" 2>/dev/null || true
}

ensure_rust() {
  export RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    say "Ставлю Rust (в папку .tools, систему не трогаю)"
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$TOOLS/rustup-init.sh"
    sh "$TOOLS/rustup-init.sh" -y --no-modify-path --profile minimal --default-toolchain stable
    rm -f "$TOOLS/rustup-init.sh"
  fi
  note "$(rustc --version)"
}

ensure_node() {
  local dir="$TOOLS/node" arch base name
  if [ ! -x "$dir/bin/node" ]; then
    say "Ставлю Node.js (в папку .tools)"
    case "$(uname -m)" in
      arm64) arch=arm64 ;;
      *) arch=x64 ;;
    esac
    base="https://nodejs.org/dist/latest-$NODE_LINE.x"
    curl -fsSL "$base/SHASUMS256.txt" -o "$TOOLS/node-sums.txt"
    name=$(awk -v want="-darwin-$arch.tar.gz" '{ n = $2; if (length(n) > length(want) && substr(n, length(n) - length(want) + 1) == want) print n }' "$TOOLS/node-sums.txt" | head -1)
    [ -n "$name" ] || stop "На nodejs.org не нашлось Node.js $NODE_LINE для этого Мака."
    curl -fSL "$base/$name" -o "$TOOLS/$name"
    (cd "$TOOLS" && grep "  $name\$" node-sums.txt | shasum -a 256 -c -)
    rm -rf "$dir"
    mkdir -p "$dir"
    tar -xzf "$TOOLS/$name" -C "$dir" --strip-components 1
    rm -f "$TOOLS/$name" "$TOOLS/node-sums.txt"
  fi
  export PATH="$dir/bin:$PATH"
  export npm_config_cache="$TOOLS/npm-cache"
  note "Node.js $(node --version)"
}

ensure_pnpm() {
  if [ ! -x "$TOOLS/pnpm/bin/pnpm" ]; then
    say "Ставлю pnpm (в папку .tools)"
    npm install --global --prefix "$TOOLS/pnpm" "pnpm@$PNPM_VERSION" --no-fund --no-audit
  fi
  export PATH="$TOOLS/pnpm/bin:$PATH"
  note "pnpm $(pnpm --version)"
}

install_packages() {
  say "Скачиваю библиотеки интерфейса"
  cd "$SRC/client"
  pnpm install --frozen-lockfile --store-dir "$TOOLS/pnpm-store"
}
