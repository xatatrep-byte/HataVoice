# What it takes to build HataVoice for Linux, kept in a container so that nothing lands on the builder's PC.
# Debian bookworm keeps the glibc requirement low: the result runs on Ubuntu 22.04+, Debian 12+, Fedora 36+, and so on.
FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    patchelf file xdg-utils fuse3 rpm \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && npm install -g pnpm@10 && rm -rf /var/lib/apt/lists/*
