import { AlertCircle, Info, X } from "lucide-react";
import { IconButton } from "./IconButton";
import { useToasts } from "./toasts";

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? (
            <AlertCircle size={18} color="var(--danger)" aria-hidden />
          ) : (
            <Info size={18} color="var(--accent)" aria-hidden />
          )}
          <span className="toast-text">{t.text}</span>
          <IconButton label="Закрыть уведомление" onClick={() => dismiss(t.id)}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
