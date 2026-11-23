// HataVoice: a copy of this file goes into LiveKit's vendored livekit/protocol before it is built for the phone (see
// patch-livekit.sh). An Android app may read neither the cgroup's cpu files nor /proc/stat, and LiveKit stopped at its
// start («open /sys/fs/cgroup/cpu.stat: permission denied»). Without them it takes the processor for idle (a phone
// hosts a handful of friends) and the memory from /proc/meminfo where it can.

//go:build linux

package hwstats

import (
	"runtime"

	"github.com/livekit/protocol/logger"
)

func newPlatformCPUMonitor() (platformCPUMonitor, error) {
	p, err := newPlatformCPUMonitorStrict()
	if err == nil {
		return p, nil
	}
	logger.Infow("cpu stats unavailable, taking the processor for idle", "error", err)
	return unknownCPUMonitor{}, nil
}

type unknownCPUMonitor struct{}

func (unknownCPUMonitor) getCPUIdle() (float64, error) { return float64(runtime.NumCPU()), nil }

func (unknownCPUMonitor) numCPU() float64 { return float64(runtime.NumCPU()) }

func newPlatformMemoryGetter() (platformMemoryGetter, error) {
	p, err := newPlatformMemoryGetterStrict()
	if err == nil {
		return p, nil
	}
	logger.Infow("cgroup memory stats unavailable, using /proc/meminfo", "error", err)
	return &osStatMemoryGetter{}, nil
}
