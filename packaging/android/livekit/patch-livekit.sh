#!/bin/sh
# LiveKit's own source as an Android app may run it: run in the unpacked source before it is built for the phone, with a
# Go tree already patched by patch-go.sh. Usage: patch-livekit.sh <LiveKit source dir>.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$1"

# Its dependencies in the tree, so that one of them can be corrected (go.sum still checks what was downloaded).
go mod vendor

# The processor's and memory's stats: read where Android lets, assumed where it does not (hwstats_fallback_linux.go).
HW=vendor/github.com/livekit/protocol/utils/hwstats
perl -pi -e 's/^func newPlatformCPUMonitor\(\) \(platformCPUMonitor, error\) \{$/func newPlatformCPUMonitorStrict() (platformCPUMonitor, error) {/' "$HW/cpu_linux.go"
grep -q '^func newPlatformCPUMonitorStrict() (platformCPUMonitor, error) {$' "$HW/cpu_linux.go"
perl -pi -e 's/^func newPlatformMemoryGetter\(\) \(platformMemoryGetter, error\) \{$/func newPlatformMemoryGetterStrict() (platformMemoryGetter, error) {/' "$HW/memory_linux.go"
grep -q '^func newPlatformMemoryGetterStrict() (platformMemoryGetter, error) {$' "$HW/memory_linux.go"
cp "$HERE/hwstats_fallback_linux.go" "$HW/hwstats_fallback_linux.go"

# The load average: Android keeps /proc/loadavg from apps, and without it the node's stats never update, the node counts
# as gone, and no room is made («could not establish signal connection»).
LOAD=pkg/telemetry/prometheus/node_nonwindows.go
perl -0pi -e 's/\treturn loadavg\.Get\(\)\n/\tif stats, err := loadavg.Get(); err == nil {\n\t\treturn stats, nil\n\t}\n\treturn &loadavg.Stats{}, nil\n/' "$LOAD"
grep -q 'return &loadavg.Stats{}, nil' "$LOAD"
echo "LiveKit patched for Android"
