import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { pickFiles, pickSave } from "../../files/pick";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { identityInfo, serverErrorText } from "../../server/session";
import { useBackupPrompt } from "../../state/backup";
import { AVATAR_COLORS, MAX_NICKNAME_CHARS, parseProfileColor, usePrefs, type AvatarColor } from "../../state/prefs";
import { randomServerColor, useServers } from "../../state/servers";
import { Palette } from "lucide-react";
import { Avatar, avatarFill } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { ColorPicker } from "../../ui/ColorPicker";
import { FRAMES } from "../../ui/frames";
import { Swatches } from "../../ui/Swatches";
import { Toggle } from "../../ui/Toggle";
import { notify } from "../../ui/toasts";
import { IS_MOBILE, THIS_DEVICE } from "../../platform";

export const COLOR_NAMES: Record<AvatarColor, string> = {
  blue: "Синий",
  violet: "Фиолетовый",
  green: "Зелёный",
  orange: "Оранжевый",
  pink: "Розовый",
  teal: "Бирюзовый",
  red: "Красный",
  yellow: "Жёлтый",
};

/** The file may leave this PC: ten characters keep a GPU from guessing it. */
const MIN_PASSWORD = 10;

/** Password twice, then where to save the encrypted `.hvid` copy. */
function ExportForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportIdentity() {
    if ([...password].length < MIN_PASSWORD) return setError("Пароль: хотя бы 10 символов");
    if (password !== repeat) return setError("Пароли не совпадают");
    setError(null);
    const where = await pickSave("identity", "ХатаВойс-личность.hvid").catch(() => null);
    if (!where) return;
    setBusy(true);
    try {
      const { nickname, color } = usePrefs.getState();
      const servers = useServers
        .getState()
        .servers.flatMap((s) => (s.serverKey ? [{ address: s.address, server_key: s.serverKey }] : []));
      await invoke("identity_export", { token: where.token, password, nickname, color, servers });
      useBackupPrompt.getState().hide();
      notify.info("Копия личности сохранена. Храни файл и пароль в разных местах");
      onDone();
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identity-form">
      <div className="field">
        <label className="field-label" htmlFor="hvid-password">
          Пароль для файла
        </label>
        <input
          id="hvid-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="hvid-repeat">
          Ещё раз
        </label>
        <input
          id="hvid-repeat"
          className="input"
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="field-row">
        <Button variant="primary" disabled={busy} onClick={() => void exportIdentity()}>
          Выбрать, куда сохранить
        </Button>
        <Button onClick={onDone}>Отмена</Button>
      </div>
    </div>
  );
}

/** Replaces this PC's identity with one from a `.hvid` file, then restarts the window. */
function ImportForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function importIdentity() {
    setBusy(true);
    setError(null);
    try {
      const imported = await invoke<{ nickname: string; color: string; servers: { address: string; server_key: string }[] }>(
        "identity_import",
        { token, password },
      );
      const prefs = usePrefs.getState();
      prefs.setNickname(imported.nickname);
      const importedColor = parseProfileColor(imported.color);
      if (importedColor) prefs.setColor(importedColor);
      const servers = useServers.getState();
      for (const { address, server_key } of imported.servers) {
        if (servers.servers.some((s) => s.address === address)) servers.update(address, { serverKey: server_key });
        else servers.add({ address, name: address, color: randomServerColor(), serverKey: server_key });
      }
      // Every open server belonged to the old identity: start over with the new one.
      window.location.reload();
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="identity-form">
      <p className="hint">Личность этого ПК заменится той, что в файле.</p>
      <p className="hint">Личность работает на одном ПК за раз: на другом ПК чат подключится заново</p>
      <div className="field">
        <label className="field-label" htmlFor="hvid-open-password">
          Пароль от файла
        </label>
        <input
          id="hvid-open-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="field-row">
        <Button variant="primary" disabled={busy || !password} onClick={() => void importIdentity()}>
          Загрузить
        </Button>
        <Button onClick={onDone}>Отмена</Button>
      </div>
    </div>
  );
}

/** «Удалить ключ с этого ПК»: what it costs, said plainly, then the key is wiped and the window starts over with a new one. */
function ForgetForm({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await invoke("identity_forget");
      // Every open server belonged to the old key.
      window.location.reload();
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="identity-form identity-forget">
      <p>
        Ключ, по которому тебя узнают на серверах, будет затёрт и удалён с этого ПК. Вместо него появится новый, и для
        серверов это будет другой человек: вернуться можно только по новому приглашению, а права владельца и админа
        пропадут.
      </p>
      <p className="hint">Если захочешь вернуть себе вход, сначала нажми «Сохранить копию личности».</p>
      {error && <p className="form-error">{error}</p>}
      <div className="field-row">
        <Button variant="danger" disabled={busy} onClick={() => void forget()}>
          {busy ? "Удаляю…" : "Удалить навсегда"}
        </Button>
        <Button onClick={onDone}>Отмена</Button>
      </div>
    </div>
  );
}

function IdentityBlock() {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [mode, setMode] = useState<{ kind: "idle" } | { kind: "export" } | { kind: "forget" } | { kind: "import"; token: string }>({ kind: "idle" });

  useEffect(() => {
    if (!isTauri()) return;
    void identityInfo()
      .then((info) => setFingerprint(info.fingerprint))
      .catch(() => {});
  }, []);

  async function showKeyFile() {
    try {
      await revealItemInDir(await invoke<string>("identity_file"));
    } catch (e) {
      notify.error(serverErrorText(e));
    }
  }

  async function pickImport() {
    const [picked] = await pickFiles("identity", false).catch(() => []);
    if (picked) setMode({ kind: "import", token: picked.token });
  }

  if (!isTauri()) return null;
  return (
    <>
      <h3 className="settings-sub">Личность</h3>
      <div className="field">
        <span className="field-label">Отпечаток</span>
        <span className="fingerprint">{fingerprint ?? "…"}</span>
        <span className="hint">Друзья видят его рядом с ником, если у кого-то такой же ник</span>
      </div>
      {mode.kind === "export" ? (
        <ExportForm onDone={() => setMode({ kind: "idle" })} />
      ) : mode.kind === "import" ? (
        <ImportForm token={mode.token} onDone={() => setMode({ kind: "idle" })} />
      ) : mode.kind === "forget" ? (
        <ForgetForm onDone={() => setMode({ kind: "idle" })} />
      ) : (
        <>
          <p className="hint">
            Личность хранится на {THIS_DEVICE}. Без копии после {IS_MOBILE ? "сброса или смены телефона" : "переустановки Windows"} ты потеряешь свои серверы и права.
          </p>
          <div className="field-row">
            <Button onClick={() => setMode({ kind: "export" })}>Сохранить копию личности</Button>
            <Button onClick={() => void pickImport()}>Загрузить из файла</Button>
          </div>
          <div className="field-row">
            <Button onClick={() => void showKeyFile()}>Показать файл ключа</Button>
            <Button variant="danger" onClick={() => setMode({ kind: "forget" })}>
              Удалить ключ с этого ПК…
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** Games the built-in list does not know: the .exe and how friends see it. */
function CustomGames() {
  const games = usePrefs((s) => s.customGames);
  const setGames = usePrefs((s) => s.setCustomGames);
  const [exe, setExe] = useState("");
  const [title, setTitle] = useState("");
  const add = () => {
    const file = exe.trim();
    const name = title.trim();
    if (!file || !name) return;
    setGames([...games.filter((g) => g.exe.toLowerCase() !== file.toLowerCase()), { exe: file, title: name }]);
    setExe("");
    setTitle("");
  };
  return (
    <div className="custom-games">
      {games.length > 0 && (
        <ul className="custom-games-list">
          {games.map((g) => (
            <li key={g.exe}>
              <span>
                {g.title} <span className="hint">· {g.exe}</span>
              </span>
              <Button onClick={() => setGames(games.filter((x) => x.exe !== g.exe))} aria-label={`Убрать «${g.title}»`}>
                Убрать
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="game-exe">
            Файл игры
          </label>
          <input id="game-exe" className="input" value={exe} placeholder="game.exe" spellCheck={false} onChange={(e) => setExe(e.currentTarget.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="game-title">
            Как назвать
          </label>
          <input id="game-title" className="input" value={title} maxLength={64} onChange={(e) => setTitle(e.currentTarget.value)} />
        </div>
        <Button onClick={add} disabled={!exe.trim() || !title.trim()}>
          Добавить игру
        </Button>
      </div>
      <span className="hint">Если игры нет в списке: имя её .exe видно в Диспетчере задач → Подробности</span>
    </div>
  );
}

export function ProfileSection() {
  const nickname = usePrefs((s) => s.nickname);
  const color = usePrefs((s) => s.color);
  const showGame = usePrefs((s) => s.showGame);
  const setNickname = usePrefs((s) => s.setNickname);
  const setColor = usePrefs((s) => s.setColor);
  const setShowGame = usePrefs((s) => s.setShowGame);
  const [picking, setPicking] = useState(false);
  const frame = usePrefs((s) => s.frame);
  const setFrame = usePrefs((s) => s.setFrame);
  return (
    <>
      <div className="profile-preview">
        <Avatar name={nickname || "?"} color={color} size={64} frame={frame} />
        <div>
          <div className="profile-name">{nickname || "Без ника"}</div>
          <div className="hint">Так тебя видят друзья</div>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="profile-nick">
          Ник
        </label>
        <input
          id="profile-nick"
          className="input"
          value={nickname}
          maxLength={MAX_NICKNAME_CHARS}
          onChange={(e) => setNickname(e.currentTarget.value)}
        />
      </div>
      <Swatches
        label="Цвет аватара"
        value={color as AvatarColor}
        options={AVATAR_COLORS}
        colorOf={(c) => `var(--av-${c})`}
        nameOf={(c) => COLOR_NAMES[c]}
        onChange={setColor}
      />
      <div className="row accent-row">
        <span className="cp-preview" style={{ background: avatarFill(color) }} aria-hidden />
        <Button onClick={() => setPicking((open) => !open)}>
          <Palette size={16} /> {picking ? "Готово" : "Свой цвет аватара"}
        </Button>
      </div>
      {picking && (
        <ColorPicker
          label="Свой цвет аватара"
          value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#ff8a4c"}
          onChange={setColor}
        />
      )}
      <div className="field">
        <span className="field-label">Рамка вокруг аватарки</span>
        <div className="frame-gallery" role="radiogroup" aria-label="Рамка вокруг аватарки">
          {[{ id: null, name: "Без рамки" }, ...FRAMES].map((f) => (
            <button
              key={f.id ?? "none"}
              type="button"
              role="radio"
              aria-checked={frame === f.id}
              className={frame === f.id ? "frame-choice active" : "frame-choice"}
              onClick={() => setFrame(f.id)}
            >
              <Avatar name={nickname || "?"} color={color} size={40} frame={f.id} />
              <span>{f.name}</span>
            </button>
          ))}
        </div>
        <p className="hint">Рамку видят все на твоих серверах.</p>
      </div>
      <h3 className="settings-sub">Приватность</h3>
      <Toggle
        label="Показывать, во что я играю"
        hint="Друзья видят «играет в …». Список программ с ПК никуда не уходит"
        checked={showGame}
        onChange={setShowGame}
      />
      {showGame && <CustomGames />}
      <IdentityBlock />
    </>
  );
}
