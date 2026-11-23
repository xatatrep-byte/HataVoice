"""Builds «Мира» from nothing, like build.py builds «Рэн»: a GLB with the skeleton, weights and shape keys, and beside it
the materials' toon looks and the spring chains for the VRM step.

blender -b --factory-startup --python build_mira.py -- <out.glb> [--preview <dir>]

Then `python vrm.py <out.glb> <out.vrm> --name Мира` makes the VRM.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import body  # noqa: E402
import hair  # noqa: E402
import head  # noqa: E402
import lib  # noqa: E402
import mira  # noqa: E402
import rig  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out_glb = args[0]
preview_dir = args[args.index("--preview") + 1] if "--preview" in args else None

lib.clear_scene()

# ---------------------------------------------------------------- materials (sRGB colours)
OUT = 0.75  # outline, mm
MINT = (0.42, 0.86, 0.73)
M = {
    "skin": lib.material("Skin", (0.99, 0.88, 0.81), shade=(0.95, 0.71, 0.68), outline=0.45),
    "white": lib.material("EyeWhite", (1, 1, 1), shade=(1, 1, 1), image=head.white_image()),
    "iris": lib.material("Iris", (1, 1, 1), shade=(1, 1, 1), image=head.iris_image(color=(0.30, 0.80, 0.72), dark=(0.05, 0.22, 0.27))),
    "lash": lib.material("Lash", (0.10, 0.09, 0.13), shade=(0.10, 0.09, 0.13)),
    "brow": lib.material("Brow", (0.17, 0.18, 0.27), shade=(0.12, 0.13, 0.21)),
    "mouth": lib.material("Mouth", (0.46, 0.14, 0.18), shade=(0.38, 0.10, 0.14)),
    "teeth": lib.material("Teeth", (0.99, 0.98, 0.96), shade=(0.88, 0.88, 0.92)),
    "tongue": lib.material("Tongue", (0.92, 0.50, 0.52), shade=(0.78, 0.38, 0.42)),
    "noseshade": lib.material("NoseShade", (0.94, 0.72, 0.68), shade=(0.88, 0.62, 0.60)),
    "hair": lib.material("Hair", (1, 1, 1), shade=(0.58, 0.62, 0.84), image=mira.hair_image(), outline=OUT, shift=0.05),
    "hoodie": lib.material("Hoodie", (0.95, 0.93, 0.89), shade=(0.70, 0.70, 0.83), outline=OUT),
    "rib": lib.material("Rib", (0.86, 0.85, 0.84), shade=(0.60, 0.61, 0.74), outline=OUT),
    "shorts": lib.material("Shorts", (0.34, 0.45, 0.64), shade=(0.20, 0.26, 0.44), outline=OUT),
    "shorts_dark": lib.material("ShortsHem", (0.28, 0.37, 0.54), shade=(0.16, 0.21, 0.37), outline=OUT),
    "leggings": lib.material("Leggings", (0.13, 0.13, 0.17), shade=(0.07, 0.07, 0.10), outline=OUT),
    "string": lib.material("Drawstring", MINT, shade=(0.24, 0.58, 0.56), outline=OUT),
    "metal": lib.material("Metal", (0.78, 0.80, 0.86), shade=(0.46, 0.49, 0.58), outline=OUT, rim=0.35),
    "sneaker": lib.material("Sneakers", (0.96, 0.96, 0.97), shade=(0.70, 0.72, 0.84), outline=OUT),
    "sole": lib.material("Soles", MINT, shade=(0.24, 0.58, 0.56), outline=OUT),
    "lace": lib.material("Laces", (0.99, 0.99, 0.99), shade=(0.80, 0.82, 0.90), outline=0.3),
    "phones": lib.material("Headphones", (0.18, 0.19, 0.24), shade=(0.08, 0.09, 0.13), outline=OUT, rim=0.3),
    "pads": lib.material("EarPads", (0.10, 0.10, 0.13), shade=(0.05, 0.05, 0.07), outline=OUT),
    "glow": lib.material("Glow", (0.50, 0.96, 0.82), shade=(0.40, 0.86, 0.74), emission=(0.40, 0.92, 0.76)),
}

# ---------------------------------------------------------------- body and clothes
b = mira.body_mesh()
mira.zone_body(b, M)
b.name = "Body"
hands = {}
for s in "LR":
    hnd = lib.assign(body.hand(s), M["skin"])
    lib.shade_smooth(hnd)
    hnd.name = f"Hand{s}"
    hands[s] = hnd
feet = {}
for s in "LR":
    shoe = lib.assign(mira.sneaker(s), M["sneaker"])
    sole = lib.assign(mira.sneaker_sole(s), M["sole"])
    f = lib.join([shoe, sole], f"Foot{s}")
    lib.shade_smooth(f)
    feet[s] = f
laces = mira.laces(M)

surf = lib.Surface(b)
rib, hood, pocket, cords, aglets, string_chains = mira.hoodie_parts(surf, M)
hems = mira.shorts_hems(M)
phones, pads, glow = mira.headphones(M)

# ---------------------------------------------------------------- head and hair
skull = head.skull()
hair_locks, cap = hair.build(skull, M, specs=mira.bob_specs(), crown=mira.crown_specs())
lib.assign(skull, M["skin"])
ears = lib.assign(head.ears(), M["skin"])
face_order = [M[k] for k in ("skin", "white", "iris", "lash", "brow", "mouth", "teeth", "tongue", "noseshade")]
face = head.build_face(skull, M).build("Face", face_order)
# Blender 5 makes new shape keys at full strength: at rest no expression is on.
for kb in face.data.shape_keys.key_blocks:
    kb.value = 0.0
head_ob = lib.assign(lib.join([skull, ears], "Head"), M["skin"])
hair_ob = lib.join([hair_locks, cap], "Hair")

from mathutils import Matrix  # noqa: E402

HEAD_SCALE = 1.06
pivot = np.array([0.0, 0.006, 1.47])
grow = Matrix.Translation(pivot) @ Matrix.Scale(HEAD_SCALE, 4) @ Matrix.Translation(-pivot)
for ob in (head_ob, face, hair_ob):
    ob.data.transform(grow, shape_keys=True)
    ob.data.update()

if preview_dir:
    import preview  # noqa: E402

    preview.setup(engine="EEVEE", size=(800, 1000))
    preview.sheet(preview_dir, "mira", {"front": dict(yaw=0), "q": dict(yaw=35), "side": dict(yaw=90), "back": dict(yaw=180)}, target=(0, 0, 0.86), ortho=1.95)
    preview.shoot(os.path.join(preview_dir, "mira_face.png"), target=(0, 0, 1.56), yaw=12, pitch=4, ortho=0.48)
    preview.shoot(os.path.join(preview_dir, "mira_bust.png"), target=(0, 0, 1.36), yaw=28, pitch=8, ortho=0.80)
    preview.shoot(os.path.join(preview_dir, "mira_hairback.png"), target=(0, 0.01, 1.52), yaw=150, pitch=6, ortho=0.56)
    preview.shoot(os.path.join(preview_dir, "mira_feet.png"), target=(0, -0.04, 0.10), yaw=30, pitch=14, ortho=0.50)

# ---------------------------------------------------------------- skeleton: the body and the drawstrings that swing


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
for key, pts, parent in (("StringL", string_chains[0], "upperChest"), ("StringR", string_chains[1], "upperChest")):
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
rig.chain_weights(cords, arm, chains["StringL"][0] + chains["StringR"][0], "upperChest")
rig.chain_weights(aglets, arm, chains["StringL"][0] + chains["StringR"][0], "upperChest")
for piece in (phones, pads, glow):
    rig.rigid(piece, arm, "upperChest")
bodies = [b, hands["L"], hands["R"], feet["L"], feet["R"]]
for piece in (rib, hood, pocket, hems):
    rig.transfer(piece, bodies, arm)
rig.transfer(laces, [feet["L"], feet["R"]], arm)

# ---------------------------------------------------------------- springs
hs = HEAD_SCALE
springs = {
    "colliderGroups": [
        {"name": "body", "colliders": [
            {"bone": "upperChest", "at": [0, 0.004, 1.30], "radius": 0.118},
            {"bone": "chest", "at": [0, 0.000, 1.19], "radius": 0.120},
            {"bone": "spine", "at": [0, 0.004, 1.08], "radius": 0.114},
        ]},
        {"name": "arms", "colliders": [
            {"bone": "leftUpperArm", "at": [0.165, 0.006, 1.365], "to": [0.44, 0.008, 1.365], "radius": 0.05},
            {"bone": "rightUpperArm", "at": [-0.165, 0.006, 1.365], "to": [-0.44, 0.008, 1.365], "radius": 0.05},
        ]},
    ],
    "springs": [
        {"name": "StringL", "joints": chains["StringL"][0], "stiffness": 0.5, "gravityPower": 0.6, "dragForce": 0.4, "hitRadius": 0.008, "colliderGroups": ["body", "arms"]},
        {"name": "StringR", "joints": chains["StringR"][0], "stiffness": 0.5, "gravityPower": 0.6, "dragForce": 0.4, "hitRadius": 0.008, "colliderGroups": ["body", "arms"]},
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
looks = {m.name: {k: (list(m[k]) if hasattr(m[k], "__len__") and not isinstance(m[k], str) else m[k]) for k in m.keys() if k.startswith("hv_")} for m in bpy.data.materials}
with open(base + ".looks.json", "w", encoding="utf-8") as f:
    json.dump(looks, f, ensure_ascii=False, indent=1)
tris = 0
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        print(f"  {o.name:14s} {len(o.data.loop_triangles):7d} tris  mats={[m.name if m else None for m in o.data.materials]}")
print("EXPORTED", out_glb, "tris", tris)
