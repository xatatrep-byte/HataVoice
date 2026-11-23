import { useState } from "react";
import { Copy } from "lucide-react";
import { Segmented } from "../../ui/Segmented";
import { notify } from "../../ui/toasts";
import { friendMessage, GUIDE_WAYS, guideFor, type GuideFacts, type GuideStep, type GuideWay } from "./guideSteps";

function Steps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="guide-steps">
      {steps.map((step, i) => (
        <li key={step.title} className="guide-step">
          <span className="guide-num" aria-hidden>
            {i + 1}
          </span>
          <span className="guide-body">
            <strong>{step.title}</strong>
            <span>{step.text}</span>
            {step.check && <span className="guide-check">Должно получиться: {step.check}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** «Как позвать друзей»: four ways, each as the owner's steps and the friend's, the friend's ready to copy. */
export function ConnectGuide({ facts }: { facts: GuideFacts }) {
  const [way, setWay] = useState<GuideWay>(facts.publicWorks ? "public" : facts.radmin ? "radmin" : facts.zerotier ? "zerotier" : "link");
  const [whose, setWhose] = useState<"host" | "friend">("host");
  const guide = guideFor(way, facts);

  async function copyForFriend() {
    try {
      await navigator.clipboard.writeText(friendMessage(way, facts));
      notify.info("Инструкция для друга скопирована: вставь её в мессенджер");
    } catch {
      notify.error("Буфер обмена недоступен");
    }
  }

  return (
    <section className="card connect-guide" aria-label="Как позвать друзей">
      <h2>Как позвать друзей</h2>
      <p className="hint">
        {facts.publicWorks
          ? "У тебя белый IP и порты открыты — проще всего «Белый IP»: друзья заходят прямо к тебе. Radmin VPN и ZeroTier тебе не нужны, они — запасной путь для друга, у которого не соединяется."
          : "Начни с «Без настроек» — он подходит почти всем. Белый IP — самый прямой путь, если он у тебя есть. Radmin VPN и ZeroTier — запасные: если «Без настроек» у кого-то не соединяется."}{" "}
        Шаги расписаны и для тебя, и для друга.
      </p>
      <Segmented<GuideWay> label="Способ" value={way} options={GUIDE_WAYS.map((w) => ({ value: w, label: guideFor(w, facts).label }))} onChange={setWay} />
      <p className="guide-when">{guide.when}</p>
      <Segmented<"host" | "friend">
        label="Чьи шаги"
        value={whose}
        options={[
          { value: "host", label: "Тебе" },
          { value: "friend", label: "Другу" },
        ]}
        onChange={setWhose}
      />
      <Steps steps={whose === "host" ? guide.host : guide.friend} />
      <button type="button" className="guide-copy" onClick={() => void copyForFriend()}>
        <Copy size={15} aria-hidden /> Скопировать инструкцию для друга
      </button>
    </section>
  );
}
