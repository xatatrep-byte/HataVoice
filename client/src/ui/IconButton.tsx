import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Accessible name and tooltip. */
  label: string;
  /** Toggle state; omit for plain action buttons. */
  active?: boolean;
  tone?: "default" | "danger" | "off";
  /** A word under the icon. */
  caption?: string;
  children: ReactNode;
};

export function IconButton({ label, active, tone = "default", caption, className = "", children, ...rest }: Props) {
  const classes = ["icon-btn", tone !== "default" ? tone : "", active ? "active" : "", className].filter(Boolean);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-label={label}
      aria-pressed={active}
      title={label}
      {...rest}
    >
      {children}
      {caption && (
        <span className="icon-btn-caption" aria-hidden>
          {caption}
        </span>
      )}
    </button>
  );
}
