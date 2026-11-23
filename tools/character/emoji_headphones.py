"""The 🎧 picture of the «Диджей» act, in the soft 3D look of the other act pictures: big graphite headphones with mint
cushions and glowing rings, on nothing (transparent), 128 px.

blender -b --factory-startup --python emoji_headphones.py -- <out.webp>
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import lib  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]
lib.clear_scene()


def principled(name, color, rough, emit=None, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*lib.linear(color), 1)
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.12
    if emit:
        b.inputs["Emission Color"].default_value = (*lib.linear(emit), 1)
        b.inputs["Emission Strength"].default_value = 3.0
    return m


shell = principled("Shell", (0.13, 0.14, 0.21), 0.3, coat=0.6)
cushion = principled("Cushion", (0.40, 0.86, 0.72), 0.55)
glow = principled("Glow", (0.55, 0.98, 0.84), 0.3, emit=(0.45, 0.95, 0.80))
inner = principled("Inner", (0.11, 0.12, 0.15), 0.6)

# The band: an arch over the top (in the XZ plane), its padded underside darker.
arch = [(math.cos(a) * 0.62, 0.0, 0.10 + math.sin(a) * 0.70) for a in np.linspace(math.radians(8), math.radians(172), 25)]
band = lib.loft([dict(c=p, rx=0.050, ry=0.120, p=2.6) for p in arch], n=24, sub=2, up=(0, 1, 0), name="band")
lib.assign(band, shell)
pad = lib.loft([dict(c=(p[0] * 0.93, p[1], p[2] * 0.93 + 0.02), rx=0.040, ry=0.090, p=2.4) for p in arch[4:-4]], n=20, sub=2, up=(0, 1, 0), name="pad")
lib.assign(pad, inner)
for ob in (band, pad):
    lib.shade_smooth(ob)

for s in (1, -1):
    x = s * 0.60
    # The cup: a thick rounded drum facing out along x, the cushion on its inner side, a ring of light on the outside.
    cup = lib.loft([dict(c=(x + s * 0.02, 0, -0.08), rx=0.26, ry=0.30, p=2.2), dict(c=(x + s * 0.12, 0, -0.08), rx=0.29, ry=0.33, p=2.2), dict(c=(x + s * 0.20, 0, -0.08), rx=0.25, ry=0.29, p=2.2)], n=40, sub=3, up=(0, 0, 1), name="cup")
    lib.assign(cup, shell)
    soft = lib.loft([dict(c=(x - s * 0.08, 0, -0.08), rx=0.23, ry=0.27, p=2.0), dict(c=(x - s * 0.01, 0, -0.08), rx=0.27, ry=0.31, p=2.0), dict(c=(x + s * 0.04, 0, -0.08), rx=0.27, ry=0.31, p=2.0)], n=40, sub=3, up=(0, 0, 1), name="cushion")
    lib.assign(soft, cushion)
    ring = lib.loft([dict(c=(x + s * 0.205, 0, -0.08), rx=0.17, ry=0.20, p=2.0), dict(c=(x + s * 0.215, 0, -0.08), rx=0.13, ry=0.16, p=2.0)], n=40, sub=2, up=(0, 0, 1), caps=False, name="ring")
    ring = lib.solidify(ring, 0.02, offset=0.0)
    lib.assign(ring, glow)
    # The yoke joining the cup to the band.
    yoke = lib.capsule((x + s * 0.10, 0, 0.20), arch[0 if s > 0 else -1], 0.045, name="yoke")
    lib.assign(yoke, shell)
    for ob in (cup, soft, ring, yoke):
        lib.shade_smooth(ob)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.75, 0.78, 0.84, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.55
for name, energy, loc, size in (("key", 900, (-2.2, -3.0, 3.2), 3.0), ("fill", 300, (3.0, -2.0, 1.0), 4.0), ("rim", 500, (0.5, 3.0, 2.5), 2.0)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy = energy
    ld.size = size
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    scene.collection.objects.link(lo)
    lo.rotation_euler = (Vector((0, 0, 0.1)) - lo.location).to_track_quat("-Z", "Y").to_euler()

cd = bpy.data.cameras.new("cam")
cd.type = "ORTHO"
cd.ortho_scale = 1.85
cam = bpy.data.objects.new("cam", cd)
scene.collection.objects.link(cam)
scene.camera = cam
yaw, pitch = math.radians(-24), math.radians(12)
target = Vector((0, 0, 0.22))
cam.location = target + Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch))) * 6
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.rotation_euler.rotate_axis("Z", math.radians(-8))

png = os.path.splitext(out)[0] + ".png"
scene.render.filepath = png
bpy.ops.render.render(write_still=True)

# 128 px WebP like the other act pictures, scaled down from the big render for clean edges.
img = bpy.data.images.load(png)
img.scale(128, 128)
img.filepath_raw = out
img.file_format = "WEBP"
scene.render.image_settings.file_format = "WEBP"
scene.render.image_settings.quality = 90
img.save_render(out, scene=scene)
print("WROTE", out)
