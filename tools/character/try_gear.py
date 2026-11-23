"""Quick look at the shoulder plate and strap on the body."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import body  # noqa: E402
import gear  # noqa: E402
import lib  # noqa: E402
import preview  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]
lib.clear_scene()
M = {k: lib.material(k, c) for k, c in (("metal", (0.75, 0.77, 0.83)), ("piping", (0.7, 0.1, 0.15)), ("leather", (0.45, 0.28, 0.17)), ("gold", (0.9, 0.72, 0.36)), ("lacquer", (0.3, 0.07, 0.09)), ("grip", (0.2, 0.2, 0.2)), ("skin", (0.95, 0.82, 0.74)))}
b = lib.assign(body.body_mesh(), M["skin"])
surf = lib.Surface(b)
gear.shoulder_plate(M)
gear.strap(surf, M)
gear.sword(M)
preview.setup()
for name, yaw in (("front", 0), ("left", 60), ("back", 180), ("bl", 220)):
    preview.shoot(os.path.join(out, f"gear_{name}.png"), target=(0, 0.02, 1.2), yaw=yaw, pitch=8, ortho=0.85)
