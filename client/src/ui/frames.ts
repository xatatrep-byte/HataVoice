/** The frames one may put around one's avatar; others see it, as it travels in the signed profile. */
export const FRAMES = [
  { id: "neon", name: "Неон" },
  { id: "fire", name: "Огонь" },
  { id: "rainbow", name: "Радуга" },
  { id: "crown", name: "Корона" },
  { id: "halo", name: "Нимб" },
  { id: "horns", name: "Рожки" },
  { id: "ears", name: "Ушки" },
  { id: "snow", name: "Снежинки" },
  { id: "leaves", name: "Листья" },
  { id: "pixels", name: "Пиксели" },
] as const;

export type FrameId = (typeof FRAMES)[number]["id"];

/** A frame this app knows how to draw; anything else is shown as no frame. */
export function knownFrame(frame: unknown): FrameId | null {
  return FRAMES.some((f) => f.id === frame) ? (frame as FrameId) : null;
}
