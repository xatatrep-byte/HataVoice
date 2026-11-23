#!/bin/bash
# Inside the hv-android-build container: does the program compile for Android? Faster than a whole build.
set -euo pipefail
export CARGO_TARGET_DIR=/target
TOOLCHAIN="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android24-clang"
export CXX_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android24-clang++"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
export RANLIB_aarch64_linux_android="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
mkdir -p /work
tar -C /src --exclude=./target --exclude=node_modules --exclude=./vendor --exclude=./dist --exclude=./client/dist --exclude=./.git -cf - . | tar -C /work -xf -
cd /work
mkdir -p client/dist
cargo check -p hatavoice --target aarch64-linux-android 2>&1 | grep -E '^(error|warning: unused)|^ +--> |could not compile|Finished' | head -120
