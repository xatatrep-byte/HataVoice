/** What the workshop does to a clip: every change gives a new clip, so that undo is just the previous one. */
import { emptyClip, keyFromPose, mirrorKey, writeClipPose, type Clip, type ClipKey } from "./clip";
import { actLength, poseAt, restPose, type JointName, type Pose } from "./motion";

/** Two keys this close are one: a hand cannot put them apart anyway. */
const SAME_KEY = 0.015;

export function keyIndexAt(clip: Clip, t: number): number {
  return clip.keys.findIndex((key) => Math.abs(key.t - t) < SAME_KEY);
}

/** The pose a clip has at `t`. */
export function poseOfClip(clip: Clip, t: number): Pose {
  const pose = restPose();
  writeClipPose(clip, t, pose);
  return pose;
}

const sorted = (keys: ClipKey[]) => [...keys].sort((a, b) => a.t - b.t);

/** Changes the pose at `t`: the key there, or a new one made of what the clip shows at that moment. */
export function editPose(clip: Clip, t: number, change: (pose: Pose) => void): Clip {
  const pose = poseOfClip(clip, t);
  change(pose);
  const index = keyIndexAt(clip, t);
  const key = keyFromPose(pose, index >= 0 ? clip.keys[index]!.t : t, index >= 0 ? clip.keys[index]!.ease : "smooth");
  const keys = index >= 0 ? clip.keys.map((k, i) => (i === index ? key : k)) : [...clip.keys, key];
  return { ...clip, keys: sorted(keys) };
}

/** A key at `t` with the pose shown there. */
export function addKey(clip: Clip, t: number): Clip {
  return editPose(clip, t, () => {});
}

/** Takes the key at `t` away; the last one stays, a clip needs one. */
export function removeKey(clip: Clip, t: number): Clip {
  const index = keyIndexAt(clip, t);
  if (index < 0 || clip.keys.length <= 1) return clip;
  return { ...clip, keys: clip.keys.filter((_, i) => i !== index) };
}

/** Moves a key along the timeline, not past the clip's ends. */
export function moveKey(clip: Clip, from: number, to: number): Clip {
  const index = keyIndexAt(clip, from);
  if (index < 0) return clip;
  const t = Math.max(0, Math.min(clip.duration, Number(to.toFixed(3))));
  // On top of another key it would be lost: it stays where it was.
  if (clip.keys.some((key, i) => i !== index && Math.abs(key.t - t) < SAME_KEY)) return clip;
  return { ...clip, keys: sorted(clip.keys.map((key, i) => (i === index ? { ...key, t } : key))) };
}

/** A new length: the keys stretch with it, so the motion stays the same, faster or slower. */
export function stretch(clip: Clip, duration: number): Clip {
  const next = Math.max(0.2, Math.min(60, duration));
  const k = next / clip.duration;
  return { ...clip, duration: next, keys: clip.keys.map((key) => ({ ...key, t: Number((key.t * k).toFixed(3)) })) };
}

/** The pose at `t` with its left and right sides swapped. */
export function mirrorAt(clip: Clip, t: number): Clip {
  const index = keyIndexAt(clip, t);
  const base = index >= 0 ? clip.keys[index]! : keyFromPose(poseOfClip(clip, t), t);
  const mirrored = mirrorKey(base);
  const keys = index >= 0 ? clip.keys.map((k, i) => (i === index ? mirrored : k)) : [...clip.keys, mirrored];
  return { ...clip, keys: sorted(keys) };
}

/** One joint back to where it stands at rest. */
export function resetJoint(clip: Clip, t: number, joint: JointName): Clip {
  const rest = restPose();
  return editPose(clip, t, (pose) => {
    pose[joint] = rest[joint];
  });
}

/** A pose copied, and put somewhere else. */
export function pastePose(clip: Clip, t: number, copied: ClipKey): Clip {
  const index = keyIndexAt(clip, t);
  const key = { ...copied, t: index >= 0 ? clip.keys[index]!.t : t };
  const keys = index >= 0 ? clip.keys.map((k, i) => (i === index ? key : k)) : [...clip.keys, key];
  return { ...clip, keys: sorted(keys) };
}

/** A clip made of an emote of the program: a good place to start from. */
export function clipFromAct(id: string, name: string, emoji: string): Clip {
  const clip = emptyClip(name);
  clip.emoji = emoji;
  clip.duration = actLength(id);
  const count = Math.max(8, Math.min(40, Math.ceil(clip.duration * 7)));
  clip.keys = Array.from({ length: count + 1 }, (_, i) => {
    const t = (i / count) * clip.duration;
    const pose = poseAt({ t: 0, seed: 0, level: 0, act: { id, elapsed: t, role: "solo" } });
    return keyFromPose(pose, t);
  });
  return clip;
}
