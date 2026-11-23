#!/bin/bash
# Runs inside the hv-linux-build container: /src is the repository, read-only; /out is where the packages land.
# Usage (from the repository's root):
#   docker build -t hv-linux-build packaging/linux
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/out" -v hv-linux-cargo:/usr/local/cargo/registry -v hv-linux-target:/target hv-linux-build bash /src/packaging/linux/build.sh
set -euo pipefail
export CARGO_TARGET_DIR=/target
# The one that wrote the lock file: another reads its patches differently.
npm install -g pnpm@12.15.0 >/dev/null
VERSION=1.13.10
ARCHIVE="livekit_${VERSION}_linux_amd64.tar.gz"

mkdir -p /work
tar -C /src --exclude=./target --exclude=node_modules --exclude=./vendor --exclude=./dist --exclude=./client/dist --exclude=./.git -cf - . | tar -C /work -xf -
cd /work

curl -fsSL "https://github.com/livekit/livekit/releases/download/v$VERSION/$ARCHIVE" -o "/tmp/$ARCHIVE"
# The checksum kept in the repository, not one fetched from where the file came from.
(cd /tmp && grep " $ARCHIVE\$" /work/packaging/livekit.sha256 | sha256sum -c -)
mkdir -p /tmp/livekit && tar -C /tmp/livekit -xzf "/tmp/$ARCHIVE"

cargo build --release -p hatavoice-server
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p client/src-tauri/binaries
cp "$CARGO_TARGET_DIR/release/hatavoice-server" "client/src-tauri/binaries/hatavoice-server-$TRIPLE"
cp /tmp/livekit/livekit-server "client/src-tauri/binaries/livekit-server-$TRIPLE"

cd client
pnpm install --frozen-lockfile
# The target folder outlives the container, with the packages of older versions in it.
rm -rf "$CARGO_TARGET_DIR/release/bundle"
pnpm tauri build --bundles deb,appimage --config src-tauri/tauri.bundle.conf.json

mkdir -p /out
cp "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage /out/ || true
ls -la /out
