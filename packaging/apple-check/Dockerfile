# Type-checks HataVoice's Rust for macOS and iOS without a Mac, in a container so that nothing lands on the owner's PC.
# It cannot build or link (that needs Apple's SDK, which only comes with Xcode on a Mac): C code in dependencies is
# "compiled" by a stand-in that makes empty objects, which is enough for `cargo check`. What it proves is that every
# line of our Rust compiles for those systems, with their cfgs and Tauri's APIs there. The real build is in
# .github/workflows/build.yml.
FROM rust:1-bookworm
RUN rustup target add aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios \
    && apt-get update && apt-get install -y --no-install-recommends llvm \
    && rm -rf /var/lib/apt/lists/*
COPY fakecc.sh /usr/local/bin/fakecc
RUN chmod +x /usr/local/bin/fakecc
