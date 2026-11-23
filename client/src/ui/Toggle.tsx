type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
};

export function Toggle({ checked, onChange, label, hint }: Props) {
  return (
    <div className="toggle-row" onClick={() => onChange(!checked)}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        className="toggle"
        aria-checked={checked}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onChange(!checked);
        }}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}
