import { useEffect, useState } from "react";
import { Bell, Gauge, Info, Mic, Palette, PersonStanding, Server, User, Radio } from "lucide-react";
import type { AudioSettings } from "../../audio/settings";
import { AppearanceSection } from "./AppearanceSection";
import { StreamerSection } from "./StreamerSection";
import { CharacterSection } from "./CharacterSection";
import { NetworkSection } from "./NetworkSection";
import { Modal } from "../../ui/Modal";
import { usePrefs } from "../../state/prefs";
import { AboutSection, NotificationsSection, ProfileSection, ServerSection, VoiceSection } from "./sections";
import "./settings.css";

export type SettingsSection = "profile" | "character" | "voice" | "notifications" | "streamer" | "appearance" | "network" | "server" | "about";

export type VoiceControls = {
  status: "idle" | "connecting" | "connected" | "reconnecting";
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  micLevel: number;
  selectOutput: (id: string) => void;
};

export type PttControls = {
  open: boolean;
  error: string | null;
  capturing: boolean;
  startCapture: () => void;
  cancelCapture: () => void;
};

type Props = {
  open: boolean;
  section?: SettingsSection;
  onClose: () => void;
  voice: VoiceControls;
  ptt: PttControls;
  settings: AudioSettings;
  onSettingsChange: (change: Partial<AudioSettings>) => void;
  /** Opens the motions editor (the window closes for it). */
  onOpenMotions?: () => void;
  /** Opens «Создать свой» (the window closes for it). */
  onCreateServer?: () => void;
};

const SECTIONS: { id: SettingsSection; label: string; icon: typeof User }[] = [
  { id: "profile", label: "Профиль", icon: User },
  { id: "character", label: "Персонаж", icon: PersonStanding },
  { id: "voice", label: "Голос и звук", icon: Mic },
  { id: "notifications", label: "Уведомления", icon: Bell },
  { id: "streamer", label: "Режим стримера", icon: Radio },
  { id: "appearance", label: "Внешний вид", icon: Palette },
  { id: "network", label: "Сеть", icon: Gauge },
  { id: "server", label: "Мой сервер", icon: Server },
  { id: "about", label: "О программе", icon: Info },
];

export function SettingsModal({ open, section = "voice", onClose, voice, ptt, settings, onSettingsChange, onOpenMotions, onCreateServer }: Props) {
  const [current, setCurrent] = useState<SettingsSection>(section);
  const side = usePrefs((s) => s.appearance.settingsTabs === "left");
  useEffect(() => {
    if (open) setCurrent(section);
  }, [open, section]);

  return (
    <Modal open={open} onClose={onClose} title="Настройки" wide>
      <div className={side ? "settings side" : "settings"}>
        <nav
          className="settings-nav"
          aria-label="Разделы настроек"
          onWheel={(e) => {
            // In a row the wheel turns the tabs sideways, so the last ones are never out of reach.
            const nav = e.currentTarget;
            if (nav.scrollWidth > nav.clientWidth && e.deltaY !== 0 && e.deltaX === 0) nav.scrollLeft += e.deltaY;
          }}
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={id === current ? "settings-tab active" : "settings-tab"}
              aria-current={id === current ? "page" : undefined}
              onClick={(e) => {
                setCurrent(id);
                // A narrow window keeps the tabs in a row that scrolls: the one chosen comes whole into sight.
                e.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
              }}
            >
              <Icon size={17} aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <h2 className="settings-title">{SECTIONS.find((s) => s.id === current)?.label}</h2>
          {current === "profile" && <ProfileSection />}
          {current === "character" && (
            <CharacterSection
              onOpenMotions={
                onOpenMotions &&
                (() => {
                  onClose();
                  onOpenMotions();
                })
              }
            />
          )}
          {current === "voice" && (
            <VoiceSection voice={voice} ptt={ptt} settings={settings} onSettingsChange={onSettingsChange} />
          )}
          {current === "notifications" && <NotificationsSection />}
          {current === "streamer" && <StreamerSection />}
          {current === "appearance" && <AppearanceSection />}
          {current === "network" && <NetworkSection />}
          {current === "server" && (
            <ServerSection
              onDone={onClose}
              onCreateServer={
                onCreateServer &&
                (() => {
                  onClose();
                  onCreateServer();
                })
              }
            />
          )}
          {current === "about" && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}
