import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { serverErrorText } from "../../server/session";
import { Button } from "../../ui/Button";
import { THIS_DEVICE } from "../../platform";

type Props = {
  name: string;
  /** Why it stopped by itself (the last lines of its log); null when it was simply off. */
  crash: string | null;
  /** It was started: the page connects again. */
  onStarted: () => void;
};

/** The server of this PC is off: said plainly, with the switch, instead of «no connection» for ever. */
export function HostOff({ name, crash, onStarted }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await invoke("host_start");
      onStarted();
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="empty-state" role="status">
      <h1>{name}</h1>
      <p>{crash ? `Сервер на ${THIS_DEVICE} остановился с ошибкой: ${crash}` : `Сервер на ${THIS_DEVICE} выключен — друзья сейчас не могут зайти.`}</p>
      {error && <p className="form-error">{error}</p>}
      <div className="empty-actions">
        <Button variant="primary" disabled={busy} onClick={() => void start()}>
          {busy ? "Включаю…" : "Включить сервер"}
        </Button>
      </div>
    </div>
  );
}
