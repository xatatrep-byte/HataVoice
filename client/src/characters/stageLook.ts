/** The looks of a call's 3D stage, apart from three.js, so the settings can name them without loading it. */
export type StageLook = "night" | "studio" | "sunset";
export const STAGE_LOOKS: readonly StageLook[] = ["studio", "sunset", "night"];
export const STAGE_LOOK_NAMES: Record<StageLook, string> = { night: "Ночь", studio: "Студия", sunset: "Закат" };
export const DEFAULT_STAGE_LOOK: StageLook = "studio";

export function parseStageLook(raw: unknown): StageLook {
  return STAGE_LOOKS.includes(raw as StageLook) ? (raw as StageLook) : DEFAULT_STAGE_LOOK;
}
