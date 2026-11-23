import { useEffect, useMemo, useRef, useState } from "react";
import { EMOTES, moveAct } from "../../characters/character";
import { CharacterCanvas } from "../../characters/CharacterCanvas";
import { cssColor, sceneMembers } from "../../characters/members";
import type { ActControls } from "../../characters/useActs";
import { useMyAvatar } from "../../characters/myAvatar";
import { useServers } from "../../state/servers";
import type { ParticipantView } from "../../voice/participants";
import { Emoji } from "../../ui/Emoji";
import { ActMenu } from "./ActMenu";

type Props = {
  participants: ParticipantView[];
  /** Our character's code as set now. */
  mine: string | null;
  acts: ActControls;
  /** This PC cannot draw 3D: the stage shows the usual tiles. */
  onFail: () => void;
  /** A shared screen is in front: the stage waits loaded and drawing nothing, to be back in an instant. */
  parked?: boolean;
};

type Menu = { id: string; x: number; y: number };

/** The call as a little stage of 3D characters: a click on one does something with them. */
export function CharacterStage({ participants, mine, acts, onFail, parked = false }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const address = useServers((s) => s.selected);
  const members = useMemo(() => sceneMembers(participants, mine, cssColor, address), [participants, mine, address]);
  const picked = menu && participants.find((p) => p.identity === menu.id);
  const act = (id: string, to: string | null) => {
    acts.perform(id, to);
    setMenu(null);
  };
  // Where we put our character: a step is told to those in the call then, and again to whoever comes in later, who would
  // otherwise see it where it first stood.
  const placed = useRef<{ x: number; z: number } | null>(null);
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const everyone = participants
    .map((p) => p.identity)
    .sort()
    .join(" ");
  useEffect(() => {
    const at = placed.current;
    if (!at) return;
    const timer = setTimeout(() => actsRef.current.perform(moveAct(at.x, at.z)), 1500);
    return () => clearTimeout(timer);
  }, [everyone]);
  return (
    <div className={parked ? "character-stage parked" : "character-stage"} aria-hidden={parked || undefined}>
      <CharacterCanvas
        className="character-canvas"
        paused={parked}
        feedWalks
        members={members}
        acts={acts.acts}
        onFail={onFail}
        onMoved={(x, z) => {
          placed.current = { x, z };
          acts.perform(moveAct(x, z));
        }}
        onPick={(id, x, y) => setMenu((open) => (open?.id === id ? null : { id, x, y }))}
        label="3D-персонажи звонка: нажми на персонажа, своего можно перетащить"
      />
      {menu && picked && !parked && (
        <ActMenu key={`${menu.id} ${menu.x} ${menu.y}`} at={menu} mine={picked.isLocal} name={picked.name} onAct={(id) => act(id, picked.isLocal ? null : picked.identity)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** «Эмоции» in the dock: what our character does for everyone. */
export function EmoteMenu({ onAct }: { onAct: (id: string) => void }) {
  const mine = useMyAvatar((s) => s.avatar.clips);
  return (
    <div className="act-grid" role="menu" aria-label="Эмоции персонажа">
      {mine.map((clip) => (
        <button key={clip.id} type="button" role="menuitem" className="act-button mine" onClick={() => onAct(clip.id)}>
          <Emoji kind="char" id={clip.emoji} size={40} />
          {clip.name}
        </button>
      ))}
      {EMOTES.map((a) => (
        <button key={a.id} type="button" role="menuitem" className="act-button" onClick={() => onAct(a.id)}>
          <Emoji kind="act" id={a.id} fallback={a.emoji} size={40} />
          {a.name}
        </button>
      ))}
    </div>
  );
}
