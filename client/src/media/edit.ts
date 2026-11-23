/** What a file is, as far as the editors go: a photo or a video one can change before it is sent, by its name. */
export function kindOf(name: string): "photo" | "video" | null {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(lower)) return "photo";
  if (/\.(mp4|mov|m4v|webm|mkv)$/.test(lower)) return "video";
  return null;
}
