import "@fontsource-variable/manrope/wght.css";
import { DEFAULT_CHARACTER, EMOTES, INTERACTIONS, type Character } from "./character";
import { CharacterScene, type SceneMember } from "./scene";

/**
 * A page for looking at the characters without a call: `pnpm dev`, then /character-lab.html. `?mode=preview`,
 * `?mode=transparent`; `?n=6` figures. Not part of the app's build.
 */
const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const count = Number(params.get("n") ?? 6);

const CAST: Character[] = [
  { ...DEFAULT_CHARACTER, outfit: "#d9663a", hair: "short", hairColor: "#3b2a20", top: "hoodie", bottom: "#3a3f4b" },
  { ...DEFAULT_CHARACTER, body: "tall", skin: "#e9b48a", outfit: "#3f7c74", hair: "long", hairColor: "#7a3f1e", top: "tee", bottom: "#2d3a55", eyes: "happy" },
  { ...DEFAULT_CHARACTER, body: "chunky", skin: "#c98b62", outfit: "#2f4d7a", hair: "none", hat: "cap", top: "suit", bottom: "#26282e", extra: "beard", hairColor: "#2a2018", eyes: "cool" },
  { ...DEFAULT_CHARACTER, skin: "#8d5a3b", outfit: "#d6a02e", hair: "curly", hairColor: "#17120e", top: "dress", bottom: "#d6a02e", eyes: "happy", extra: "glasses" },
  { ...DEFAULT_CHARACTER, body: "tall", outfit: "#7a4b8c", hair: "ponytail", hairColor: "#c9a24a", top: "hoodie", bottom: "#4a4238", eyes: "dots", extra: "backpack", hat: "headphones" },
  { ...DEFAULT_CHARACTER, body: "round", skin: "#f6d1b1", outfit: "#b5342b", hair: "spiky", hairColor: "#e8e0d0", top: "hoodie", extra: "cape", eyes: "sleepy", hat: "crown" },
  { ...DEFAULT_CHARACTER, skin: "#b7e3a0", outfit: "#4a6a3a", hair: "mohawk", hairColor: "#d6442e", top: "tee", bottom: "#23252b", hat: "none", extra: "scarf" },
  { ...DEFAULT_CHARACTER, outfit: "#e0e0d8", hair: "bob", hairColor: "#1b1a22", top: "suit", bottom: "#1b1a22", hat: "bunny" },
];

const canvas = document.getElementById("stage") as HTMLCanvasElement;
// ?mode=desk: as on the desktop, over `?bg=` (a CSS background: what the desktop under them is).
const desk = mode === "desk";
if (desk || mode === "transparent") document.body.style.background = params.get("bg") ?? "#d8dde6";
const scene = new CharacterScene(canvas, {
  preview: mode === "preview",
  transparent: mode === "transparent" || desk,
  desk,
  // ?look=studio: «Ночь», «Студия» or «Закат».
  look: (params.get("look") as "night" | "studio" | "sunset" | null) ?? undefined,
  fps: desk ? 30 : undefined,
  onPick: (id) => console.log("picked", id),
  onMoved: (x, z) => console.log("moved", x, z),
});

// ?gallery=shino,devil: those models of the gallery on the stage.
const gallery = params.get("gallery")?.split(",") ?? [];
const members: SceneMember[] = Array.from({ length: gallery.length || count }, (_, i) => ({
  id: `m${i}`,
  name: gallery[i] ?? ["Аня", "Боря", "Вася", "Галя", "Даня", "Женя", "Зоя", "Ира"][i % 8]!,
  character: CAST[i % CAST.length]!,
  ...(gallery[i] ? { avatar: `m1.${gallery[i]}` } : {}),
  level: 0,
  speaking: false,
  local: i === 0,
}));
if (desk) scene.setDesk(Object.fromEntries(members.map((m, i) => [m.id, [0.3 + i * 0.2, 0.95] as [number, number]])), Number(params.get("size") ?? 0.6));
scene.setMembers(members);
window.addEventListener("resize", () => scene.resize());

let nextKey = 1;
const lab = {
  scene,
  act(user: string, act: string, to: string | null = null, ago = 0) {
    scene.play({ key: nextKey++, user, act, to, startedAt: performance.now() - ago });
  },
  speak(id: string, level: number) {
    scene.setMembers(members.map((m) => ({ ...m, level: m.id === id ? level : 0, speaking: m.id === id && level > 0 })));
  },
  /**
   * A contact sheet: each act at the moments given (seconds), drawn in turn and laid out in rows on a picture over the
   * page. `lab.sheet([["wave", [0.5, 1, 1.5]], ["bow", [1, 2]]])`; `lab.sheet(null)` takes it away.
   */
  sheet(rows: [string, number[]][] | null, cell = { width: 200, height: 300 }) {
    document.getElementById("sheet")?.remove();
    if (!rows) return;
    const columns = Math.max(...rows.map(([, times]) => times.length));
    const out = document.createElement("canvas");
    out.width = columns * cell.width;
    out.height = rows.length * (cell.height + 18);
    const g = out.getContext("2d")!;
    g.fillStyle = "#222";
    g.fillRect(0, 0, out.width, out.height);
    g.font = "14px sans-serif";
    rows.forEach(([act, times], r) => {
      times.forEach((t, c) => {
        const base = 100_000 + r * 50_000 + c * 7_000;
        scene.play({ key: nextKey++, user: "m0", act, to: null, startedAt: base - t * 1000 });
        // A few frames up to that moment, so swinging hair and skirts are where they would be.
        for (let k = 8; k >= 0; k--) scene.renderAt(base - k * 33);
        // Close on the one standing in the middle.
        const w = canvas.width;
        const h = canvas.height;
        const ch = h * 0.78;
        const cw = (ch * cell.width) / cell.height;
        g.drawImage(canvas, (w - cw) / 2, h * 0.14, cw, ch, c * cell.width, r * (cell.height + 18) + 18, cell.width, cell.height);
        g.fillStyle = "#ddd";
        g.fillText(`${act} ${t}s`, c * cell.width + 6, r * (cell.height + 18) + 14);
      });
    });
    const img = document.createElement("img");
    img.id = "sheet";
    img.src = out.toDataURL("image/jpeg", 0.85);
    img.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#111;z-index:10";
    document.body.append(img);
  },
};
(window as unknown as { lab: typeof lab }).lab = lab;

const bar = document.getElementById("bar")!;
if (params.has("bare")) bar.style.display = "none";
// A model showcase can keep only its signature gestures in view.
const visibleActs = params.get("acts")?.split(",");
for (const { id, name } of [...EMOTES, ...INTERACTIONS]) {
  if (visibleActs && !visibleActs.includes(id)) continue;
  const button = document.createElement("button");
  button.textContent = name;
  button.onclick = () => (INTERACTIONS.some((i) => i.id === id) ? lab.act("m0", id, count > 1 ? "m1" : null) : lab.act("m0", id));
  bar.append(button);
}
