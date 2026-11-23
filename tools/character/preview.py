"""Pictures of the model while it is built: Workbench (fast, shapes) or EEVEE (colours), from several sides."""
import math
import os

import bpy
from mathutils import Vector


def setup(engine="WORKBENCH", size=(700, 900)):
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    if engine == "WORKBENCH":
        scene.render.engine = "BLENDER_WORKBENCH"
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL"
        sh.show_cavity = True
        sh.cavity_type = "WORLD"
        sh.show_object_outline = True
        sh.object_outline_color = (0.05, 0.05, 0.08)
        sh.background_type = "VIEWPORT"
        sh.background_color = (0.33, 0.34, 0.37)
        scene.display.render_aa = "8"
    else:
        scene.render.engine = "BLENDER_EEVEE"
        world = bpy.data.worlds.new("w") if not scene.world else scene.world
        scene.world = world
        world.use_nodes = True
        bg = world.node_tree.nodes.get("Background")
        bg.inputs[0].default_value = (0.42, 0.43, 0.47, 1)
        bg.inputs[1].default_value = 1.0
        if not any(o.type == "LIGHT" for o in scene.objects):
            for name, energy, rot in (("key", 4.0, (math.radians(50), 0, math.radians(-30))), ("fill", 1.4, (math.radians(70), 0, math.radians(140)))):
                ld = bpy.data.lights.new(name, "SUN")
                ld.energy = energy
                lo = bpy.data.objects.new(name, ld)
                lo.rotation_euler = rot
                scene.collection.objects.link(lo)
    cam = scene.camera
    if cam is None:
        cd = bpy.data.cameras.new("cam")
        cam = bpy.data.objects.new("cam", cd)
        scene.collection.objects.link(cam)
        scene.camera = cam
    return cam


def shoot(path, target=(0, 0, 0.9), distance=4.0, yaw=0.0, pitch=4.0, ortho=1.95, lens=None):
    """One picture: the camera `yaw` degrees round from the front (the character faces -Y), `pitch` up."""
    scene = bpy.context.scene
    cam = scene.camera
    if lens:
        cam.data.type = "PERSP"
        cam.data.lens = lens
    else:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    y, p = math.radians(yaw), math.radians(pitch)
    t = Vector(target)
    cam.location = t + Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p))) * distance
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.clip_end = 100
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def sheet(out_dir, name, views, **kw):
    os.makedirs(out_dir, exist_ok=True)
    for label, args in views.items():
        a = dict(kw)
        a.update(args)
        shoot(os.path.join(out_dir, f"{name}_{label}.png"), **a)
