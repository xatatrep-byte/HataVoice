import { useRef, useState } from "react";
import { Floating } from "../../ui/Floating";
import type { NetJudgement } from "../../voice/netQuality";

const BLAME_WORD: Record<NetJudgement["blame"], string> = {
  none: "",
  me: "У тебя",
  them: "У собеседника",
  server: "У сервера",
  unknown: "",
};

function level(bars: number): string {
  return bars >= 5 ? "great" : bars === 4 ? "good" : bars === 3 ? "fair" : bars >= 1 ? "poor" : "lost";
}

/**
 * Five bars of how a voice gets through, colored by how good it is. Resting the pointer on them shows the numbers and,
 * when something is wrong, whose side it is on.
 */
export function NetBars({ net, label = "Связь" }: { net: NetJudgement | null | undefined; label?: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!net || net.bars === null) return null;
  const bars = net.bars;
  const later = (value: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(value), ms);
  };
  const name = `${label}: ${bars} из 5. ${net.summary}`;
  return (
    <span className={`netbars n-${level(bars)}`} onMouseEnter={() => later(true, 150)} onMouseLeave={() => later(false, 200)}>
      <button ref={button} type="button" className="netbars-button" aria-label={name} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((o) => !o)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={i <= bars ? "bar on" : "bar"} style={{ height: 3 + i * 2.4 }} />
        ))}
      </button>
      {open && (
        <Floating anchor={button} className="netbars-card" role="tooltip" onMouseEnter={() => later(true, 0)} onMouseLeave={() => later(false, 200)}>
          <span className="netbars-head">
            <strong>
              {label}: {bars} из 5
            </strong>
            {net.blame !== "none" && net.blame !== "unknown" && <span className={`netbars-blame b-${net.blame}`}>{BLAME_WORD[net.blame]}</span>}
          </span>
          <span className="netbars-summary">{net.summary}</span>
          {net.details.map((line) => (
            <span key={line} className="netbars-line">
              {line}
            </span>
          ))}
        </Floating>
      )}
    </span>
  );
}
