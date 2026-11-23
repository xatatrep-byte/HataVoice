"""Quick look at the head: blender -b --factory-startup --python try_head.py -- <out dir> [shape]"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import head  # noqa: E402
import lib  # noqa: E402
import preview  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
shapes = args[1:]
lib.clear_scene()
mats = {
    "skin": lib.material("skin", (0.98, 0.84, 0.75)),
    "white": lib.material("white", (1, 1, 1), image=head.white_image()),
    "iris": lib.material("iris", (1, 1, 1), image=head.iris_image()),
    "lash": lib.material("lash", (0.12, 0.09, 0.10)),
    "brow": lib.material("brow", (0.50, 0.53, 0.62)),
    "mouth": lib.material("mouth", (0.36, 0.11, 0.13)),
    "teeth": lib.material("teeth", (0.98, 0.97, 0.95)),
    "tongue": lib.material("tongue", (0.86, 0.42, 0.42)),
}
h = head.skull()
lib.assign(h, mats["skin"])
e = head.ears()
lib.assign(e, mats["skin"])
parts = head.build_face(h, mats)
face = parts.build("face", list(mats.values()))
print("head verts", len(h.data.vertices), "face verts", len(face.data.vertices), [k.name for k in face.data.shape_keys.key_blocks])
preview.setup(engine="EEVEE", size=(800, 800))
for sh in ["rest"] + shapes:
    for kb in face.data.shape_keys.key_blocks:
        kb.value = 0.0
    for name in sh.split("+"):
        if name in face.data.shape_keys.key_blocks:
            face.data.shape_keys.key_blocks[name].value = 1.0
    preview.shoot(os.path.join(out, f"head_{sh}.png"), target=(0, -0.02, 1.565), yaw=0, pitch=2, ortho=0.30)
preview.shoot(os.path.join(out, "head_q.png"), target=(0, -0.02, 1.565), yaw=40, pitch=5, ortho=0.32)
preview.shoot(os.path.join(out, "head_side.png"), target=(0, 0.0, 1.565), yaw=90, pitch=0, ortho=0.32)
