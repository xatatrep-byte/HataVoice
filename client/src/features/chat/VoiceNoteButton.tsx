import { useEffect, useRef, useState } from "react";
import { Mic, SendHorizontal, X } from "lucide-react";
import { canRecordVoiceNote, clock, MAX_VOICE_NOTE_SECONDS, startVoiceNote, type VoiceNote } from "../../chat/voiceNote";
import { IconButton } from "../../ui/IconButton";

const NO_MIC = "Не удалось включить микрофон";

/** Press to speak, press to send: a voice message, in the composer's row. */
export function VoiceNoteButton({ disabled, onRecorded, onError }: { disabled: boolean; onRecorded: (file: File) => void; onError: (text: string) => void }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const note = useRef<VoiceNote | null>(null);

  // Leaving the chat in the middle of a sentence throws the recording away.
  useEffect(() => () => note.current?.cancel(), []);

  const finish = async () => {
    const current = note.current;
    note.current = null;
    setSeconds(null);
    const file = await current?.finish();
    if (file) onRecorded(file);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const recording = seconds !== null;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((now) => (now === null ? null : now + 1)), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (seconds !== null && seconds >= MAX_VOICE_NOTE_SECONDS) void finishRef.current();
  }, [seconds]);

  if (!canRecordVoiceNote()) return null;

  if (seconds === null) {
    return (
      <IconButton
        label="Голосовое сообщение"
        disabled={disabled}
        onClick={() => {
          startVoiceNote()
            .then((started) => {
              note.current = started;
              setSeconds(0);
            })
            .catch(() => onError(NO_MIC));
        }}
      >
        <Mic size={18} />
      </IconButton>
    );
  }
  return (
    <span className="voice-note" role="status" aria-label="Идёт запись голосового">
      <span className="voice-note-dot" aria-hidden />
      <span className="voice-note-time">{clock(seconds)}</span>
      <IconButton
        label="Не отправлять"
        onClick={() => {
          note.current?.cancel();
          note.current = null;
          setSeconds(null);
        }}
      >
        <X size={18} />
      </IconButton>
      <IconButton label="Отправить голосовое" onClick={() => void finish()}>
        <SendHorizontal size={18} />
      </IconButton>
    </span>
  );
}
