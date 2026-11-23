#!/bin/bash
# ХатаВойс для этого Мака. Как запустить: открой «Терминал», напиши bash и пробел, перетащи этот файл в окно
# Терминала и нажми Enter. Всё, что появится на экране, пишется ещё и в mac-build.log рядом с этим файлом.
cd "$(dirname "$0")" || exit 1
export HV_LOG="$PWD/mac-build.log"
exec /usr/bin/script -q "$HV_LOG" /bin/bash "$PWD/src/packaging/apple-friend/mac.sh"
