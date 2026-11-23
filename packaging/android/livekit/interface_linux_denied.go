// HataVoice: a copy of this file goes into Go's own `net` package before LiveKit is built for the phone (see
// patch-go.sh). Android 11+ refuses an app RTM_GETLINK and binding a netlink socket, so Go's net.Interfaces failed
// («route ip+net: netlinkrib: permission denied») and LiveKit stopped at its start. Then the interfaces are read from
// RTM_GETADDR, and their names, flags and MTU asked by ioctl, as Android's own libc does in getifaddrs. An interface
// with no address is not listed that way; LiveKit has no use for one.

package net

import (
	"os"
	"syscall"
	"unsafe"
)

func interfaceTable(ifindex int) ([]Interface, error) {
	ift, err := interfaceTableByLink(ifindex)
	if err == nil {
		return ift, nil
	}
	if byAddr, err2 := hvInterfaceTableByAddr(ifindex); err2 == nil {
		return byAddr, nil
	}
	return nil, err
}

// struct ifreq on 64-bit Linux: the name, then a union of 24 bytes.
type hvIfreq struct {
	name [syscall.IFNAMSIZ]byte
	data [24]byte
}

func hvInterfaceTableByAddr(ifindex int) ([]Interface, error) {
	tab, err := syscall.NetlinkRIB(syscall.RTM_GETADDR, syscall.AF_UNSPEC)
	if err != nil {
		return nil, os.NewSyscallError("netlinkrib", err)
	}
	msgs, err := syscall.ParseNetlinkMessage(tab)
	if err != nil {
		return nil, os.NewSyscallError("parsenetlinkmessage", err)
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, os.NewSyscallError("socket", err)
	}
	defer syscall.Close(fd)
	var ift []Interface
	seen := make(map[int]bool)
loop:
	for _, m := range msgs {
		switch m.Header.Type {
		case syscall.NLMSG_DONE:
			break loop
		case syscall.RTM_NEWADDR:
			if len(m.Data) < syscall.SizeofIfAddrmsg {
				continue
			}
			ifam := (*syscall.IfAddrmsg)(unsafe.Pointer(&m.Data[0]))
			index := int(ifam.Index)
			if seen[index] || (ifindex != 0 && ifindex != index) {
				continue
			}
			seen[index] = true
			ifi := Interface{Index: index}
			loopback := false
			attrs, _ := syscall.ParseNetlinkRouteAttr(&m)
			for _, a := range attrs {
				switch a.Attr.Type {
				case syscall.IFA_LABEL:
					if len(a.Value) > 1 {
						ifi.Name = hvCString(a.Value)
					}
				case syscall.IFA_ADDRESS, syscall.IFA_LOCAL:
					if len(a.Value) == IPv4len || len(a.Value) == IPv6len {
						loopback = loopback || IP(a.Value).IsLoopback()
					}
				}
			}
			if ifi.Name == "" {
				var req hvIfreq
				*(*int32)(unsafe.Pointer(&req.data[0])) = int32(index)
				if hvIoctl(fd, syscall.SIOCGIFNAME, &req) == nil {
					ifi.Name = hvCString(req.name[:])
				}
			}
			ifi.Flags = hvGuessedFlags(loopback)
			if ifi.Name != "" {
				var req hvIfreq
				copy(req.name[:syscall.IFNAMSIZ-1], ifi.Name)
				if hvIoctl(fd, syscall.SIOCGIFFLAGS, &req) == nil {
					ifi.Flags = linkFlags(uint32(*(*uint16)(unsafe.Pointer(&req.data[0]))))
				}
				req.data = [24]byte{}
				if hvIoctl(fd, syscall.SIOCGIFMTU, &req) == nil {
					ifi.MTU = int(*(*int32)(unsafe.Pointer(&req.data[0])))
				}
			}
			ift = append(ift, ifi)
			if ifindex != 0 {
				break loop
			}
		}
	}
	return ift, nil
}

// An interface with an address whose flags cannot be asked is taken to be up.
func hvGuessedFlags(loopback bool) Flags {
	if loopback {
		return FlagUp | FlagRunning | FlagLoopback
	}
	return FlagUp | FlagRunning | FlagMulticast
}

func hvIoctl(fd int, req uintptr, r *hvIfreq) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), req, uintptr(unsafe.Pointer(r))); e != 0 {
		return e
	}
	return nil
}

func hvCString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
