#!/bin/bash
# Inside the hv-android-build container: /src is the repository, read-only; /out is where the APK lands; /keys holds the key
# that signs it (made once: an update must be signed with the same key, or Android refuses to install it over the old one).
# Usage (from the repository's root):
#   docker build -t hv-android-build packaging/android
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/out" -v "$PWD/vendor/android:/keys:ro" -v hv-android-cargo:/usr/local/cargo/registry -v hv-android-target:/target -v hv-android-gradle:/root/.gradle hv-android-build bash /src/packaging/android/build.sh
set -euo pipefail
export CARGO_TARGET_DIR=/target
# The one that wrote the lock file: another reads its patches differently.
npm install -g pnpm@12.15.0 >/dev/null
BUILD_TOOLS="$ANDROID_HOME/build-tools/35.0.0"

mkdir -p /work
tar -C /src --exclude=./target --exclude=node_modules --exclude=./vendor --exclude=./dist --exclude=./client/dist --exclude=./.git -cf - . | tar -C /work -xf -
cd /work/client
pnpm install --frozen-lockfile

if [ ! -d src-tauri/gen/android ]; then
  pnpm tauri android init --ci
fi
# The launcher icons from the program's own picture, not the generated project's.
pnpm tauri icon src-tauri/icons/icon.png --output /tmp/icons >/dev/null
cp -r /tmp/icons/android/. src-tauri/gen/android/app/src/main/res/
# Kept in the repository so that they survive a fresh `init`.
cp -r /work/packaging/android/overlay/. src-tauri/gen/android/
python3 /work/packaging/android/manifest.py src-tauri/gen/android/app/src/main/AndroidManifest.xml
# The same agent as the PC's watch window, for «Любой сайт» in Android's own window (WatchActivity).
mkdir -p src-tauri/gen/android/app/src/main/assets
cp src-tauri/src/watch_agent.js src-tauri/gen/android/app/src/main/assets/watch_agent.js

# The app's version: Android judges updates by it, and the CLI does not look for it in Cargo.toml. A checkout made on
# Windows may end its lines with CR.
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' /work/Cargo.toml | head -1 | tr -d '\r')

# A server hosted on the phone: hatavoice-server built for Android and LiveKit built from its source for 64-bit ARM Linux
# (a static Go program), with Go and LiveKit patched for what Android keeps from apps (packaging/android/livekit). Both go
# in as libraries: Android unpacks only those, and only from their folder may an app start a program (see manifest.py
# and host.rs).
TOOLCHAIN="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android24-clang"
export CXX_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android24-clang++"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
export RANLIB_aarch64_linux_android="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
(cd /work && cargo build --release -p hatavoice-server --target aarch64-linux-android)
JNI=src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a
mkdir -p "$JNI"
cp /target/aarch64-linux-android/release/hatavoice-server "$JNI/libhvserver.so"
LIVEKIT=1.13.10
LIVEKIT_SOURCE_SHA256=d1b93ced314b14654faceeb99627a79114b8ebe002bb5d620be4a185db83a4b2
curl -fsSL "https://github.com/livekit/livekit/archive/refs/tags/v$LIVEKIT.tar.gz" -o /tmp/livekit-src.tgz
echo "$LIVEKIT_SOURCE_SHA256  /tmp/livekit-src.tgz" | sha256sum -c -
rm -rf /tmp/livekit-src && mkdir -p /tmp/livekit-src && tar -C /tmp/livekit-src -xzf /tmp/livekit-src.tgz
sh /work/packaging/android/livekit/patch-livekit.sh "/tmp/livekit-src/livekit-$LIVEKIT"
(cd "/tmp/livekit-src/livekit-$LIVEKIT" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -mod=vendor -trimpath -ldflags "-s -w" -o /tmp/livekit-server ./cmd/server)
cp /tmp/livekit-server "$JNI/liblivekit.so"
file "$JNI/libhvserver.so" "$JNI/liblivekit.so"
# What the server needs from the phone at start: only Android's own libraries may be listed (a library the app carries is
# not found by a program it starts, and the server would die at once).
"$TOOLCHAIN/llvm-readelf" -d "$JNI/libhvserver.so" | grep NEEDED
pnpm tauri android build --apk --target aarch64 --ci --config "{\"version\":\"$VERSION\"}"

UNSIGNED=$(find src-tauri/gen/android/app/build/outputs/apk -name '*-unsigned.apk' | head -1)
KEY=/keys/hatavoice.jks
# Mounted read-only by the build script: a missing key is an error, never a new key made by mistake (phones would then
# refuse every update until the app is removed).
if [ ! -f "$KEY" ] && [ ! -w /keys ]; then
  echo "No signing key in /keys" >&2
  exit 1
fi
if [ ! -f "$KEY" ]; then
  keytool -genkeypair -keystore "$KEY" -storepass hatavoice -keypass hatavoice -alias hatavoice \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=HataVoice"
fi
"$BUILD_TOOLS/zipalign" -f 4 "$UNSIGNED" /tmp/aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks "$KEY" --ks-pass pass:hatavoice --key-pass pass:hatavoice --out "/out/HataVoice_${VERSION}_android-arm64.apk" /tmp/aligned.apk
"$BUILD_TOOLS/apksigner" verify --print-certs "/out/HataVoice_${VERSION}_android-arm64.apk" | head -2
ls -la /out
# The generated project, for the repository.
if [ -d /gen ]; then
  rm -rf /gen/android
  mkdir -p /gen/android
  tar -C src-tauri/gen/android --exclude=build --exclude=.gradle --exclude='*.so' --exclude=local.properties --exclude='assets' -cf - . | tar -C /gen/android -xf -
fi
