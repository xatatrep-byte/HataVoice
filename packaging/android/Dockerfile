# What it takes to build HataVoice for Android, kept in a container so that nothing lands on the builder's PC.
FROM rust:1-bookworm
ENV ANDROID_HOME=/android NDK_HOME=/android/ndk/27.2.12479018 JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip cmake clang libclang-dev file \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && npm install -g pnpm@10 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /android/cmdline-tools && cd /android/cmdline-tools \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o tools.zip \
    && unzip -q tools.zip && mv cmdline-tools latest && rm tools.zip \
    && yes | latest/bin/sdkmanager --licenses >/dev/null \
    && latest/bin/sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018" >/dev/null
RUN rustup target add aarch64-linux-android x86_64-linux-android
# Go for LiveKit, built from its source for the phone: its own Linux build stops on Android (see livekit/README.md). Go's
# network interfaces are patched first, as an Android app may read them.
ENV PATH=$PATH:/usr/local/go/bin
RUN curl -fsSL https://dl.google.com/go/go1.26.11.linux-amd64.tar.gz -o /tmp/go.tgz \
    && echo "9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec  /tmp/go.tgz" | sha256sum -c - \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
COPY livekit/ /opt/hv-livekit/
RUN sh /opt/hv-livekit/patch-go.sh /usr/local/go
