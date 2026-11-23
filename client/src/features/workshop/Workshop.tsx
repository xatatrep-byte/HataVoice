import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { Segmented } from "../../ui/Segmented";
import { CameraCapture } from "./CameraCapture";
import { Composer } from "./Composer";
import { PoseEditor } from "./PoseEditor";
import { Steps, type AdvancedMode } from "./Steps";
import "./workshop.css";
import { IS_MOBILE } from "../../platform";

const MODES: { value: AdvancedMode; label: string }[] = [
  { value: "compose", label: "Собрать из готовых" },
  { value: "pose", label: IS_MOBILE ? "Поза пальцем" : "Поза мышью" },
  { value: "camera", label: "С камеры" },
];

/**
 * The motions editor, opened from Settings → «Персонаж»: step by step for everyone; the old tools — the track, points
 * to pull, the camera — «Для опытных».
 */
export default function Workshop({ onClose }: { onClose: () => void }) {
  const [advanced, setAdvanced] = useState<AdvancedMode | null>(null);
  if (!advanced) {
    return (
      <div className="workshop">
        <Steps onClose={onClose} onAdvanced={setAdvanced} />
      </div>
    );
  }
  return (
    <div className="workshop">
      <header className="workshop-head">
        <IconButton label="К простому редактору" onClick={() => setAdvanced(null)}>
          <ArrowLeft size={18} />
        </IconButton>
        <h1>Для опытных</h1>
        <Segmented<AdvancedMode> label="Как делать движение" value={advanced} options={MODES} onChange={setAdvanced} />
        <span className="hint">Друзья видят твои движения в звонке, когда ты выбираешь эмоцию</span>
      </header>
      {advanced === "compose" ? <Composer /> : advanced === "pose" ? <PoseEditor /> : <CameraCapture />}
    </div>
  );
}
