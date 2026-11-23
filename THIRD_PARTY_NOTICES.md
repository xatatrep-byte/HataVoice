# Чужие материалы в ХатаВойс

Код ХатаВойс (© 2026 TRЁP XATA) распространяется под [GNU AGPL-3.0](LICENSE). Материалы ниже сделаны другими авторами и идут под их лицензиями.

## 3D-модели (`client/public/avatars`)

- **Шино, Шибу, Фумирия, Тёмная Шибу, Вита, Виви, Виктория** — модели VRoid (pixiv), CC0 1.0.
- **Чёрт, Дракула, Ведьма, Оборотень, Робот, Пират, Акула, Лунная, Глазастый маг, Кролик, Лягушонок, Мишка** — Polygonal Mind, 100Avatars, CC0 1.0 (https://www.polygonalmind.com).
- **Тигр** — Open Source Avatars, CC0 1.0 (https://opensourceavatars.com).
- **Рэн, Мира, Кай, Искра** — сделаны для ХатаВойс, CC0 1.0.

## Движения (`client/public/motions`)

- **Universal Animation Library 1 и 2 (Standard)** — Quaternius, CC0 1.0 (https://quaternius.com).
- **Bandai Namco Research Motion Dataset 1 и 2** — © 2022 Bandai Namco Research Inc., CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/), https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset. Только для некоммерческого использования: ХатаВойс бесплатный, пожертвования добровольные и ничего не открывают.

Подробнее — в `client/public/motions/CREDITS.txt`.

## Эмодзи (`client/public/emoji`)

- **Fluent Emoji** — Microsoft, MIT License (https://github.com/microsoft/fluentui-emoji).

## Распознавание позы (`client/public/mediapipe`, `client/src/vendor/mediapipe`)

- **MediaPipe** — Google, Apache License 2.0. Что изменено (вырезана отправка статистики в Google) — в `client/src/vendor/mediapipe/NOTICE.md`.

## Шрифты

- **Manrope** и **JetBrains Mono** — SIL Open Font License 1.1 (через пакеты Fontsource).

## Библиотеки

Программа собрана из открытых библиотек Rust и JavaScript (LiveKit, OpenMLS, Tauri, React, three.js, three-vrm и других). Каждая — под своей лицензией (MIT, Apache-2.0, BSD и подобные); список с версиями — в `Cargo.lock` и `client/pnpm-lock.yaml`. Исправленные копии некоторых библиотек лежат в `third_party/` вместе с их исходными лицензиями.
