#!/bin/sh
# Go's network interfaces as an Android app may read them (see interface_linux_denied.go): run over a Go tree before
# LiveKit is built for the phone. Usage: patch-go.sh <GOROOT>. Running it twice changes nothing.
set -eu
GOROOT_DIR="$1"
HERE=$(dirname "$0")
NETLINK="$GOROOT_DIR/src/syscall/netlink_linux.go"
IFACE="$GOROOT_DIR/src/net/interface_linux.go"

# A netlink socket Android will not let bind is bound by the kernel itself on the first send.
if ! grep -q 'err != EACCES && err != EPERM' "$NETLINK"; then
  perl -pi -e 's/^\tif err := Bind\(s, sa\); err != nil \{$/\tif err := Bind(s, sa); err != nil && err != EACCES && err != EPERM {/' "$NETLINK"
fi
grep -q 'if err := Bind(s, sa); err != nil && err != EACCES && err != EPERM {' "$NETLINK"

# Go's own interface table stays, under another name, and is tried first.
if ! grep -q '^func interfaceTableByLink(' "$IFACE"; then
  perl -pi -e 's/^func interfaceTable\(ifindex int\) \(\[\]Interface, error\) \{$/func interfaceTableByLink(ifindex int) ([]Interface, error) {/' "$IFACE"
fi
grep -q '^func interfaceTableByLink(ifindex int) (\[\]Interface, error) {$' "$IFACE"
cp "$HERE/interface_linux_denied.go" "$GOROOT_DIR/src/net/interface_linux_denied.go"
echo "Go patched for Android's netlink rules"
