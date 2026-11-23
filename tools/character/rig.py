"""The skeleton (VRM humanoid bone names) and how each mesh follows it: bone heat for the body, distances to bone
segments for hands and feet, one bone for rigid parts, chains for what swings (hair, scarf, sash ends)."""
import bpy
import numpy as np

import body
import head as headmod


def bone_layout():
    """name: (head, tail, parent, connected)."""
    B = {}
    ay, z = body.ARM_Y, body.SHOULDER_Z
    B["hips"] = ((0, 0.004, 0.94), (0, 0.004, 1.02), None, False)
    B["spine"] = ((0, 0.004, 1.02), (0, 0.0, 1.13), "hips", True)
    B["chest"] = ((0, 0.0, 1.13), (0, -0.004, 1.25), "spine", True)
    B["upperChest"] = ((0, -0.004, 1.25), (0, 0.004, 1.385), "chest", True)
    B["neck"] = ((0, 0.008, 1.395), (0, 0.006, 1.47), "upperChest", False)
    B["head"] = ((0, 0.006, 1.47), (0, 0.006, 1.65), "neck", True)
    for side, s in (("left", 1), ("right", -1)):
        B[f"{side}Shoulder"] = ((s * 0.022, 0.0, 1.372), (s * 0.150, ay, z + 0.002), "upperChest", False)
        B[f"{side}UpperArm"] = ((s * body.SHOULDER_X, ay, z), (s * body.ELBOW_X, ay + 0.002, z), f"{side}Shoulder", False)
        B[f"{side}LowerArm"] = ((s * body.ELBOW_X, ay + 0.002, z), (s * body.WRIST_X, ay, z), f"{side}UpperArm", True)
        B[f"{side}Hand"] = ((s * body.WRIST_X, ay, z - 0.002), (s * 0.790, 0.0, z - 0.001), f"{side}LowerArm", False)
        joints = body.finger_joints("L" if s > 0 else "R")
        for finger, (pts, _r0, _r1) in joints.items():
            names = ["Metacarpal", "Proximal", "Distal"] if finger == "Thumb" else ["Proximal", "Intermediate", "Distal"]
            parent = f"{side}Hand"
            for i, part in enumerate(names):
                name = f"{side}{finger}{part}"
                B[name] = (tuple(pts[i]), tuple(pts[i + 1]), parent, i > 0)
                parent = name
        lx = s * body.LEG_X
        B[f"{side}UpperLeg"] = ((s * body.HIP_X, 0.004, body.HIP_Z), (lx, -0.004, body.KNEE_Z), "hips", False)
        B[f"{side}LowerLeg"] = ((lx, -0.004, body.KNEE_Z), (lx, 0.012, body.ANKLE_Z), f"{side}UpperLeg", True)
        B[f"{side}Foot"] = ((lx, 0.012, body.ANKLE_Z), (s * (body.LEG_X + 0.003), -0.098, 0.025), f"{side}LowerLeg", True)
        B[f"{side}Toes"] = ((s * (body.LEG_X + 0.003), -0.098, 0.025), (s * (body.LEG_X + 0.003), -0.160, 0.022), f"{side}Foot", True)
    return B


def make_armature(layout, extra=None):
    """The armature from the layout; `extra` adds chains (name: (head, tail, parent))."""
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    allb = dict(layout)
    for name, (h, t, parent) in (extra or {}).items():
        allb[name] = (h, t, parent, False)
    for name, (h, t, _p, _c) in allb.items():
        b = eb.new(name)
        b.head = h
        b.tail = t
        b.roll = 0.0
    for name, (_h, _t, parent, connected) in allb.items():
        if parent:
            eb[name].parent = eb[parent]
            eb[name].use_connect = connected
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def bind(mesh, arm):
    """The mesh follows the armature: parented, with an armature modifier."""
    mesh.parent = arm
    mesh.matrix_parent_inverse = arm.matrix_world.inverted()
    if not any(m.type == "ARMATURE" for m in mesh.modifiers):
        mod = mesh.modifiers.new("Armature", "ARMATURE")
        mod.object = arm


def heat(mesh, arm):
    """Blender's bone heat weights (the mesh must be closed)."""
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    with bpy.context.temp_override(active_object=arm, selected_objects=[mesh, arm], selected_editable_objects=[mesh, arm], object=arm):
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    bind(mesh, arm)


def vertex_positions(mesh):
    co = np.empty(len(mesh.data.vertices) * 3)
    mesh.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mw = np.array(mesh.matrix_world)
    return co @ mw[:3, :3].T + mw[:3, 3]


def set_weights(mesh, names, W):
    """W: vertices × len(names); the heaviest four kept, normalised."""
    W = np.asarray(W, float)
    W[W < 1e-4] = 0
    if W.shape[1] > 4:
        idx = np.argsort(-W, axis=1)[:, 4:]
        np.put_along_axis(W, idx, 0.0, axis=1)
    s = W.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    W = W / s
    for g in list(mesh.vertex_groups):
        if g.name in names:
            mesh.vertex_groups.remove(g)
    groups = [mesh.vertex_groups.new(name=n) for n in names]
    for j, g in enumerate(groups):
        col = W[:, j]
        nz = np.nonzero(col)[0]
        for i in nz:
            g.add([int(i)], float(col[i]), "REPLACE")


def segment_weights(mesh, arm, names, power=6.0, falloff=None):
    """Weights by distance to each bone's segment: near a joint two bones share smoothly."""
    P = vertex_positions(mesh)
    bones = arm.data.bones
    W = np.zeros((len(P), len(names)))
    for j, n in enumerate(names):
        b = bones[n]
        a = np.array(arm.matrix_world @ b.head_local)
        c = np.array(arm.matrix_world @ b.tail_local)
        ab = c - a
        t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
        W[:, j] = 1.0 / (d + 0.004) ** power
    set_weights(mesh, names, W)
    bind(mesh, arm)


def rigid(mesh, arm, bone):
    set_weights(mesh, [bone], np.ones((len(mesh.data.vertices), 1)))
    bind(mesh, arm)


def chain_weights(mesh, arm, chain, parent, power=4.0):
    """Something hanging from `parent` along a chain of bones (a ponytail, a scarf tail)."""
    segment_weights(mesh, arm, [parent] + chain, power=power)


def hand_bones(side):
    out = [f"{side}LowerArm", f"{side}Hand"]
    for finger in ("Thumb", "Index", "Middle", "Ring", "Little"):
        parts = ["Metacarpal", "Proximal", "Distal"] if finger == "Thumb" else ["Proximal", "Intermediate", "Distal"]
        out += [f"{side}{finger}{p}" for p in parts]
    return out


def foot_bones(side):
    return [f"{side}LowerLeg", f"{side}Foot", f"{side}Toes"]


def weights_of(mesh):
    """Per vertex: {bone: weight}."""
    names = {g.index: g.name for g in mesh.vertex_groups}
    out = []
    for v in mesh.data.vertices:
        out.append({names[g.group]: g.weight for g in v.groups if g.weight > 1e-4 and g.group in names})
    return out


def transfer(dst, sources, arm, k=4):
    """Weights for `dst` from the nearest vertices of the bodies under it (clothes follow the body)."""
    from mathutils import Vector
    from mathutils.kdtree import KDTree

    pts, ws = [], []
    for s in sources:
        P = vertex_positions(s)
        W = weights_of(s)
        pts.extend(P)
        ws.extend(W)
    tree = KDTree(len(pts))
    for i, p in enumerate(pts):
        tree.insert(Vector(p), i)
    tree.balance()
    P = vertex_positions(dst)
    names = sorted({b for w in ws for b in w})
    col = {n: j for j, n in enumerate(names)}
    W = np.zeros((len(P), len(names)))
    for i, p in enumerate(P):
        found = tree.find_n(Vector(p), k)
        for _co, idx, dist in found:
            f = 1.0 / (dist + 0.003) ** 2
            for b, w in ws[idx].items():
                W[i, col[b]] += w * f
    set_weights(dst, names, W)
    bind(dst, arm)
