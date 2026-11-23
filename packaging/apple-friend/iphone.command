#!/bin/bash
# ХатаВойс для iPhone, подключённого к этому Маку. Как запустить: открой «Терминал», напиши bash и пробел, перетащи
# этот файл в окно Терминала и нажми Enter. Всё, что появится на экране, пишется ещё и в iphone-build.log рядом.
cd "$(dirname "$0")" || exit 1
export HV_LOG="$PWD/iphone-build.log"
exec /usr/bin/script -q "$HV_LOG" /bin/bash "$PWD/src/packaging/apple-friend/iphone.sh"
