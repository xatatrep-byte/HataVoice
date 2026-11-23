import { useEffect, useState } from "react";
import { pickFiles } from "../../files/pick";
import { mediaUrl, serverErrorText, uploadMedia, uploadMyGif, type MediaRef } from "../../server/session";
import { Button } from "../../ui/Button";
import { loadMyGifs, type MyGif } from "./myGifs";

export type ChosenMedia = { media: MediaRef; name: string };

/** The picture or clip as it will be shown; clips start muted here, it is only a preview. */
export function MediaView({ address, media, muted = true }: { address: string; media: MediaRef; muted?: boolean }) {
  const src = mediaUrl(address, media);
  return media.mime.startsWith("video/") ? (
    <video className="moderation-media" src={src} autoPlay loop playsInline muted={muted} />
  ) : (
    <img className="moderation-media" src={src} alt="" />
  );
}

/**
 * A GIF, MP4 or WebM for a kick or ban: from disk or from «Мои гифки» (files used before). The
 * file is uploaded to this server as soon as it is picked.
 */
export function GifPicker({ address, value, onChange }: { address: string; value: ChosenMedia | null; onChange: (m: ChosenMedia | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<MyGif[]>([]);
  useEffect(() => {
    let alive = true;
    void loadMyGifs()
      .then((gifs) => alive && setMine(gifs))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function upload(name: string, send: () => Promise<MediaRef>) {
    setBusy(true);
    setError(null);
    try {
      onChange({ media: await send(), name });
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const [picked] = await pickFiles("gif", false).catch(() => []);
    if (picked) await upload(picked.name, () => uploadMedia(address, picked.token, "moderation"));
  }

  return (
    <div className="field">
      <span className="field-label">Гифка или видео до 8 МБ, по желанию</span>
      {value ? (
        <div className="gif-chosen">
          <MediaView address={address} media={value.media} />
          <span className="gif-name">{value.name}</span>
          <Button onClick={() => onChange(null)}>Убрать</Button>
        </div>
      ) : (
        <>
          <div className="field-row">
            <Button disabled={busy} onClick={() => void pick()}>
              {busy ? "Загружаю…" : "Выбрать файл…"}
            </Button>
          </div>
          {mine.length > 0 && (
            <div className="my-gifs" role="group" aria-label="Мои гифки">
              <span className="hint">Мои гифки</span>
              {mine.map((g) => (
                <button key={g.id} type="button" className="chip" disabled={busy} title={g.name} onClick={() => void upload(g.name, () => uploadMyGif(address, g.id))}>
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
