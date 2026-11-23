import { Check } from "lucide-react";

type Props<T extends string> = {
  label: string;
  value: T;
  options: readonly T[];
  /** CSS color for each option, e.g. `var(--av-pink)`. */
  colorOf: (option: T) => string;
  nameOf: (option: T) => string;
  onChange: (value: T) => void;
};

export function Swatches<T extends string>({ label, value, options, colorOf, nameOf, onChange }: Props<T>) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="swatches" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            aria-label={nameOf(o)}
            title={nameOf(o)}
            className="swatch"
            style={{ background: colorOf(o) }}
            onClick={() => onChange(o)}
          >
            {o === value && <Check size={16} color="#fff" />}
          </button>
        ))}
      </div>
    </div>
  );
}
