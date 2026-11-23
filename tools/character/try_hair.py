"""Quick look at the head and hair: blender -b --factory-startup --python try_hair.py -- <out dir>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import hair  # noqa: E402
import head  # noqa: E402
import lib  # noqa: E402
import preview  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]
lib.clear_scene()
M = {"hair": lib.material("hair", (0.85, 0.88, 0.95)), "tie": lib.material("tie", (0.8, 0.1, 0.1)), "skin": lib.material("skin", (0.98, 0.84, 0.75))}
skull = head.skull()
locks, cap = hair.build(skull, M)
tail, tie, chain = hair.ponytail(skull, M)
lib.assign(skull, M["skin"])
lib.assign(cap, lib.material("cap", (0.6, 0.7, 0.95)))
print("locks", len(hair.lock_specs()) + len(hair.whorl_specs()))
preview.setup()
for name, yaw, pitch in (("front", 0, 3), ("back", 180, 5), ("side", 90, 3), ("q", 140, 10), ("top", 0, 70)):
    preview.shoot(os.path.join(out, f"hair_{name}.png"), target=(0, 0.01, 1.58), yaw=yaw, pitch=pitch, ortho=0.42)
