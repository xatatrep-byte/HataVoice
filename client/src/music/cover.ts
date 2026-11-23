/** The most bytes of a cover in the `music` word (Rust checks the same, `music_word.rs`). */
export const MUSIC_MAX_COVER = 24 * 1024;

function load(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("no picture"));
    image.src = dataUrl;
  });
}

/**
 * A cover as Windows gave it, made a small square JPEG for the word (`size` px, cut to the middle), at a quality that
 * fits `MUSIC_MAX_COVER`; null when it does not draw.
 */
export async function coverToJpeg(dataUrl: string, size = 96): Promise<string | null> {
  try {
    const image = await load(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) return null;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) return null;
    g.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    for (const quality of [0.82, 0.6, 0.4]) {
      const jpeg = canvas.toDataURL("image/jpeg", quality);
      if (jpeg.startsWith("data:image/jpeg;base64,") && jpeg.length <= MUSIC_MAX_COVER) return jpeg;
    }
    return null;
  } catch {
    return null;
  }
}

/** A cover's average colour, for the «Музыка» tab's background; null when it does not draw. */
export async function coverColor(dataUrl: string): Promise<string | null> {
  try {
    const image = await load(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(image, 0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return `rgb(${r} ${gr} ${b})`;
  } catch {
    return null;
  }
}
