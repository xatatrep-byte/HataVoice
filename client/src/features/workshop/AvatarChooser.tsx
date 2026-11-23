import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Upload, UserRound } from "lucide-react";
import { defaultCharacterFor, EMOTES, parseCharacter } from "../../characters/character";
import { CharacterCanvas } from "../../characters/CharacterCanvas";
import { defaultAvatarFor, GALLERY, galleryCode, galleryPicture, parseAvatar } from "../../characters/gallery";
import { ModelError } from "../../characters/glb";
import { cssColor } from "../../characters/members";
import { adoptModelFile, commitAvatar, prepareModel, useMyAvatar } from "../../characters/myAvatar";
import type { SceneAct } from "../../characters/scene";
import { identityInfo } from "../../server/session";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { notify } from "../../ui/toasts";
import "./workshop.css";
import { Emoji } from "../../ui/Emoji";

/** The character on a stage of its own, turning a little, trying on emotes. */
export function AvatarPreview({ onFail }: { onFail?: () => void }) {
  const nickname = usePrefs((s) => s.nickname);
  const color = usePrefs((s) => s.color);
  const code = usePrefs((s) => s.character);
  const [me, setMe] = useState("me");
  const [acts, setActs] = useState<SceneAct[]>([]);
  const [no3d, setNo3d] = useState(false);
  const key = useRef(1);
  useEffect(() => {
    if (isTauri()) void identityInfo().then((info) => setMe(info.user_id)).catch(() => {});
  }, []);
  const members = useMemo(() => {
    const built = parseCharacter(code);
    return [
      {
        id: "me",
        name: nickname || "Ты",
        character: built ?? defaultCharacterFor(me, cssColor(color)),
        ...(built ? {} : { avatar: parseAvatar(code) ? code! : defaultAvatarFor(me) }),
        level: 0,
        speaking: false,
      },
    ];
  }, [nickname, code, me, color]);
  const tryAct = (act: string) => setActs((list) => [...list.slice(-4), { key: key.current++, user: "me", act, to: null, startedAt: performance.now() }]);
  return (
    <div className="avatar-preview">
      {no3d ? (
        <p className="hint character-no3d">Этот ПК не рисует 3D, но друзья всё равно увидят твоего персонажа.</p>
      ) : (
        <CharacterCanvas
          className="character-canvas"
          members={members}
          acts={acts}
          preview
          onFail={() => {
            setNo3d(true);
            onFail?.();
          }}
          label="Твой 3D-персонаж"
        />
      )}
      <div className="char-try" role="group" aria-label="Попробовать эмоцию">
        {EMOTES.slice(0, 12).map((a) => (
          <button key={a.id} type="button" className="char-try-button" title={a.name} aria-label={a.name} onClick={() => tryAct(a.id)}>
            <Emoji kind="act" id={a.id} fallback={a.emoji} size={28} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Whom friends see: a model of the gallery, or a file of one's own. */
export function AvatarChooser() {
  const code = usePrefs((s) => s.character);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const avatar = useMyAvatar((s) => s.avatar);
  const setAvatar = useMyAvatar((s) => s.setAvatar);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const chosen = parseAvatar(avatar.base ?? code);
  const choose = (id: string) => {
    const base = galleryCode(id);
    setError(null);
    // With no motions of one's own a code is all it takes.
    if (avatar.clips.length === 0) {
      setAvatar({ ...avatar, model: null, base, pack: null });
      setCharacter(base);
      return;
    }
    void commitAvatar({ ...avatar, model: null, base }).then((done) => {
      setAvatar(done.avatar);
      setCharacter(done.code);
    });
  };
  const upload = async (picked: File) => {
    setError(null);
    setBusy(`Готовлю «${picked.name}»…`);
    try {
      const prepared = await prepareModel(picked);
      setBusy("Шифрую…");
      const done = await adoptModelFile(avatar, prepared.bytes, prepared.title || picked.name);
      setAvatar(done.avatar);
      setCharacter(done.code);
      notify.info(`Готово: ${prepared.triangles.toLocaleString("ru-RU")} треугольников, ${Math.round(prepared.bytes.length / 1024 / 1024)} МБ. Друзья увидят её в звонке`);
    } catch (e) {
      setError(e instanceof ModelError ? e.message : `Не получилось: ${String(e).slice(0, 160)}`);
    } finally {
      setBusy(null);
    }
  };
  const tile = (id: string, name: string) => {
    const active = !avatar.model && chosen?.kind === "gallery" && chosen.id === id;
    return (
      // No name on the picture: a character is whoever wears it. The name stays for a screen reader.
      <button key={id} type="button" className={active ? "gallery-tile active" : "gallery-tile"} aria-pressed={active} aria-label={name} onClick={() => choose(id)}>
        <img src={galleryPicture(id)} alt="" loading="lazy" draggable={false} />
      </button>
    );
  };
  return (
    <div className="avatar-chooser">
      <h3 className="label">Герои</h3>
      <div className="gallery-grid">{GALLERY.filter((m) => m.group === "heroes").map((m) => tile(m.id, m.name))}</div>
      <h3 className="label">Люди</h3>
      <div className="gallery-grid">{GALLERY.filter((m) => m.group === "people").map((m) => tile(m.id, m.name))}</div>
      <h3 className="label">Весёлые</h3>
      <div className="gallery-grid">{GALLERY.filter((m) => m.group === "fun").map((m) => tile(m.id, m.name))}</div>
      <h3 className="label">Своя модель</h3>
      {avatar.model && (
        <p className="my-model">
          <UserRound size={15} aria-hidden /> Сейчас на тебе: <b>{avatar.model.name}</b>
        </p>
      )}
      <p className="hint">
        Файл .vrm, .glb или .fbx с человеческим скелетом. Подойдут модели из VRoid Studio, VRoid Hub, Mixamo и Blender. Текстуры сожмутся, файл зашифруется и уйдёт
        на сервер: прочитать его смогут только участники. Лицо, волосы и взгляд работают у VRM, у остальных двигается тело.
      </p>
      <div className="row">
        <Button disabled={!!busy || !isTauri()} onClick={() => file.current?.click()}>
          <Upload size={16} /> {busy ?? "Загрузить модель"}
        </Button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".vrm,.glb,.fbx"
          onChange={(e) => {
            const picked = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (picked) void upload(picked);
          }}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
