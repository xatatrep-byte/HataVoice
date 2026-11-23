#!/bin/bash
# Builds HataVoice and puts it on the iPhone connected to this Mac, signed with the friend's free Apple ID through Xcode
# (Apple keeps such an install for 7 days; running this again renews it and keeps the app's data). Started by
# «Собрать для iPhone.command».
#
# The bundle id is made from the friend's team (com.hatavoice.t<team>): an id is Apple's to give once, and the plain
# com.hatavoice.app is left for the owner's own account.

. "$(dirname "${BASH_SOURCE[0]}")/tools.sh"

ensure_xcode() {
  local xcode=""
  if [ -d /Applications/Xcode.app ]; then
    xcode=/Applications/Xcode.app
  else
    xcode=$(ls -d /Applications/Xcode*.app 2>/dev/null | head -1 || true)
  fi
  [ -n "$xcode" ] || stop "Для iPhone нужен Xcode. Поставь его из App Store, открой один раз (он доустановит своё) и запусти этот файл снова."
  # Xcode itself, even when the command line tools are the system's choice: no sudo xcode-select needed.
  export DEVELOPER_DIR="$xcode/Contents/Developer"
  if ! xcodebuild -version >/dev/null 2>&1; then
    xcodebuild -version || true
    stop "Xcode ещё не готов (выше видно почему). Открой Xcode, согласись с лицензией, дождись установки компонентов и запусти этот файл снова."
  fi
  if ! xcodebuild -showsdks 2>/dev/null | grep -q iphoneos; then
    stop "В Xcode нет поддержки iOS. Xcode → Settings → Components (или Platforms) → iOS → Get, потом запусти этот файл снова."
  fi
  note "$(xcodebuild -version | head -1)"
}

# Tauri makes the Xcode project with xcodegen and checks for cocoapods and libimobiledevice; without them it asks
# Homebrew, so Homebrew comes first.
ensure_brew_tools() {
  local brew="" b missing=""
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then brew=$b; break; fi
  done
  if [ -z "$brew" ]; then
    say "Нужен Homebrew: через него ставятся xcodegen, cocoapods и libimobiledevice"
    note "Сейчас запустится официальный установщик с brew.sh. Он спросит пароль от этого Мака"
    note "(при вводе пароль не видно, это нормально) и попросит нажать Enter."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$b" ]; then brew=$b; break; fi
    done
    [ -n "$brew" ] || stop "Homebrew не поставился. Попробуй поставить его сам с сайта brew.sh и запусти этот файл снова."
  fi
  eval "$("$brew" shellenv)"
  command -v xcodegen >/dev/null 2>&1 || missing="$missing xcodegen"
  command -v pod >/dev/null 2>&1 || missing="$missing cocoapods"
  command -v idevicesyslog >/dev/null 2>&1 || missing="$missing libimobiledevice"
  if [ -n "$missing" ]; then
    say "Ставлю через Homebrew:$missing"
    brew install $missing
  fi
}

# Lines «TEAMID<TAB>name» of the Apple Development certificates in the keychain that have not expired.
find_teams() {
  local tmp f subject id org
  tmp=$(mktemp -d)
  security find-certificate -a -c "Apple Development" -p >"$tmp/all.pem" 2>/dev/null || true
  awk -v d="$tmp" '/-----BEGIN CERTIFICATE-----/ { n++ } n { print > (d "/c" n ".pem") }' "$tmp/all.pem"
  for f in "$tmp"/c*.pem; do
    [ -f "$f" ] || continue
    openssl x509 -in "$f" -noout -checkend 0 >/dev/null 2>&1 || continue
    subject=$(openssl x509 -in "$f" -noout -subject 2>/dev/null || true)
    id=$(printf '%s\n' "$subject" | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p')
    org=$(printf '%s\n' "$subject" | sed -n 's/.*[/,] *O *= *\([^/,]*\).*/\1/p')
    if [ -n "$id" ]; then printf '%s\t%s\n' "$id" "$org"; fi
  done | sort -u
  rm -rf "$tmp"
}

choose_team() {
  local teams count line
  if [ -n "${HV_TEAM:-}" ]; then
    TEAM=$HV_TEAM
    return
  fi
  teams=$(find_teams)
  count=$(printf '%s' "$teams" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    stop "Не нашёл сертификат Apple Development. В Xcode: Settings → Accounts → выбери свой Apple ID →
Manage Certificates… → «+» → Apple Development. Потом запусти этот файл снова."
  fi
  if [ "$count" -eq 1 ]; then
    TEAM=$(printf '%s' "$teams" | cut -f1)
  else
    say "Нашлось несколько команд Apple. Выбери свою (для бесплатного Apple ID — Personal Team):"
    local IFS=$'\n'
    select line in $teams; do
      if [ -n "$line" ]; then
        TEAM=$(printf '%s' "$line" | cut -f1)
        break
      fi
    done
  fi
  note "Команда Apple: $TEAM"
}

wait_for_iphone() {
  # devicectl is Xcode 15 and newer; without it Tauri asks about the device itself.
  xcrun devicectl list devices >/dev/null 2>&1 || return 0
  while ! xcrun devicectl list devices 2>/dev/null | grep -i iphone | grep -vi unavailable | grep -qiE 'available|connected'; do
    say "Не вижу iPhone"
    note "Подключи iPhone кабелем, разблокируй и нажми на нём «Доверять», если спросит."
    note "Потом нажми Enter здесь (или Ctrl+C, чтобы выйти)."
    read -r _
  done
}

say "Сборка ХатаВойс для iPhone"
check_mac 13
check_path
need_space_gb 15
unquarantine "$SRC"
ensure_xcode
ensure_brew_tools
ensure_rust
rustup target add aarch64-apple-ios
ensure_node
ensure_pnpm
choose_team
wait_for_iphone
install_packages

CONF="$TOOLS/ios.conf.json"
printf '{ "identifier": "com.hatavoice.t%s" }\n' "$(printf '%s' "$TEAM" | tr 'A-Z' 'a-z')" >"$CONF"
export APPLE_DEVELOPMENT_TEAM="$TEAM"

cd "$SRC/client"
if [ "$(cat "$TOOLS/ios-team" 2>/dev/null || true)" != "$TEAM" ]; then
  say "Готовлю проект Xcode"
  rm -rf src-tauri/gen/apple "$TOOLS/ios-team"
  pnpm tauri ios init --ci --skip-targets-install --config "$CONF"
  printf '%s' "$TEAM" >"$TOOLS/ios-team"
fi

say "Собираю и ставлю на iPhone (первый раз 15–40 минут)"
note "iPhone должен быть разблокирован. Если спросит «Доверять этому компьютеру?» — «Доверять»."
if pnpm tauri ios run --release --no-watch --config "$CONF"; then
  say "Готово: ХатаВойс на iPhone"
else
  printf '\n\033[1;33m%s\033[0m\n' "Если значок ХатаВойс уже появился на iPhone, а программа не открывается:"
  note "Настройки → Основные → VPN и управление устройством → твоя почта Apple ID → «Доверять»."
  note "Потом открой ХатаВойс на iPhone сам."
  note "Если значка нет — пришли файл $LOG тому, кто дал тебе программу."
  exit 1
fi
note "Это окно можно закрыть: программа останется на iPhone."
note "Через 7 дней Apple отключит её — тогда запусти этот файл снова, данные сохранятся."
