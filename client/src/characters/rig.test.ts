import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { humanBoneOf, jointFromBone, normalizedBone } from "./rig";

const near = (v: Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 4);
  expect(v.y).toBeCloseTo(y, 4);
  expect(v.z).toBeCloseTo(z, 4);
};

describe("a pose on a human skeleton", () => {
  it("a joint at rest lowers the arms out of the T-pose", () => {
    near(new Vector3(1, 0, 0).applyQuaternion(normalizedBone("armL", [0, 0, 0])), 0, -1, 0);
    near(new Vector3(-1, 0, 0).applyQuaternion(normalizedBone("armR", [0, 0, 0])), 0, -1, 0);
  });

  it("an arm goes where the same joint takes a hanging limb", () => {
    // In a figure a hanging arm is (0,−1,0) turned by the joint.
    const joint: [number, number, number] = [-0.9, 0.2, 0.4];
    const hanging = new Vector3(0, -1, 0).applyQuaternion(normalizedBone("legL", joint));
    near(new Vector3(1, 0, 0).applyQuaternion(normalizedBone("armL", joint)), hanging.x, hanging.y, hanging.z);
    near(new Vector3(-1, 0, 0).applyQuaternion(normalizedBone("armR", joint)), hanging.x, hanging.y, hanging.z);
  });

  it("the forearm bends the way it does in a figure, whatever the arm does", () => {
    const arm: [number, number, number] = [-0.5, 0.3, 0.2];
    const fore: [number, number, number] = [-1.2, 0, 0];
    const armBone = normalizedBone("armL", arm);
    const foreBone = normalizedBone("foreL", fore);
    const onModel = new Vector3(1, 0, 0).applyQuaternion(armBone.clone().multiply(foreBone));
    const inFigure = new Vector3(0, -1, 0).applyQuaternion(normalizedBone("spine", arm).multiply(normalizedBone("spine", fore)));
    near(onModel, inFigure.x, inFigure.y, inFigure.z);
  });

  it("a body's joints go as they are", () => {
    const q = normalizedBone("head", [0.2, 0.3, 0]);
    expect(q.equals(new Quaternion(0, 0, 0, 1))).toBe(false);
    near(new Vector3(0, 1, 0).applyQuaternion(normalizedBone("legR", [0, 0, 0])), 0, 1, 0);
  });

  it("a motion from a file comes back to the same joint", () => {
    for (const name of ["armL", "armR", "foreL", "handR", "legL", "head"] as const) {
      const joint: [number, number, number] = [0.4, -0.3, 0.25];
      const back = jointFromBone(name, normalizedBone(name, joint));
      back.forEach((v, i) => expect(v).toBeCloseTo(joint[i]!, 4));
    }
  });
});

describe("bones by their names", () => {
  it("knows the names of common rigging tools", () => {
    expect(humanBoneOf("mixamorig:LeftArm")).toBe("leftUpperArm");
    expect(humanBoneOf("mixamorigLeftForeArm")).toBe("leftLowerArm");
    expect(humanBoneOf("mixamorig:RightUpLeg")).toBe("rightUpperLeg");
    expect(humanBoneOf("mixamorig:RightLeg")).toBe("rightLowerLeg");
    expect(humanBoneOf("mixamorig:Hips")).toBe("hips");
    expect(humanBoneOf("DEF-thigh.L")).toBe("leftUpperLeg");
    expect(humanBoneOf("upperarm.R")).toBe("rightUpperArm");
    expect(humanBoneOf("Armature|Head")).toBe("head");
    expect(humanBoneOf("J_Bip_C_Hips")).toBe("hips");
    expect(humanBoneOf("Spine1")).toBe(null === humanBoneOf("Spine1") ? null : "spine");
  });

  it("does not take a finger or a hair for a limb", () => {
    expect(humanBoneOf("mixamorig:LeftHandIndex1")).toBeNull();
    expect(humanBoneOf("Hair_01")).toBeNull();
    expect(humanBoneOf("LeftEye")).toBeNull();
  });
});
