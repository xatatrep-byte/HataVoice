import type { ReactNode } from "react";

type Props<T extends string> = {
  label: string;
  /** Beside the label: an «i» with an explanation. */
  labelExtra?: ReactNode;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string; tone?: "good" | "bad" | null }[];
  onChange: (value: T) => void;
};

/** A row of mutually exclusive buttons (theme, voice mode…). */
export function Segmented<T extends string>({ label, labelExtra, value, options, onChange }: Props<T>) {
  return (
    <div className="field">
      {labelExtra ? (
        <span className="field-label-row">
          <span className="field-label">{label}</span>
          {labelExtra}
        </span>
      ) : (
        <span className="field-label">{label}</span>
      )}
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={["segment", o.value === value && "active", o.tone && `tone-${o.tone}`].filter(Boolean).join(" ")}
            aria-pressed={o.value === value}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
