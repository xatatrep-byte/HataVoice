import { useState } from "react";
import { pickFiles } from "../../files/pick";
import { serverErrorText, uploadMedia, type MediaRef } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { MediaView } from "../moderation/GifPicker";
import type { TabProps } from "./ServerSettingsModal";

const MAX_NAME = 64;
const MAX_TEXT = 500;

/** Name, icon, description and the welcome a newcomer sees on the invite screen. */
export function ProfileTab({ address, state, post }: TabProps) {
  const [name, setName] = useState(state.profile.name);
  const [description, setDescription] = useState(state.profile.description);
  const [welcome, setWelcome] = useState(state.profile.welcome);
  const [icon, setIcon] = useState<MediaRef | null>(state.profile.icon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickIcon() {
    const [picked] = await pickFiles("icon", false).catch(() => []);
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      setIcon(await uploadMedia(address, picked.token, "icon"));
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="profile-icon">
        {icon ? <MediaView address={address} media={icon} /> : <Avatar name={name || "?"} color="blue" size={64} />}
        <Button disabled={busy} onClick={() => void pickIcon()}>
          {busy ? "Загружаю…" : "Загрузить иконку…"}
        </Button>
        {icon && <Button onClick={() => setIcon(null)}>Убрать</Button>}
      </div>
      <p className="hint">PNG, JPEG, GIF или WebP до 1 МБ.</p>
      <div className="field">
        <label className="field-label" htmlFor="server-name">
          Название сервера
        </label>
        <input id="server-name" className="input" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.currentTarget.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="server-description">
          Описание
        </label>
        <input
          id="server-description"
          className="input"
          value={description}
          maxLength={MAX_TEXT}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="server-welcome">
          Приветствие для новичков
        </label>
        <textarea
          id="server-welcome"
          className="input"
          rows={4}
          value={welcome}
          maxLength={MAX_TEXT}
          placeholder="Его увидит тот, кто открыл приглашение"
          onChange={(e) => setWelcome(e.currentTarget.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <Button
          variant="primary"
          onClick={() =>
            void post({
              type: "server_profile",
              name: name.trim() || state.profile.name,
              description: description.trim(),
              welcome: welcome.trim(),
              icon,
            }).catch(() => {})
          }
        >
          Сохранить
        </Button>
      </div>
    </>
  );
}
