#!/bin/sh
# Runs inside the apple-check container: `cargo check` of the app and the server for macOS and iOS.
#   docker build -t hv-apple-check packaging/apple-check
#   docker run --rm -v "$PWD:/src:ro" -v hv-apple-cargo:/usr/local/cargo/registry -v hv-apple-target:/target hv-apple-check sh /src/packaging/apple-check/check.sh
# The page must be built first (client/dist): Tauri puts it into the binary while compiling.
set -e
# Tauri's build writes next to the sources (gen/schemas): it works on a copy, the mounted tree stays untouched.
mkdir -p /work
tar -C /src --exclude=./target --exclude=./client/node_modules --exclude=./vendor --exclude=./.git -cf - . | tar -C /work -xf -
cd /work
export CARGO_TARGET_DIR=/target
# cc-rs reads CC_<target> with the target's dashes as underscores, in lower case.
for triple in aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios; do
  var=$(echo "$triple" | tr '-' '_')
  export "CC_$var=fakecc" "CXX_$var=fakecc" "AR_$var=llvm-ar"
done
# For iOS cc-rs asks xcrun where the SDK is: there is none, and the stand-in compiler needs none.
mkdir -p /opt/no-sdk
export SDKROOT=/opt/no-sdk
status=0
for triple in ${TRIPLES:-aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios}; do
  echo "=== $triple"
  case "$triple" in
    *-ios) packages="-p hatavoice" ;;
    *) packages="-p hatavoice -p hatavoice-server" ;;
  esac
  cargo check --locked --target "$triple" $packages --message-format short || status=1
done
exit $status
