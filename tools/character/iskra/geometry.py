"""Editable, skinned mesh sections. All dimensions are metres, facing -Y."""
import math
from collections import defaultdict

import bpy
from mathutils import Vector

TAU = math.tau
MATERIALS = {}
SECTIONS = []


def linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def rgb(hex_color):
    return tuple(linear(int(hex_color[i:i + 2], 16) / 255) for i in (0, 2, 4))


def material(name, color, rough=.66, metal=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb(color), 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = m.diffuse_color
    shader.inputs["Roughness"].default_value = rough
    shader.inputs["Metallic"].default_value = metal
    MATERIALS[name] = m
    return m


class Section:
    def __init__(self, name, bone):
        self.name, self.bone = name, bone
        self.verts, self.faces, self.indices, self.materials = [], [], [], []
        self.weights = []
        self.keys = defaultdict(dict)
        self.uv = {}
        SECTIONS.append(self)

    def vert(self, p, weights=None):
        self.verts.append(Vector(p))
        self.weights.append(weights or self.bone)
        return len(self.verts) - 1

    def face(self, ids, mat):
        if mat not in self.materials:
            self.materials.append(mat)
        self.faces.append(ids)
        self.indices.append(self.materials.index(mat))

    def finish(self, arm):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for name in self.materials:
            mesh.materials.append(MATERIALS[name])
        for poly, index in zip(mesh.polygons, self.indices):
            poly.material_index = index
            poly.use_smooth = True
        if self.uv:
            layer = mesh.uv_layers.new(name="Coat pattern")
            for poly in mesh.polygons:
                uvs = [self.uv.get(i, (0, 0)) for i in poly.vertices]
                seam = max(u for u, _ in uvs) - min(u for u, _ in uvs) > .5
                for j, (u, v) in zip(poly.loop_indices, uvs):
                    layer.data[j].uv = (u + int(seam and u < .5), v)
        groups = {}
        for i, weight in enumerate(self.weights):
            parts = {weight: 1.0} if isinstance(weight, str) else weight
            for bone, amount in parts.items():
                if amount <= 0:
                    continue
                if bone not in groups:
                    groups[bone] = obj.vertex_groups.new(name=bone)
                groups[bone].add([i], amount, 'REPLACE')
        if self.keys:
            obj.shape_key_add(name="Basis")
            for name, changes in self.keys.items():
                key = obj.shape_key_add(name=name)
                for i, value in changes.items():
                    key.data[i].co = value
                key.value = 0
        obj.parent = arm
        obj.modifiers.new("Articulation", 'ARMATURE').object = arm
        return obj


def rings(section, rows, mat, weights=None):
    """Closed hull. Rows are counterclockwise when viewed from the last end."""
    ids = []
    for i, row in enumerate(rows):
        w = weights[i] if isinstance(weights, list) else weights
        ids.append([section.vert(p, w) for p in row])
    n = len(ids[0])
    for i, (a, b) in enumerate(zip(ids, ids[1:])):
        color = mat[i] if isinstance(mat, list) else mat
        for j in range(n):
            k = (j + 1) % n
            section.face((a[j], a[k], b[k], b[j]), color)
    section.face(tuple(reversed(ids[0])), mat[0] if isinstance(mat, list) else mat)
    section.face(tuple(ids[-1]), mat[-1] if isinstance(mat, list) else mat)
    return ids


def smooth(points, steps=4):
    """Catmull-Rom interpolation through the supplied cross sections."""
    seq = [tuple(p) for p in points]
    out = []
    for i, (b, c) in enumerate(zip(seq, seq[1:])):
        a, d = seq[max(0, i - 1)], seq[min(len(seq) - 1, i + 2)]
        for j in range(steps):
            t = j / steps
            out.append(tuple(.5 * (2*v + (-u+w)*t + (2*u-5*v+4*w-x)*t*t + (-u+3*v-3*w+x)*t**3)
                             for u, v, w, x in zip(a, b, c, d)))
    return out + [seq[-1]]


def loft(s, specs, mat, n=36, steps=3, weights=None, square=1):
    rows = []
    specs = smooth(specs, steps)
    for x, y, z, rx, ry in specs:
        row = []
        for j in range(n):
            a = TAU*j/n
            sn, cs = math.sin(a), math.cos(a)
            row.append((x + rx*math.copysign(abs(sn)**square, sn), y - ry*math.copysign(abs(cs)**square, cs), z))
        rows.append(row)
    return rings(s, rows, mat, [weights(p) for p in specs] if callable(weights) else weights)


def sweep(s, specs, mat, n=16, steps=3, weights=None, axis=(0, -1, 0)):
    """Tube with elliptical sections; axes follow the tangent without twisting."""
    specs = smooth(specs, steps)
    centers = [Vector(p[:3]) for p in specs]
    rows = []
    for i, (_, _, _, rx, ry) in enumerate(specs):
        tangent = (centers[min(len(centers)-1, i+1)] - centers[max(0, i-1)]).normalized()
        u = Vector(axis)
        if abs(u.dot(tangent)) > .96:
            u = Vector((1, 0, 0)) if abs(tangent.x) < .9 else Vector((0, 0, 1))
        u = (u - tangent*u.dot(tangent)).normalized()
        v = tangent.cross(u)
        rows.append([centers[i] + u*(rx*math.cos(TAU*j/n)) + v*(ry*math.sin(TAU*j/n)) for j in range(n)])
    colors = [mat(i/(len(rows)-1)) for i in range(len(rows)-1)] if callable(mat) else mat
    ws = [weights(i/(len(rows)-1)) for i in range(len(rows))] if callable(weights) else weights
    return rings(s, rows, colors, ws)


def cord(s, points, radius, mat, n=8, steps=4, weights=None, axis=(0, -1, 0)):
    return sweep(s, [(*p, radius, radius) for p in points], mat, n, steps, weights, axis)


def ball(s, center, size, mat, weights=None, n=24, stacks=14, tilt=0):
    x, y, z = center
    rx, ry, rz = size
    rows = []
    for i in range(stacks+1):
        a = -math.pi/2 + .004 + (math.pi-.008)*i/stacks
        row = []
        for j in range(n):
            b = TAU*j/n
            dx, dz = rx*math.cos(a)*math.sin(b), rz*math.sin(a)
            row.append((x+dx*math.cos(tilt)-dz*math.sin(tilt), y-ry*math.cos(a)*math.cos(b), z+dx*math.sin(tilt)+dz*math.cos(tilt)))
        rows.append(row)
    return rings(s, rows, mat, weights)


def badge(s, xz, y, mat, depth=.004, weight=None, rounds=2):
    """Rounded silhouette with a raised, convex front and a closed back."""
    pts = list(xz)
    for _ in range(rounds):
        pts = [((1-k)*a[0]+k*b[0], (1-k)*a[1]+k*b[1]) for a, b in zip(pts, pts[1:]+pts[:1]) for k in (.24, .76)]
    if sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(pts, pts[1:]+pts[:1])) < 0:
        pts.reverse()
    cx = sum(p[0] for p in pts)/len(pts)
    cz = sum(p[1] for p in pts)/len(pts)
    fn = y if callable(y) else lambda x,z: y
    rows = []
    for scale, d in ((.93,-depth*.6),(1,0),(.97,depth*.42),(.76,depth*.88),(.40,depth),(.03,depth)):
        row = []
        for x,z in pts:
            xx, zz = cx+(x-cx)*scale, cz+(z-cz)*scale
            row.append((xx,fn(xx,zz)-d,zz))
        rows.append(row)
    return rings(s, rows, mat, weight)


def blend(a, b, k):
    k = max(0, min(1, k))
    return {a: 1-k, b: k}
