"""Builds the character from nothing and writes a GLB with its skeleton, weights and shape keys, plus what the VRM step
needs beside it (materials' toon looks, spring bone chains).

blender -b --factory-startup --python build.py -- <out.glb>

Then `python vrm.py <out.glb> <out.vrm> --name Рэн` makes the VRM.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import body  # noqa: E402
import garments  # noqa: E402
import gear  # noqa: E402
import hair  # noqa: E402
import head  # noqa: E402
import lib  # noqa: E402
import rig  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out_glb = args[0]

lib.clear_scene()

# ---------------------------------------------------------------- materials (sRGB colours)
OUT = 0.75  # outline, mm
M = {
    "skin": lib.material("Skin", (0.99, 0.88, 0.80), shade=(0.95, 0.70, 0.66), outline=0.45),
    "white": lib.material("EyeWhite", (1, 1, 1), shade=(1, 1, 1), image=head.white_image()),
    "iris": lib.material("Iris", (1, 1, 1), shade=(1, 1, 1), image=head.iris_image()),
    "lash": lib.material("Lash", (0.13, 0.10, 0.12), shade=(0.13, 0.10, 0.12)),
    "brow": lib.material("Brow", (0.42, 0.44, 0.53), shade=(0.33, 0.34, 0.44)),
    "mouth": lib.material("Mouth", (0.42, 0.13, 0.15), shade=(0.36, 0.10, 0.12)),
    "teeth": lib.material("Teeth", (0.99, 0.98, 0.96), shade=(0.88, 0.88, 0.92)),
    "tongue": lib.material("Tongue", (0.90, 0.48, 0.48), shade=(0.76, 0.36, 0.38)),
    "hair": lib.material("Hair", (1, 1, 1), shade=(0.62, 0.66, 0.86), image=hair.hair_image(), outline=OUT, shift=0.05),
    "tie": lib.material("HairTie", (0.78, 0.12, 0.16), shade=(0.48, 0.05, 0.10), outline=OUT),
    "top": lib.material("Top", (0.15, 0.17, 0.27), shade=(0.08, 0.09, 0.17), outline=OUT),
    "pants": lib.material("Trousers", (0.27, 0.29, 0.35), shade=(0.15, 0.16, 0.22), outline=OUT),
    "trim": lib.material("Trim", (0.80, 0.82, 0.88), shade=(0.52, 0.56, 0.68), outline=OUT),
    "piping": lib.material("Piping", (0.66, 0.11, 0.16), shade=(0.40, 0.05, 0.10), outline=OUT),
    "fishnet": lib.material("Fishnet", (1, 1, 1), shade=(0.8, 0.8, 0.8), image=garments.fishnet_image(), alpha="MASK"),
    "lacquer": lib.material("Lacquer", (0.24, 0.06, 0.08), shade=(0.11, 0.02, 0.04), outline=OUT, rim=0.25),
    "gold": lib.material("Gold", (0.90, 0.72, 0.36), shade=(0.56, 0.38, 0.16), outline=OUT, rim=0.3),
    "grip": lib.material("Grip", (1, 1, 1), shade=(0.7, 0.7, 0.72), image=gear.grip_image(), outline=OUT),
    "leather": lib.material("Leather", (0.42, 0.27, 0.17), shade=(0.24, 0.14, 0.09), outline=OUT),
    "noseshade": lib.material("NoseShade", (0.93, 0.70, 0.64), shade=(0.88, 0.60, 0.56)),
    "sash": lib.material("Sash", (1, 1, 1), shade=(0.62, 0.52, 0.60), image=garments.sash_image(), outline=OUT),
    "scarf": lib.material("Scarf", (0.82, 0.13, 0.17), shade=(0.52, 0.05, 0.11), outline=OUT),
    "bandage": lib.material("Wraps", (1, 1, 1), shade=(0.78, 0.74, 0.74), image=garments.bandage_image(), outline=OUT),
    "glove": lib.material("Gloves", (0.15, 0.15, 0.18), shade=(0.07, 0.07, 0.10), outline=OUT),
    "metal": lib.material("Metal", (0.74, 0.76, 0.82), shade=(0.42, 0.45, 0.54), outline=OUT, rim=0.35),
    "boot": lib.material("Boots", (0.12, 0.12, 0.14), shade=(0.06, 0.06, 0.08), outline=OUT),
    "wrap": None,
}
M["wrap"] = M["bandage"]

# ---------------------------------------------------------------- body
b = body.body_mesh()
garments.zone_body(b, M)
b.name = "Body"
hands = {}
for s in "LR":
    hnd = body.hand(s)
    garments.glove_zones(hnd, s, M)
    hnd.name = f"Hand{s}"
    hands[s] = hnd
feet = {}
for s in "LR":
    f = lib.assign(body.foot(s), M["boot"])
    lib.shade_smooth(f)
    f.name = f"Foot{s}"
    feet[s] = f

surf = lib.Surface(b)
net = garments.fishnet(b, M)
scabbard, sword_metal, hilt = gear.sword(M)
strap, buckle = gear.strap(surf, M)
plate, cord = gear.shoulder_plate(M)
collar = garments.collar(surf, M)
holes = garments.armholes(M)
sash, sash_ends, sash_chains = garments.sash(M)
scarf, scarf_tails, scarf_chains = garments.scarf(surf, M)
arm_wraps = garments.forearm_wraps(M)
shin_wraps = garments.shin_wraps(M)
cuffs, plates = garments.glove_parts(M)

# ---------------------------------------------------------------- head and hair
skull = head.skull()
hair_locks, cap = hair.build(skull, M)
tail, tie, tail_chain = hair.ponytail(skull, M)
lib.assign(skull, M["skin"])
ears = lib.assign(head.ears(), M["skin"])
face_order = [M[k] for k in ("skin", "white", "iris", "lash", "brow", "mouth", "teeth", "tongue", "noseshade")]
face = head.build_face(skull, M).build("Face", face_order)
# Blender 5 makes new shape keys at full strength: at rest no expression is on.
for kb in face.data.shape_keys.key_blocks:
    kb.value = 0.0
head_ob = lib.assign(lib.join([skull, ears], "Head"), M["skin"])
hair_ob = lib.join([hair_locks, cap, tie], "Hair")

# A slightly bigger head reads better at the stage's size: everything above the neck grows round its base.
from mathutils import Matrix  # noqa: E402

HEAD_SCALE = 1.06
pivot = np.array([0.0, 0.006, 1.47])
grow = Matrix.Translation(pivot) @ Matrix.Scale(HEAD_SCALE, 4) @ Matrix.Translation(-pivot)
for ob in (head_ob, face, hair_ob, tail):
    ob.data.transform(grow, shape_keys=True)
    ob.data.update()
tail_chain = pivot + (np.asarray(tail_chain) - pivot) * HEAD_SCALE

# ---------------------------------------------------------------- skeleton: the body and the chains that swing


def chain_bones(prefix, pts, parent):
    out = {}
    names = []
    for i in range(len(pts) - 1):
        name = f"{prefix}{i + 1}"
        out[name] = (tuple(pts[i]), tuple(pts[i + 1]), parent if i == 0 else names[-1])
        names.append(name)
    return out, names


extra = {}
chains = {}
for key, pts, parent in (
    ("Ponytail", tail_chain, "head"),
    ("ScarfL", scarf_chains[0], "upperChest"),
    ("ScarfR", scarf_chains[1], "upperChest"),
    ("SashA", sash_chains[0], "hips"),
    ("SashB", sash_chains[1], "hips"),
):
    bones, names = chain_bones(key, pts, parent)
    extra.update(bones)
    chains[key] = (names, parent)

arm = rig.make_armature(rig.bone_layout(), extra)

# ---------------------------------------------------------------- weights
rig.heat(b, arm)
for s, side in (("L", "left"), ("R", "right")):
    rig.segment_weights(hands[s], arm, rig.hand_bones(side), power=7)
    rig.segment_weights(feet[s], arm, rig.foot_bones(side), power=5)
rig.rigid(head_ob, arm, "head")
rig.rigid(face, arm, "head")
rig.rigid(hair_ob, arm, "head")
rig.chain_weights(tail, arm, chains["Ponytail"][0], "head")
rig.chain_weights(scarf_tails, arm, chains["ScarfL"][0] + chains["ScarfR"][0], "upperChest")
rig.chain_weights(sash_ends, arm, chains["SashA"][0] + chains["SashB"][0], "hips")
bodies = [b, hands["L"], hands["R"], feet["L"], feet["R"]]
for piece in (scabbard, sword_metal, hilt):
    rig.rigid(piece, arm, "chest")
for piece in (collar, holes, sash, scarf, arm_wraps, shin_wraps, cuffs, plates, net, strap, buckle, plate, cord):
    rig.transfer(piece, bodies, arm)

# ---------------------------------------------------------------- springs
hs = 1.06  # the head grew round its base
springs = {
    "colliderGroups": [
        {"name": "head", "colliders": [{"bone": "head", "at": [0, 0.006 + (0.012 - 0.006) * hs, 1.47 + (1.60 - 1.47) * hs], "radius": 0.112}]},
        {"name": "body", "colliders": [
            {"bone": "upperChest", "at": [0, 0.012, 1.30], "radius": 0.118},
            {"bone": "chest", "at": [0, 0.004, 1.17], "radius": 0.118},
            {"bone": "spine", "at": [0, 0.006, 1.06], "radius": 0.112},
            {"bone": "hips", "at": [0, 0.012, 0.93], "radius": 0.132},
        ]},
        {"name": "sword", "colliders": [{"bone": "chest", "at": list(gear.SWORD_TOP), "to": list(gear.SWORD_BOTTOM), "radius": 0.03}]},
        {"name": "arms", "colliders": [
            {"bone": "leftUpperArm", "at": [0.165, 0.006, 1.365], "to": [0.44, 0.008, 1.365], "radius": 0.05},
            {"bone": "rightUpperArm", "at": [-0.165, 0.006, 1.365], "to": [-0.44, 0.008, 1.365], "radius": 0.05},
            {"bone": "leftLowerArm", "at": [0.44, 0.008, 1.365], "to": [0.70, 0.006, 1.365], "radius": 0.042},
            {"bone": "rightLowerArm", "at": [-0.44, 0.008, 1.365], "to": [-0.70, 0.006, 1.365], "radius": 0.042},
        ]},
        {"name": "legs", "colliders": [
            {"bone": "leftUpperLeg", "at": [0.092, 0.004, 0.905], "to": [0.096, -0.004, 0.50], "radius": 0.092},
            {"bone": "rightUpperLeg", "at": [-0.092, 0.004, 0.905], "to": [-0.096, -0.004, 0.50], "radius": 0.092},
        ]},
    ],
    "springs": [
        {"name": "Ponytail", "joints": chains["Ponytail"][0], "stiffness": 0.75, "gravityPower": 0.35, "dragForce": 0.35, "hitRadius": 0.025, "colliderGroups": ["head", "body", "sword"]},
        {"name": "ScarfL", "joints": chains["ScarfL"][0], "stiffness": 0.45, "gravityPower": 0.55, "dragForce": 0.30, "hitRadius": 0.03, "colliderGroups": ["body", "arms", "legs", "sword"]},
        {"name": "ScarfR", "joints": chains["ScarfR"][0], "stiffness": 0.45, "gravityPower": 0.55, "dragForce": 0.30, "hitRadius": 0.03, "colliderGroups": ["body", "arms", "legs", "sword"]},
        {"name": "SashA", "joints": chains["SashA"][0], "stiffness": 0.6, "gravityPower": 0.5, "dragForce": 0.4, "hitRadius": 0.02, "colliderGroups": ["legs"]},
        {"name": "SashB", "joints": chains["SashB"][0], "stiffness": 0.6, "gravityPower": 0.5, "dragForce": 0.4, "hitRadius": 0.02, "colliderGroups": ["legs"]},
    ],
}
base = os.path.splitext(out_glb)[0]
with open(base + ".springs.json", "w", encoding="utf-8") as f:
    json.dump(springs, f, indent=1)

# ---------------------------------------------------------------- export
bpy.ops.export_scene.gltf(
    filepath=out_glb,
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=False,
    export_skins=True,
    export_morph=True,
    export_morph_normal=False,
    export_animations=False,
    export_image_format="AUTO",
)
looks = {m.name: {k: (list(m[k]) if hasattr(m[k], "__len__") and not isinstance(m[k], str) else m[k]) for m_k in [m] for k in m.keys() if k.startswith("hv_")} for m in bpy.data.materials}
with open(base + ".looks.json", "w", encoding="utf-8") as f:
    json.dump(looks, f, ensure_ascii=False, indent=1)
tris = 0
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        print(f"  {o.name:14s} {len(o.data.loop_triangles):7d} tris  mats={[m.name if m else None for m in o.data.materials]}")
print("EXPORTED", out_glb, "tris", tris)
