"""Quick look at the body alone: blender -b --factory-startup --python try_body.py -- <out dir>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import body  # noqa: E402
import lib  # noqa: E402
import preview  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]
lib.clear_scene()
skin = lib.material("skin", (0.95, 0.80, 0.70))
b = body.body_mesh()
lib.assign(b, skin)
for side in "LR":
    lib.assign(body.hand(side), skin)
    lib.assign(body.foot(side), lib.material("boot" + side, (0.15, 0.15, 0.17)))
print("verts", len(b.data.vertices))
preview.setup()
preview.sheet(out, "body", {"front": dict(yaw=0), "side": dict(yaw=90), "back": dict(yaw=180), "q": dict(yaw=35)}, target=(0, 0, 0.88), ortho=1.95)
preview.shoot(os.path.join(out, "body_hand.png"), target=(0.76, 0, 1.36), yaw=0, pitch=60, ortho=0.30)
preview.shoot(os.path.join(out, "body_handf.png"), target=(0.76, 0, 1.36), yaw=60, pitch=10, ortho=0.30)
