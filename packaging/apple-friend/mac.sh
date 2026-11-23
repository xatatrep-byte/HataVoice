#!/bin/bash
# Builds HataVoice on this Mac and puts it into Applications. Started by «Собрать для Mac.command».
#
# Without the server and LiveKit inside (they come from tauri.bundle.conf.json): on a Mac the app only joins servers,
# and says so where Windows offers to make one. Signed ad hoc («-»): no Apple certificate is needed on the Mac that
# builds it, and nothing downloaded is left to Gatekeeper.

. "$(dirname "${BASH_SOURCE[0]}")/tools.sh"

ensure_command_line_tools() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Нужны инструменты разработчика от Apple"
    note "Сейчас появится окно: нажми «Установить» и дождись конца (5–15 минут)."
    note "Потом запусти этот файл снова."
    xcode-select --install || true
    exit 0
  fi
  if ! xcrun clang --version >/dev/null 2>&1; then
    xcrun clang --version || true
    stop "Инструменты Apple пока не работают (выше видно почему). Если там про лицензию Xcode — открой Xcode один раз и согласись, потом запусти этот файл снова."
  fi
}

say "Сборка ХатаВойс для Mac"
check_mac 13
check_path
need_space_gb 12
unquarantine "$SRC"
ensure_command_line_tools
ensure_rust
ensure_node
ensure_pnpm
install_packages

say "Собираю программу (первый раз 15–40 минут, дальше быстрее)"
cd "$SRC/client"
APPLE_SIGNING_IDENTITY=- pnpm tauri build --bundles app --config src-tauri/tauri.macos.bundle.conf.json

APP="$SRC/target/release/bundle/macos/HataVoice.app"
[ -d "$APP" ] || stop "Сборка прошла, но готовой программы нет на месте: $APP"

DEST=/Applications
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi
if pgrep -x hatavoice >/dev/null 2>&1; then
  note "Закрываю запущенный ХатаВойс, чтобы заменить его новым"
  pkill -x hatavoice || true
  sleep 2
fi
rm -rf "$DEST/HataVoice.app"
ditto "$APP" "$DEST/HataVoice.app"
unquarantine "$DEST/HataVoice.app"

say "Готово: ХатаВойс лежит в $DEST"
note "Открываю. Дальше он запускается как обычная программа: Launchpad или папка «Программы»."
open "$DEST/HataVoice.app"
