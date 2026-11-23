"""Geometry helpers for building a character in Blender from code: lofts along paths, fusing pieces by voxels,
smoothing, decals that lie on a surface, materials. Run inside Blender (bpy, bmesh, mathutils, numpy are there).

Coordinates are Blender's: Z up, the character faces -Y, its left side is +X. Metres.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


# ---------------------------------------------------------------- scene

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.curves):
        for item in list(block):
            block.remove(item)


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_object(name, verts, faces, uvs=None):
    """An object from vertices (N×3) and faces (lists of indices); `uvs` per loop, in face order, if given."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [list(map(int, f)) for f in faces])
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", np.asarray(uvs, dtype=np.float32).ravel())
    me.validate(clean_customdata=False)
    me.update()
    return link(bpy.data.objects.new(name, me))


def object_arrays(ob):
    """Vertices (world) and faces of an object's mesh as it is."""
    me = ob.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mw = np.array(ob.matrix_world)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    faces = [list(p.vertices) for p in me.polygons]
    return co, faces


def apply_modifiers(ob):
    """Bakes an object's modifiers into its mesh (no operator needed)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    me.validate(clean_customdata=False)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    return ob


def remesh(ob, voxel, smooth_iter=0, smooth_factor=0.5, adaptivity=0.0):
    m = ob.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = adaptivity
    m.use_smooth_shade = True
    if smooth_iter:
        s = ob.modifiers.new("smooth", "SMOOTH")
        s.factor = smooth_factor
        s.iterations = smooth_iter
    return apply_modifiers(ob)


def smooth(ob, iterations=4, factor=0.5, laplacian=False, vgroup=None):
    if laplacian:
        s = ob.modifiers.new("lsmooth", "LAPLACIANSMOOTH")
        s.iterations = iterations
        s.lambda_factor = factor
        s.use_volume_preserve = True
    else:
        s = ob.modifiers.new("smooth", "SMOOTH")
        s.factor = factor
        s.iterations = iterations
    if vgroup:
        s.vertex_group = vgroup
    return apply_modifiers(ob)


def decimate(ob, ratio):
    m = ob.modifiers.new("decimate", "DECIMATE")
    m.ratio = ratio
    m.use_collapse_triangulate = True
    return apply_modifiers(ob)


def subdivide(ob, levels=1):
    m = ob.modifiers.new("subsurf", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    return apply_modifiers(ob)


def solidify(ob, thickness, offset=-1.0):
    m = ob.modifiers.new("solidify", "SOLIDIFY")
    m.thickness = thickness
    m.offset = offset
    m.use_even_offset = True
    return recalc_normals(apply_modifiers(ob))


def shade_smooth(ob):
    me = ob.data
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()


def join(objects, name):
    """One object from several (their world transforms baked in); materials and UVs kept."""
    objects = [o for o in objects if o is not None]
    bm = bmesh.new()
    mats = []
    for ob in objects:
        me = ob.data.copy()
        me.transform(ob.matrix_world)
        # Material slots of the joined object: the union, faces remapped.
        remap = []
        for slot in ob.material_slots:
            if slot.material not in mats:
                mats.append(slot.material)
            remap.append(mats.index(slot.material))
        for p in me.polygons:
            p.material_index = remap[p.material_index] if remap else 0
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    for ob in objects:
        bpy.data.objects.remove(ob)
    return link(bpy.data.objects.new(name, me))


def delete_faces(ob, predicate):
    """Removes the faces whose centre (world) makes `predicate(center, normal)` true."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    gone = [f for f in bm.faces if predicate(np.array(f.calc_center_median()), np.array(f.normal))]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


# ---------------------------------------------------------------- lofts

def superellipse(n, rx, ry, p=2.0, bulge=None):
    """A closed ring of n points in 2D: a superellipse (p=2 an ellipse, bigger p a rounder box). `bulge(theta)` scales
    the radius by angle (theta 0 = +u, pi/2 = +v)."""
    t = np.linspace(0.0, 2.0 * math.pi, n, endpoint=False)
    c, s = np.cos(t), np.sin(t)
    e = 2.0 / p
    x = rx * np.sign(c) * np.abs(c) ** e
    y = ry * np.sign(s) * np.abs(s) ** e
    if bulge is not None:
        k = np.array([bulge(a) for a in t])
        x, y = x * k, y * k
    return np.stack([x, y], axis=1)


def catmull(points, sub):
    """A Catmull-Rom pass through key values (K×D), `sub` steps between keys, ends included."""
    P = np.asarray(points, dtype=np.float64)
    if len(P) < 2 or sub <= 1:
        return P
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1])
    return np.array(out)


def frames(path, up):
    """Per point of a path: (tangent, u, v) — u as close to `up` as it can be, kept from turning between points."""
    path = np.asarray(path, dtype=np.float64)
    tang = np.gradient(path, axis=0)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True) + 1e-12
    out = []
    u_prev = None
    for i, t in enumerate(tang):
        ref = np.asarray(up if u_prev is None else u_prev, dtype=np.float64)
        u = ref - np.dot(ref, t) * t
        if np.linalg.norm(u) < 1e-6:
            u = np.cross(t, [1, 0, 0]) if abs(t[0]) < 0.9 else np.cross(t, [0, 1, 0])
        u /= np.linalg.norm(u)
        v = np.cross(t, u)
        out.append((t, u, v))
        u_prev = u
    return out


def loft(keys, n=32, sub=4, up=(0, 0, 1), caps=True, name="loft", uv=False):
    """A tube through key sections. Each key: dict(c=centre xyz, rx, ry, p=2, off=(du, dv) shift in the ring's plane,
    rot=angle of the ring in its plane). Values between keys are Catmull-Rom smooth. The ring's u axis follows `up`."""
    C = catmull([k["c"] for k in keys], sub)
    params = catmull([[k["rx"], k["ry"], k.get("p", 2.0), *k.get("off", (0.0, 0.0)), k.get("rot", 0.0), k.get("tw", 0.0)] for k in keys], sub)
    bulges = [k.get("bulge") for k in keys]
    F = frames(C, up)
    rings = []
    m = len(C)
    for i in range(m):
        rx, ry, p, du, dv, rot, tw = params[i]
        # A bulge belongs to the nearest key.
        key_i = min(len(keys) - 1, int(round(i / max(1, sub))))
        ring = superellipse(n, max(rx, 1e-5), max(ry, 1e-5), max(p, 0.5), bulges[key_i])
        if rot:
            cr, sr = math.cos(rot), math.sin(rot)
            ring = ring @ np.array([[cr, sr], [-sr, cr]])
        ring = ring + np.array([du, dv])
        t, u, v = F[i]
        rings.append(C[i] + ring[:, :1] * u + ring[:, 1:2] * v)
    verts = np.vstack(rings)
    faces = []
    for i in range(m - 1):
        a, b = i * n, (i + 1) * n
        for j in range(n):
            j2 = (j + 1) % n
            faces.append([a + j, a + j2, b + j2, b + j])
    uvs = None
    if uv:
        uvs = []
        for i in range(m - 1):
            for j in range(n):
                j2 = j + 1
                uvs += [(j / n, i / (m - 1)), (j2 / n, i / (m - 1)), (j2 / n, (i + 1) / (m - 1)), (j / n, (i + 1) / (m - 1))]
    if caps:
        faces.append(list(range(n - 1, -1, -1)))
        faces.append([(m - 1) * n + j for j in range(n)])
        if uvs is not None:
            uvs += [(0.5, 0.0)] * n + [(0.5, 1.0)] * n
    ob = mesh_object(name, verts, faces, uvs)
    if caps:
        recalc_normals(ob)
    return ob


def ribbon(path, widths, thickness, normal_hint, name="ribbon", sub=4, uv=True, twist=None):
    """A flat strip with some thickness along a path (a scarf tail, a sash end, a collar): `widths` per key, the flat side
    facing `normal_hint`. UV u across, v along."""
    C = catmull(path, sub)
    W = catmull([[w] for w in widths], sub)[:, 0]
    T = catmull([[t] for t in (thickness if isinstance(thickness, (list, tuple)) else [thickness] * len(path))], sub)[:, 0]
    TW = catmull([[t] for t in (twist or [0.0] * len(path))], sub)[:, 0]
    F = frames(C, normal_hint)
    verts, faces, uvs = [], [], []
    m = len(C)
    # Four corners per section: a thin box.
    for i in range(m):
        t, nrm, side = F[i]
        if TW[i]:
            ca, sa = math.cos(TW[i]), math.sin(TW[i])
            nrm, side = nrm * ca + side * sa, side * ca - nrm * sa
        w, h = W[i] / 2, T[i] / 2
        for a, b in ((-w, -h), (w, -h), (w, h), (-w, h)):
            verts.append(C[i] + side * a + nrm * b)
    for i in range(m - 1):
        for j in range(4):
            j2 = (j + 1) % 4
            faces.append([i * 4 + j, i * 4 + j2, (i + 1) * 4 + j2, (i + 1) * 4 + j])
            u0, u1 = j / 4, (j + 1) / 4
            uvs += [(u0, i / (m - 1)), (u1, i / (m - 1)), (u1, (i + 1) / (m - 1)), (u0, (i + 1) / (m - 1))]
    faces.append([3, 2, 1, 0])
    uvs += [(0, 0), (1, 0), (1, 0.01), (0, 0.01)]
    e = (m - 1) * 4
    faces.append([e, e + 1, e + 2, e + 3])
    uvs += [(0, 1), (1, 1), (1, 0.99), (0, 0.99)]
    return recalc_normals(mesh_object(name, np.array(verts), faces, uvs if uv else None))


def ellipsoid(center, radii, name="ellipsoid", n=24, rot=None):
    u = np.linspace(0, math.pi, n // 2 + 1)
    v = np.linspace(0, 2 * math.pi, n, endpoint=False)
    verts, faces = [], []
    for i, a in enumerate(u):
        for j, b in enumerate(v):
            verts.append((math.sin(a) * math.cos(b), math.sin(a) * math.sin(b), math.cos(a)))
    verts = np.array(verts) * np.asarray(radii)
    if rot is not None:
        verts = verts @ np.asarray(rot).T
    verts += np.asarray(center)
    rows = n // 2 + 1
    for i in range(rows - 1):
        for j in range(n):
            j2 = (j + 1) % n
            faces.append([i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j])
    ob = mesh_object(name, verts, faces)
    # Weld the poles.
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def capsule(a, b, ra, rb=None, name="capsule", n=20):
    """A tapered capsule from a to b (a loft with round ends)."""
    rb = ra if rb is None else rb
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    L = np.linalg.norm(d)
    t = d / L
    keys = []
    for k in np.linspace(-1, 1, 7):
        # Rounded end at a.
        pass
    pts = []
    for ang in np.linspace(-math.pi / 2, 0, 5):
        pts.append((a + t * (ra * math.sin(ang)), ra * math.cos(ang) + 1e-4))
    for ang in np.linspace(0, math.pi / 2, 5):
        pts.append((b + t * (rb * math.sin(ang)), rb * math.cos(ang) + 1e-4))
    keys = [dict(c=p, rx=r, ry=r) for p, r in pts]
    up = (0, 0, 1) if abs(t[2]) < 0.9 else (1, 0, 0)
    return loft(keys, n=n, sub=1, up=up, name=name)


# ---------------------------------------------------------------- decals on a surface

class Surface:
    """Rays onto an object's mesh, to put decals (eyes, mouth, brows) on it."""

    def __init__(self, ob):
        co, faces = object_arrays(ob)
        self.tree = BVHTree.FromPolygons([tuple(v) for v in co], faces)

    def project(self, point, direction, offset):
        """Where a ray from `point` along `direction` meets the surface, pushed `offset` out along the normal."""
        o = Vector(point) - Vector(direction) * 0.3
        hit, normal, _i, _d = self.tree.ray_cast(o, Vector(direction), 1.0)
        if hit is None:
            hit, normal, _i, _d = self.tree.find_nearest(Vector(point))
        n = normal.normalized()
        if n.dot(Vector(direction)) > 0:
            n = -n
        return np.array(hit + n * offset), np.array(n)


def grid_in_polygon(outline, step):
    """Inside points of a 2D polygon on a grid, for a decal mesh that bends well over a curved face."""
    outline = np.asarray(outline)
    lo, hi = outline.min(axis=0), outline.max(axis=0)
    pts = []
    for x in np.arange(lo[0] + step / 2, hi[0], step):
        for y in np.arange(lo[1] + step / 2, hi[1], step):
            if point_in_poly((x, y), outline) and min_dist_to_poly((x, y), outline) > step * 0.45:
                pts.append((x, y))
    return np.array(pts).reshape(-1, 2)


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def min_dist_to_poly(p, poly):
    p = np.asarray(p)
    best = 1e9
    n = len(poly)
    for i in range(n):
        a, b = np.asarray(poly[i]), np.asarray(poly[(i + 1) % n])
        ab = b - a
        t = np.clip(np.dot(p - a, ab) / (np.dot(ab, ab) + 1e-12), 0, 1)
        best = min(best, np.linalg.norm(a + t * ab - p))
    return best


def fan_mesh_2d(outline, rings=3):
    """A disc-like mesh for a closed outline of N points: `rings` inner copies shrunk toward the centre and a centre
    point. Same topology for any outline of N points, so outlines can be blended as shape keys."""
    outline = np.asarray(outline, dtype=np.float64)
    n = len(outline)
    c = outline.mean(axis=0)
    verts = []
    for r in range(rings + 1):
        k = 1.0 - r / (rings + 1)
        verts.extend(c + (outline - c) * k)
    verts.append(c)
    faces = []
    for r in range(rings):
        a, b = r * n, (r + 1) * n
        for j in range(n):
            j2 = (j + 1) % n
            faces.append([a + j, a + j2, b + j2, b + j])
    last = rings * n
    centre = len(verts) - 1
    for j in range(n):
        faces.append([last + j, last + (j + 1) % n, centre])
    return np.array(verts), faces


def ring_points(outline, rings=3):
    """The 2D vertex positions `fan_mesh_2d` would make for this outline (for shape keys)."""
    v, _ = fan_mesh_2d(outline, rings)
    return v


def place_on(surface, pts2d, frame_origin, frame_u, frame_v, direction, offset):
    """2D points of a decal (in a frame on the face) put onto the surface."""
    o, u, v = map(np.asarray, (frame_origin, frame_u, frame_v))
    out = []
    for x, y in pts2d:
        p, _n = surface.project(o + u * x + v * y, direction, offset)
        out.append(p)
    return np.array(out)


# ---------------------------------------------------------------- materials

def linear(c):
    """sRGB 0–1 to linear (glTF colour factors are linear)."""
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def material(name, color, shade=None, rough=0.8, metal=0.0, image=None, alpha=None, outline=0.0, rim=0.0, emission=None, toony=0.9, shift=-0.05):
    """A glTF material (Principled BSDF, colour or picture). The MToon look (shade colour, outline) rides along as
    custom properties for the VRM step."""
    # Colours are given in sRGB, as on a screen; with a picture the factor is white.
    shade = linear(shade if shade is not None else [c * 0.62 for c in color[:3]])
    color = (1.0, 1.0, 1.0) if image is not None else tuple(linear(color[:3]))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color[:3], 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha == "BLEND" or alpha == "MASK":
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    if alpha:
        mat.blend_method = "BLEND" if alpha == "BLEND" else "CLIP" if alpha == "MASK" else "OPAQUE"
    mat.diffuse_color = (*color[:3], 1.0)
    mat["hv_shade"] = [float(x) for x in shade]
    mat["hv_outline"] = float(outline)
    mat["hv_rim"] = float(rim)
    mat["hv_toony"] = float(toony)
    mat["hv_shift"] = float(shift)
    mat["hv_alpha"] = alpha or "OPAQUE"
    if emission:
        mat["hv_emission"] = list(emission)
    return mat


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return ob


def image_from_array(name, rgba):
    """A packed picture from an H×W×4 float array (0–1), row 0 at the top."""
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    flipped = np.ascontiguousarray(rgba[::-1].astype(np.float32))
    img.pixels.foreach_set(flipped.ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def recalc_normals(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob
