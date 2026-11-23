import score from "./iskra-motions.json";
import { BODY_FIELDS, FACE_FIELDS, keyFromPose, type BodyField, type Clip, type FaceField } from "./clip";
import { JOINTS, restPose, type Joint, type JointName } from "./motion";

// Blender reads the same performance score. Joint angles are in degrees for the artist.
type Mark = Partial<Record<JointName, number[]> & Record<BodyField | FaceField, number>>;
type Beat = [number, string, Mark?];
const poses: Record<string, Mark> = score.poses;
const clips = Object.entries(score.actions).map(([id, action]): [string, Clip] => {
  const keys = (action.keys as Beat[]).map(([time, poseName, changes]) => {
    const mark = { ...poses[poseName], ...changes };
    const pose = restPose();
    for (const joint of JOINTS) {
      const degrees = mark[joint];
      if (degrees) pose[joint] = degrees.map((angle) => (angle * Math.PI) / 180) as Joint;
    }
    for (const field of [...FACE_FIELDS, ...BODY_FIELDS]) {
      if (mark[field] !== undefined) pose[field] = mark[field]!;
    }
    return keyFromPose(pose, time);
  });
  return [id, { id, name: action.name, duration: keys[keys.length - 1]!.t, emoji: "", loop: false, keys }];
});

export function galleryMotions(id: string, personal: Map<string, Clip> = new Map()): Map<string, Clip> {
  return id === "iskra" ? new Map([...clips, ...personal]) : personal;
}
