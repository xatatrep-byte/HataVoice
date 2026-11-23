import { useEffect, useState } from "react";
import { joinByInvite, mediaUrl, previewInvite, serverErrorText, type InvitePreview } from "../../server/session";
import { randomServerColor, useServers } from "../../state/servers";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import "./join.css";

type Joined = { address: string; serverKey: string; name: string };

type Props = {
  link: string;
  onJoined: (server: Joined) => void;
  onCancel: () => void;
};

/** What an invite leads to — the server proved its key first — and «Войти». */
export function JoinScreen({ link, onJoined, onCancel }: Props) {
  const add = useServers((s) => s.add);
  const select = useServers((s) => s.select);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    previewInvite(link).then(
      (p) => alive && setPreview(p),
      (e) => alive && setError(serverErrorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [link]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const joined = await joinByInvite(link);
      add({ address: joined.address, name: joined.name, color: randomServerColor(), serverKey: joined.serverKey });
      select(joined.address);
      onJoined(joined);
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="join-screen">
      {preview ? (
        <>
          {preview.icon ? (
            <img className="join-icon" src={mediaUrl(preview.address, preview.icon)} alt="" />
          ) : (
            <Avatar name={preview.server_name} color="blue" size={72} />
          )}
          <h2 className="join-name">{preview.server_name}</h2>
          {preview.description && <p className="hint">{preview.description}</p>}
          {preview.welcome && <p className="join-welcome">{preview.welcome}</p>}
          <p className="hint">{`Приглашает ${preview.inviter_name ?? "участник"} · ${preview.inviter_fingerprint}`}</p>
          {!preview.valid && <p className="form-error">Приглашение больше не действует. Попроси новое</p>}
        </>
      ) : (
        !error && <p className="hint">Проверяю приглашение…</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <Button onClick={onCancel}>Назад</Button>
        {preview?.valid && (
          <Button variant="primary" onClick={() => void join()} disabled={busy}>
            {busy ? "Вхожу…" : "Войти"}
          </Button>
        )}
      </div>
    </div>
  );
}
