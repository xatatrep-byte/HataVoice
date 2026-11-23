/**
 * What a ready motion looks like for the constructor: the same body a call shows. Standing is the recorded idle; an act
 * with a recording of its own plays it over that; a drawn act moves the joints it needs and the recording keeps the rest
 * alive, as on the call's stage. Face and fists always come from the drawn act.
 */
import type { Sampler } from "./compose";
import { newFrame, type MotionFrame, type MotionLibrary } from "./mocap";
import { actLength, JOINTS, poseAt, restPose, type Joint, type Pose } from "./motion";
import { actMotion, recordedAct } from "./motionPlan";
import { BONE_OF, jointFromBone } from "./rig";

/** A drawn joint counts as moved by the act when it is this far (radians) from the bare pose. */
const MOVED = 0.05;

const differs = (a: Joint, b: Joint) => Math.abs(a[0] - b[0]) > MOVED || Math.abs(a[1] - b[1]) > MOVED || Math.abs(a[2] - b[2]) > MOVED;

/** How long standing plays in the constructor's preview before it comes round again. */
const STAND = 4;

export function makeSampler(lib: MotionLibrary | null): Sampler {
  const frame: MotionFrame = newFrame();
  const scratch: MotionFrame = newFrame();
  const bare = poseAt({ t: 0, seed: 0, level: 0, act: null });
  const rest = restPose();
  return {
    length: (act) => (act ? actLength(act) : STAND),
    pose(act, u) {
      const drawn = poseAt({ t: u, seed: 0, level: 0, act: act ? { id: act, elapsed: u, role: "solo" } : null });
      const idle = lib?.clip("idle");
      if (!lib || !idle) return drawn;
      idle.sample(u, frame);
      const recorded = !!act && recordedAct(act, "solo") && actMotion(lib, { id: act, elapsed: u, length: actLength(act), role: "solo" }, frame, scratch);
      const pose: Pose = { ...drawn };
      for (const name of JOINTS) {
        const bone = frame.rot.get(BONE_OF[name]);
        const fromRecording = bone ? jointFromBone(name, bone) : rest[name];
        pose[name] = recorded || !differs(drawn[name], bare[name]) ? fromRecording : drawn[name];
      }
      return pose;
    },
  };
}
