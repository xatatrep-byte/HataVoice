type Props = {
  /** 0–1. */
  level: number;
  /** Optional marker (0–1), e.g. the voice activation threshold. */
  marker?: number;
  /** Colors the fill as "open" when the level passes the marker. */
  label?: string;
};

export function LevelMeter({ level, marker, label = "Уровень микрофона" }: Props) {
  const clamped = Math.max(0, Math.min(1, level));
  const above = marker === undefined || clamped >= marker;
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)}>
      <div className={above ? "meter-fill open" : "meter-fill"} style={{ width: `${clamped * 100}%` }} />
      {marker !== undefined && <div className="meter-marker" style={{ left: `${marker * 100}%` }} />}
    </div>
  );
}
