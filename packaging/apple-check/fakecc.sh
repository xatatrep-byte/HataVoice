#!/bin/sh
# A C compiler that compiles nothing: wherever the output goes it writes an empty object file for the target being
# built (TARGET, set by cargo for build scripts), so archivers take it, and says it worked. Only for `cargo check` of
# Apple targets, where nothing is linked (see the Dockerfile).
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    # cc-rs tells compilers apart by what `-E` prints from its probe: say clang (which also passes for gcc).
    -E) printf 'clang\ngcc\n'; exit 0 ;;
    # MSVC's way of asking for help: not ours.
    "-?") exit 1 ;;
    --version|-v) echo "clang version 18.0.0 (fakecc)"; exit 0 ;;
    -o) out="$2"; shift ;;
    -o*) out="${1#-o}" ;;
    -Fo*) out="${1#-Fo}" ;;
  esac
  shift
done
[ -z "$out" ] && exit 0
llvm-mc -triple="${TARGET:-aarch64-apple-darwin}" -filetype=obj -o "$out" /dev/null 2>/dev/null || : > "$out"
exit 0
