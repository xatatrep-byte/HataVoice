"""Builds «Кай» from nothing, like build.py builds «Рэн»: a GLB with the skeleton, weights and shape keys, and beside it
the materials' toon looks for the VRM step.

blender -b --factory-startup --python build_kai.py -- <out.glb> [--preview <dir>]

Then `python vrm.py <out.glb> <out.vrm> --name Кай` makes the VRM.
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
import kai  # noqa: E402
import lib  # noqa: E402
import rig  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out_glb = args[0]
preview_dir = args[args.index("--preview") + 1] if "--preview" in args else None

lib.clear_scene()

# ---------------------------------------------------------------- materials (sRGB colours)
OUT = 0.75  # outline, mm
ORANGE = (0.97, 0.55, 0.22)
M = {
    "skin": lib.material("Skin", (0.97, 0.82, 0.71), shade=(0.89, 0.62, 0.55), outline=0.45),
    "white": lib.material("EyeWhite", (1, 1, 1), shade=(1, 1, 1), image=head.white_image()),
    "iris": lib.material("Iris", (1, 1, 1), shade=(1, 1, 1), image=head.iris_image(color=(0.86, 0.56, 0.22), dark=(0.36, 0.16, 0.06))),
    "lash": lib.material("Lash", (0.12, 0.09, 0.08), shade=(0.12, 0.09, 0.08)),
    "brow": lib.material("Brow", (0.20, 0.14, 0.11), shade=(0.14, 0.10, 0.08)),
    "mouth": lib.material("Mouth", (0.42, 0.13, 0.15), shade=(0.36, 0.10, 0.12)),
    "teeth": lib.material("Teeth", (0.99, 0.98, 0.96), shade=(0.88, 0.88, 0.92)),
    "tongue": lib.material("Tongue", (0.90, 0.48, 0.48), shade=(0.76, 0.36, 0.38)),
    "noseshade": lib.material("NoseShade", (0.92, 0.72, 0.64), shade=(0.86, 0.60, 0.54)),
    "hair": lib.material("Hair", (1, 1, 1), shade=(0.62, 0.56, 0.62), image=kai.hair_image(), outline=OUT, shift=0.05),
    "jacket": lib.material("Bomber", (0.17, 0.18, 0.22), shade=(0.08, 0.09, 0.13), outline=OUT, rim=0.15),
    "rib": lib.material("Rib", (0.11, 0.12, 0.14), shade=(0.05, 0.05, 0.07), outline=OUT),
    "stripe": lib.material("Stripe", ORANGE, shade=(0.70, 0.30, 0.14), outline=0.4),
    "patch": lib.material("Patch", (0.42, 0.86, 0.73), shade=(0.24, 0.58, 0.56), outline=0.4),
    "metal": lib.material("Metal", (0.78, 0.80, 0.86), shade=(0.46, 0.49, 0.58), outline=OUT, rim=0.35),
    "pants": lib.material("Cargo", (0.45, 0.46, 0.49), shade=(0.27, 0.28, 0.34), outline=OUT),
    "pants_dark": lib.material("CargoPocket", (0.40, 0.41, 0.44), shade=(0.23, 0.24, 0.30), outline=OUT),
    "canvas": lib.material("Canvas", (0.13, 0.13, 0.16), shade=(0.06, 0.06, 0.08), outline=OUT),
    "rubber": lib.material("Rubber", (0.96, 0.95, 0.93), shade=(0.72, 0.72, 0.80), outline=OUT),
    "lace": lib.material("Laces", (0.99, 0.99, 0.99), shade=(0.80, 0.82, 0.90), outline=0.3),
    "beanie": lib.material("Beanie", ORANGE, shade=(0.74, 0.34, 0.16), outline=OUT),
    "beanie_cuff": lib.material("BeanieCuff", (0.93, 0.50, 0.19), shade=(0.68, 0.30, 0.13), outline=OUT),
}

# ---------------------------------------------------------------- body and clothes
b = kai.body_mesh()
kai.zone_body(b, M)
b.name = "Body"
hands = {}
for s in "LR":
    hnd = lib.assign(body.hand(s), M["skin"])
    lib.shade_smooth(hnd)
    hnd.name = f"Hand{s}"
    hands[s] = hnd
feet = {}
for s in "LR":
    parts = [lib.assign(kai.sneaker(s), M["canvas"]), lib.assign(kai.high_top(s), M["canvas"]), lib.assign(kai.sole(s), M["rubber"]), lib.assign(kai.toe_cap(s), M["rubber"])]
    f = lib.join(parts, f"Foot{s}")
    lib.shade_smooth(f)
    feet[s] = f
laces = kai.laces(M)

surf = lib.Surface(b)
rib, stripes, zipper, patch = kai.jacket_parts(surf, M)
pockets = kai.cargo_pockets(surf, M)

# ---------------------------------------------------------------- head, hair and beanie
skull = head.skull()
hair_locks, cap = hair.build(skull, M, specs=kai.short_specs(), crown=[])
dome, cuff, label = kai.beanie(skull, M)
lib.assign(skull, M["skin"])
ears = lib.assign(head.ears(), M["skin"])
face_order = [M[k] for k in ("skin", "white", "iris", "lash", "brow", "mouth", "teeth", "tongue", "noseshade")]
face = head.build_face(skull, M).build("Face", face_order)
# Blender 5 makes new shape keys at full strength: at rest no expression is on.
for kb in face.data.shape_keys.key_blocks:
    kb.value = 0.0
head_ob = lib.assign(lib.join([skull, ears], "Head"), M["skin"])
hair_ob = lib.join([hair_locks, cap], "Hair")
hat = lib.join([dome, cuff, label], "Beanie")

from mathutils import Matrix  # noqa: E402

HEAD_SCALE = 1.06
pivot = np.array([0.0, 0.006, 1.47])
grow = Matrix.Translation(pivot) @ Matrix.Scale(HEAD_SCALE, 4) @ Matrix.Translation(-pivot)
for ob in (head_ob, face, hair_ob, hat):
    ob.data.transform(grow, shape_keys=True)
    ob.data.update()

if preview_dir:
    import preview  # noqa: E402

    preview.setup(engine="EEVEE", size=(800, 1000))
    preview.sheet(preview_dir, "kai", {"front": dict(yaw=0), "q": dict(yaw=35), "side": dict(yaw=90), "back": dict(yaw=180)}, target=(0, 0, 0.86), ortho=1.95)
    preview.shoot(os.path.join(preview_dir, "kai_face.png"), target=(0, 0, 1.58), yaw=12, pitch=4, ortho=0.50)
    preview.shoot(os.path.join(preview_dir, "kai_bust.png"), target=(0, 0, 1.36), yaw=28, pitch=8, ortho=0.82)
    preview.shoot(os.path.join(preview_dir, "kai_back.png"), target=(0, 0.01, 1.50), yaw=150, pitch=6, ortho=0.60)
    preview.shoot(os.path.join(preview_dir, "kai_feet.png"), target=(0, -0.04, 0.12), yaw=30, pitch=14, ortho=0.55)
    preview.shoot(os.path.join(preview_dir, "kai_legs.png"), target=(0, 0, 0.62), yaw=60, pitch=4, ortho=0.70)

# ---------------------------------------------------------------- skeleton and weights
arm = rig.make_armature(rig.bone_layout())
rig.heat(b, arm)
for s, side in (("L", "left"), ("R", "right")):
    rig.segment_weights(hands[s], arm, rig.hand_bones(side), power=7)
    rig.segment_weights(feet[s], arm, rig.foot_bones(side), power=5)
for piece in (head_ob, face, hair_ob, hat):
    rig.rigid(piece, arm, "head")
bodies = [b, hands["L"], hands["R"], feet["L"], feet["R"]]
for piece in (rib, stripes, zipper, patch, pockets):
    rig.transfer(piece, bodies, arm)
rig.transfer(laces, [feet["L"], feet["R"]], arm)

# Nothing of his swings: no spring chains.
base = os.path.splitext(out_glb)[0]
with open(base + ".springs.json", "w", encoding="utf-8") as f:
    json.dump({"colliderGroups": [], "springs": []}, f, indent=1)

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
