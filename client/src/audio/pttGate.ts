export type PttGate = {
  press(): void;
  release(): void;
  dispose(): void;
};

/** Opens the mic while PTT is held and keeps it open for `tailMs` after release. */
export function createPttGate({
  tailMs,
  onChange,
}: {
  tailMs: number;
  onChange: (open: boolean) => void;
}): PttGate {
  let open = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelClose = () => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };
  const close = () => {
    closeTimer = undefined;
    open = false;
    onChange(false);
  };

  return {
    press() {
      cancelClose();
      if (!open) {
        open = true;
        onChange(true);
      }
    },
    release() {
      if (!open || closeTimer !== undefined) return;
      if (tailMs <= 0) close();
      else closeTimer = setTimeout(close, tailMs);
    },
    dispose() {
      cancelClose();
    },
  };
}
