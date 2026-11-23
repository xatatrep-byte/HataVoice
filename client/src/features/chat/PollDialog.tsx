import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { Toggle } from "../../ui/Toggle";

export const MAX_QUESTION = 300;
export const MAX_OPTION = 100;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Resolves to null when the poll went, the reason when it did not. */
  onCreate: (question: string, options: string[], multi: boolean) => Promise<string | null>;
  onError: (text: string) => void;
};

/** A new poll: a question, 2–10 options, one choice or several. */
export function PollDialog({ open, onClose, onCreate, onError }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = question.trim() !== "" && options.length >= MIN_OPTIONS && options.every((o) => o.trim() !== "");

  const reset = () => {
    setQuestion("");
    setOptions(["", ""]);
    setMulti(false);
  };
  const create = async () => {
    setBusy(true);
    const error = await onCreate(question.trim(), options.map((o) => o.trim()), multi);
    setBusy(false);
    if (error) return onError(error);
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Голосование">
      <div className="poll-dialog">
        <div className="field">
          <label className="field-label" htmlFor="poll-question">
            Вопрос
          </label>
          <input
            id="poll-question"
            className="input"
            value={question}
            maxLength={MAX_QUESTION}
            autoFocus
            onChange={(e) => setQuestion(e.currentTarget.value)}
          />
        </div>
        <div className="field">
          <span className="field-label">Варианты</span>
          {options.map((option, index) => (
            <div key={index} className="poll-option-edit">
              <input
                className="input"
                aria-label={`Вариант ${index + 1}`}
                value={option}
                maxLength={MAX_OPTION}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setOptions((now) => now.map((o, i) => (i === index ? value : o)));
                }}
              />
              <IconButton
                label={`Убрать вариант ${index + 1}`}
                disabled={options.length <= MIN_OPTIONS}
                onClick={() => setOptions((now) => now.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
          <Button disabled={options.length >= MAX_OPTIONS} onClick={() => setOptions((now) => [...now, ""])}>
            <Plus size={14} /> Добавить вариант
          </Button>
        </div>
        <Toggle checked={multi} onChange={setMulti} label="Можно выбрать несколько" />
        <p className="hint">Голоса видны всем участникам сервера.</p>
        <div className="modal-actions">
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void create()}>
            Создать
          </Button>
        </div>
      </div>
    </Modal>
  );
}
