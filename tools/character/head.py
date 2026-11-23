"""The head: a skull lofted from slices, a small nose, ears, eye sockets cut in the face; and the face parts — whites,
irises, lids, lashes, brows, mouth, teeth, tongue — as one mesh with shape keys for every expression, mouth shape and
gaze. Everything an expression moves is a shape key of the same name (VRM expressions bind them by name)."""
import math

import bpy
import numpy as np

import lib

CHIN_Z = 1.450
HEAD_TOP = CHIN_Z + 0.2435
EYE_X = 0.0395
EYE_Z = CHIN_Z + 0.105
MOUTH_Z = CHIN_Z + 0.040


def skull():
    # z above the chin, centre y, half width, back depth, front depth, back and front roundness.
    rows = [
        (0.000, -0.0595, 0.010, 0.008, 0.006, 2.0, 2.0),
        (0.008, -0.0565, 0.026, 0.018, 0.011, 2.0, 2.2),
        (0.020, -0.0495, 0.043, 0.032, 0.017, 2.0, 2.3),
        (0.036, -0.0405, 0.059, 0.050, 0.025, 2.1, 2.4),
        (0.054, -0.0310, 0.071, 0.066, 0.035, 2.2, 2.4),
        (0.074, -0.0210, 0.081, 0.080, 0.047, 2.25, 2.4),
        (0.095, -0.0130, 0.0885, 0.092, 0.058, 2.3, 2.4),
        (0.116, -0.0080, 0.0925, 0.099, 0.066, 2.3, 2.35),
        (0.138, -0.0050, 0.0950, 0.104, 0.071, 2.3, 2.3),
        (0.162, -0.0030, 0.0955, 0.107, 0.074, 2.2, 2.2),
        (0.186, -0.0010, 0.0930, 0.106, 0.073, 2.2, 2.2),
        (0.206, 0.0010, 0.0860, 0.100, 0.067, 2.1, 2.1),
        (0.222, 0.0030, 0.0720, 0.088, 0.056, 2.05, 2.05),
        (0.234, 0.0050, 0.0500, 0.065, 0.040, 2.0, 2.0),
        (0.241, 0.0050, 0.0220, 0.030, 0.018, 2.0, 2.0),
        (0.2435, 0.0050, 0.0040, 0.005, 0.004, 2.0, 2.0),
    ]
    n = 40
    R = lib.catmull(rows, 2)
    rings = []
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    for z, yc, rx, rb, rf, pb, pf in R:
        c, s = np.cos(t), np.sin(t)
        ring = []
        for ci, si in zip(c, s):
            front = si < 0
            ry, p = (rf, pf) if front else (rb, pb)
            e = 2.0 / p
            x = rx * math.copysign(abs(ci) ** e, ci)
            y = ry * math.copysign(abs(si) ** e, si)
            ring.append((x, yc + y, CHIN_Z + z))
        rings.append(ring)
    verts = np.array(rings).reshape(-1, 3)
    m = len(R)
    faces = []
    for i in range(m - 1):
        for j in range(n):
            j2 = (j + 1) % n
            faces.append([i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j])
    faces.append(list(range(n - 1, -1, -1)))
    faces.append([(m - 1) * n + j for j in range(n)])
    # A small nose and soft cheeks.
    nose = np.array([0.0, -0.076, CHIN_Z + 0.067])
    for i, v in enumerate(verts):
        if v[1] < -0.03:
            d = v - nose
            g = math.exp(-(d[0] ** 2 / 0.0048 ** 2 + d[2] ** 2 / 0.0085 ** 2))
            verts[i, 1] -= 0.0055 * g
            # The bridge above the tip, very faint.
            g2 = math.exp(-(d[0] ** 2 / 0.006 ** 2 + (d[2] - 0.016) ** 2 / 0.014 ** 2))
            verts[i, 1] -= 0.0012 * g2
    ob = lib.mesh_object("head", verts, faces)
    ob = lib.subdivide(ob, 1)
    lib.shade_smooth(ob)
    return ob


def ears():
    out = []
    for s in (1, -1):
        e = lib.ellipsoid((s * 0.0905, 0.016, CHIN_Z + 0.110), (0.0075, 0.016, 0.026), name="ear", n=20, rot=lib.rot_x(math.radians(-12)) @ lib.rot_z(math.radians(s * 14)))
        out.append(e)
    ob = lib.join(out, "ears")
    lib.recalc_normals(ob)
    ob = lib.subdivide(ob, 1)
    lib.shade_smooth(ob)
    return ob


# ---------------------------------------------------------------- the eye's shapes (local 2D: u to the outer corner, v up)

EYE_KEYS = [
    (-0.0185, -0.0015),
    (-0.0150, 0.0050), (-0.0090, 0.0098), (-0.0020, 0.0121), (0.0060, 0.0117), (0.0130, 0.0090), (0.0186, 0.0046),
    (0.0217, 0.0014),
    (0.0182, -0.0040), (0.0112, -0.0083), (0.0030, -0.0098), (-0.0060, -0.0089), (-0.0132, -0.0060),
]
UPPER = slice(0, 8)  # inner corner .. outer corner along the top


def closed_loop(keys, per=6):
    k = np.array(keys + keys[:3])
    pts = lib.catmull(k, per)
    n = len(keys) * per
    return pts[:n]


EYE_SCALE = 1.15


def eye_outline(n_per=6):
    return closed_loop([(u * EYE_SCALE, v * EYE_SCALE) for u, v in EYE_KEYS], n_per)


def lid_curves(m=24):
    """The top and the bottom lid lines from the inner to the outer corner, m points each."""
    loop = eye_outline(8)
    inner = int(np.argmin(loop[:, 0]))
    outer = int(np.argmax(loop[:, 0]))
    seq = np.roll(loop, -inner, axis=0)
    o = (outer - inner) % len(loop)
    top = seq[: o + 1]
    bottom = np.vstack([seq[o:], seq[:1]])[::-1]
    us = np.linspace(top[0, 0], top[-1, 0], m)
    top_v = np.interp(us, top[:, 0], top[:, 1])
    bot_v = np.interp(us, bottom[:, 0], bottom[:, 1])
    return us, top_v, bot_v


class FaceParts:
    """Parts gathered with their rest shape and their shapes per key name, made into one mesh at the end."""

    def __init__(self):
        self.parts = []

    def add(self, name, verts, faces, uvs, mat, morphs=None, flip=False):
        if flip:
            faces = [list(reversed(f)) for f in faces]
        self.parts.append(dict(name=name, v=np.asarray(verts, float), f=faces, uv=np.asarray(uvs, float), mat=mat, morphs=morphs or {}))

    def build(self, name, materials):
        verts, faces, uvs, mats = [], [], [], []
        names = sorted({k for p in self.parts for k in p["morphs"]})
        keys = {k: [] for k in names}
        base = 0
        for p in self.parts:
            verts.append(p["v"])
            for f in p["f"]:
                faces.append([base + i for i in f])
                uvs.append([p["uv"][i] for i in f])
                mats.append(materials.index(p["mat"]))
            for k in names:
                keys[k].append(p["morphs"].get(k, p["v"]))
            base += len(p["v"])
        V = np.vstack(verts)
        loop_uv = [uv for face in uvs for uv in face]
        ob = lib.mesh_object(name, V, faces, loop_uv)
        for m in materials:
            ob.data.materials.append(m)
        ob.data.polygons.foreach_set("material_index", mats)
        ob.shape_key_add(name="Basis", from_mix=False)
        for k in names:
            sk = ob.shape_key_add(name=k, from_mix=False)
            sk.data.foreach_set("co", np.vstack(keys[k]).astype(np.float32).ravel())
        lib.shade_smooth(ob)
        ob.data.update()
        return ob


def frame_at(surface, x, z):
    """A frame on the face at (x, ·, z): its point, outward normal, u (toward +x along the face), v (up)."""
    p, n = surface.project((x, -0.2, z), (0, 1, 0), 0.0)
    n = -np.asarray(n) if np.asarray(n)[1] > 0 else np.asarray(n)
    n = n / np.linalg.norm(n)
    u = np.array([1.0, 0, 0]) - np.dot([1.0, 0, 0], n) * n
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    if v[2] < 0:
        v = -v
    return np.asarray(p), n, u, v


def strip(us, vt, vb):
    """A strip between a top and a bottom line over the same u's: vertices (2m) and quads."""
    m = len(us)
    verts = [(u, t) for u, t in zip(us, vt)] + [(u, b) for u, b in zip(us, vb)]
    faces = [[i, i + 1, m + i + 1, m + i] for i in range(m - 1)]
    return np.array(verts), faces


def build_face(head, mats):
    """Cuts the eye sockets into `head` and returns the face parts mesh."""
    surf = lib.Surface(head)
    parts = FaceParts()
    cutters = []
    for side, s in (("L", 1), ("R", -1)):
        O, N, U, V = frame_at(surf, s * EYE_X, EYE_Z)
        # u points to the outer corner: +x on the left eye, -x on the right one.
        if s < 0:
            U = -U

        def put(pts2d, offset, O=O, U=U, V=V, N=N):
            return lib.place_on(surf, pts2d, O, U, V, -N, offset)

        outline = eye_outline(6)
        # The socket: a prism through the face along the outline.
        top = put(outline, 0.0) + N * 0.006
        bot = put(outline, 0.0) - N * 0.0026
        k = len(outline)
        pv = np.vstack([top, bot])
        pf = [[(i + 1) % k, i, k + i, k + (i + 1) % k] for i in range(k)]
        pf.append(list(range(k)))
        pf.append([k + i for i in range(k - 1, -1, -1)])
        cutters.append(lib.recalc_normals(lib.mesh_object("cut" + side, pv, pf)))

        # The white: a patch a little bigger than the socket, behind the face.
        c = outline.mean(axis=0)
        white_out = c + (outline - c) * 1.18
        wv2, wf = lib.fan_mesh_2d(white_out, rings=4)
        wuv = (wv2 - white_out.min(axis=0)) / (white_out.max(axis=0) - white_out.min(axis=0))
        parts.add("white" + side, put(wv2, -0.0016), wf, wuv, mats["white"], flip=s < 0)

        # The iris: a disc in front of the white; its gaze shapes slide it along the white.
        ic = np.array([0.0012, 0.0008]) * EYE_SCALE
        irx, iry = 0.0094 * EYE_SCALE, 0.0123 * EYE_SCALE
        ring = np.array([(ic[0] + irx * math.cos(a), ic[1] + iry * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 40, endpoint=False)])
        iv2, iface = lib.fan_mesh_2d(ring, rings=4)
        iuv = (iv2 - (ic - [irx, iry])) / np.array([2 * irx, 2 * iry])
        iris_morphs = {}
        # Gaze: the iris moves inward or outward on screen; "lookLeft" is toward the character's left (+x).
        for name, du, dv in (("lookUp", 0.0, 0.0042), ("lookDown", 0.0, -0.0038), ("lookLeft", 0.0072 * s, 0.0), ("lookRight", -0.0072 * s, 0.0)):
            iris_morphs[name] = put(iv2 + [du, dv], -0.0012)
        iris_morphs["surprised"] = put(ic + (iv2 - ic) * 0.84, -0.0012)
        parts.add("iris" + side, put(iv2, -0.0012), iface, iuv, mats["iris"], iris_morphs, flip=s < 0)

        # The lid: skin inside the socket, folded up under the top line until the eye closes.
        us, vt, vb = lid_curves(24)
        margin = 0.0012
        closed = vb + 0.0004
        lid_rest_b = vt + 0.0003
        lv2, lf = strip(us, vt + margin, lid_rest_b)
        luv = np.zeros((len(lv2), 2))

        def lid_with(bottom):
            v2, _ = strip(us, vt + margin, bottom)
            return put(v2, -0.0007)

        x = (us - us[0]) / (us[-1] - us[0])
        lid_morphs = {
            f"blink_{side}": lid_with(vb - margin),
            "happy": lid_with(vb - margin),
            "relaxed": lid_with(vt + (vb - vt) * 0.42),
            "angry": lid_with(vt - (0.0062 * (1 - x) + 0.0018 * x)),
            "sad": lid_with(vt - (0.0016 * (1 - x) + 0.0052 * x)),
        }
        parts.add("lid" + side, put(lv2, -0.0007), lf, luv, mats["skin"], lid_morphs, flip=s < 0)

        # The upper lash: a band over the top line, thicker toward the outer corner, ending in a small wing.
        thick = 0.0010 + 0.0028 * np.clip((x - 0.05) / 0.75, 0, 1) ** 0.8
        thick[-3:] = [0.0036, 0.0033, 0.0030]
        ul_us = np.concatenate([us, [us[-1] + 0.0028, us[-1] + 0.0048]])
        ul_lo = np.concatenate([vt - 0.0006, [vt[-1] + 0.0010, vt[-1] + 0.0024]])
        ul_hi = np.concatenate([vt + thick, [vt[-1] + 0.0030, vt[-1] + 0.0026]])

        def lash_with(lo, hi):
            v2, _ = strip(ul_us, hi, lo)
            return put(v2, 0.0005)

        ulv2, ulf = strip(ul_us, ul_hi, ul_lo)
        uluv = np.zeros((len(ulv2), 2))
        # Closed: the lash lies along a low curve; happy: an arc that bends up.
        closed_line = closed - 0.0002
        arc = (vt[0] + (vt[-1] - vt[0]) * x) * 0.0 + 0.0052 * np.sin(np.pi * np.clip(x * 1.02, 0, 1)) - 0.0015
        rel_line = vt + (vb - vt) * 0.42

        def lash_line(line, lift=0.0):
            lo = np.concatenate([line - 0.0006 + lift, [line[-1] + 0.0004 + lift, line[-1] + 0.0012 + lift]])
            hi = np.concatenate([line + thick * 0.9 + lift, [line[-1] + 0.0022 + lift, line[-1] + 0.0016 + lift]])
            return lash_with(lo, hi)

        lash_morphs = {
            f"blink_{side}": lash_line(closed_line),
            "happy": lash_line(arc),
            "relaxed": lash_line(rel_line),
            "angry": lash_line(vt - (0.0062 * (1 - x) + 0.0018 * x)),
            "sad": lash_line(vt - (0.0016 * (1 - x) + 0.0052 * x)),
            "surprised": lash_line(vt, 0.0012),
        }
        parts.add("lashU" + side, put(ulv2, 0.0005), ulf, uluv, mats["lash"], lash_morphs, flip=s < 0)

        # The lower lash: a thin line under the outer half.
        sel = x > 0.42
        lus, lvb = us[sel], vb[sel]
        lt = 0.0004 + 0.0007 * np.sin(np.pi * (lus - lus[0]) / (lus[-1] - lus[0]))
        llv2, llf = strip(lus, lvb + 0.0002, lvb - lt)
        llc = np.array([lus.mean(), lvb.mean()])
        hidden = put(llc + (llv2 - llc) * 0.05 + [0, 0.002], 0.0004)
        parts.add("lashL" + side, put(llv2, 0.0004), llf, np.zeros((len(llv2), 2)), mats["lash"], {f"blink_{side}": put(llc + (llv2 - llc) * 0.6 + [0, 0.0009], 0.0004), "happy": hidden}, flip=s < 0)

        # The brow: thick at the inner end, thin and higher at the outer.
        bkeys_top = [(-0.0185, 0.0198), (-0.008, 0.0238), (0.004, 0.0256), (0.014, 0.0254), (0.0225, 0.0228), (0.0275, 0.0192)]
        bkeys_bot = [(0.0275, 0.0192), (0.0215, 0.0206), (0.013, 0.0219), (0.002, 0.0214), (-0.008, 0.0190), (-0.0185, 0.0146)]
        brow = np.vstack([lib.catmull(bkeys_top, 4)[:-1], lib.catmull(bkeys_bot, 4)[:-1]])
        bv2, bf = lib.fan_mesh_2d(brow, rings=2)
        bx = np.clip((bv2[:, 0] + 0.0175) / 0.044, 0, 1)

        def brow_with(dv_inner, dv_outer, du=0.0):
            return put(bv2 + np.stack([np.full_like(bx, du), dv_inner * (1 - bx) + dv_outer * bx], axis=1), 0.0006)

        brow_morphs = {
            "angry": brow_with(-0.0050, 0.0008, -0.0012),
            "sad": brow_with(0.0042, -0.0012),
            "surprised": brow_with(0.0048, 0.0042),
            "happy": brow_with(0.0020, 0.0016),
            "relaxed": brow_with(-0.0008, -0.0006),
            f"blink_{side}": brow_with(-0.0010, -0.0008),
        }
        parts.add("brow" + side, put(bv2, 0.0006), bf, np.zeros((len(bv2), 2)), mats["brow"], brow_morphs, flip=s < 0)

    # The sockets.
    for cut in cutters:
        mod = head.modifiers.new("socket", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cut
    lib.apply_modifiers(head)
    for cut in cutters:
        bpy.data.objects.remove(cut)
    lib.shade_smooth(head)

    build_mouth(surf, parts, mats)
    O, N, U, V = frame_at(surf, 0.0, CHIN_Z + 0.064)
    wedge = np.array([(0.0008, 0.0060), (0.0026, 0.0002), (0.0020, -0.0016), (-0.0004, -0.0012), (0.0002, 0.0030)])
    nv2, nf = lib.fan_mesh_2d(wedge, rings=1)
    parts.add("nose", lib.place_on(surf, nv2, O, U, V, -N, 0.0004), nf, np.zeros((len(nv2), 2)), mats["noseshade"])
    return parts


# ---------------------------------------------------------------- the mouth

MOUTH_SHAPES = {
    # width/2, top centre, bottom centre, corners, top roundness, bottom roundness
    "rest": (0.0094, 0.0008, -0.0007, 0.0015, 1.0, 1.0),
    "aa": (0.0086, 0.0034, -0.0118, 0.0010, 0.55, 0.8),
    "ih": (0.0110, 0.0016, -0.0042, 0.0010, 0.5, 0.7),
    "ou": (0.0046, 0.0022, -0.0062, -0.0010, 0.8, 0.8),
    "ee": (0.0118, 0.0018, -0.0064, 0.0022, 0.4, 0.9),
    "oh": (0.0068, 0.0034, -0.0100, -0.0012, 0.8, 0.9),
    "happy": (0.0106, 0.0012, -0.0088, 0.0036, 0.3, 1.0),
    "angry": (0.0070, -0.0002, -0.0046, -0.0028, 1.4, 0.9),
    "sad": (0.0068, -0.0008, -0.0017, -0.0030, 1.6, 1.6),
    "surprised": (0.0050, 0.0032, -0.0086, -0.0015, 0.7, 0.8),
    "relaxed": (0.0080, 0.0006, -0.0002, 0.0021, 1.0, 1.0),
}
MOUTH_N = 16  # points per edge


def mouth_edges(shape):
    w, tc, bc, cv, ta, ba = MOUTH_SHAPES[shape]
    th = np.linspace(-math.pi / 2, math.pi / 2, MOUTH_N)
    u = w * np.sin(th)
    ct = np.abs(np.cos(th))
    top = cv + (tc - cv) * ct ** ta
    bot = cv + (bc - cv) * ct ** ba
    return u, top, bot


def mouth_outline(shape):
    u, top, bot = mouth_edges(shape)
    # Top left to right, then bottom right to left (corners shared once).
    return np.vstack([np.stack([u, top], 1), np.stack([u[::-1], bot[::-1]], 1)[1:-1]])


def build_mouth(surf, parts, mats):
    O, N, U, V = frame_at(surf, 0.0, MOUTH_Z)

    def put(pts2d, offset):
        return lib.place_on(surf, pts2d, O, U, V, -N, offset)

    rest = mouth_outline("rest")
    mv2, mf = lib.fan_mesh_2d(rest, rings=3)
    morphs = {}
    teeth_m, tongue_m = {}, {}

    def teeth_shape(shape, show):
        u, top, bot = mouth_edges(shape)
        depth = (top - bot) * 0.30 * show
        tv2, _ = strip(u * 0.92, top - 0.0003, top - 0.0003 - depth)
        return tv2

    def tongue_shape(shape, show):
        u, top, bot = mouth_edges(shape)
        c = np.array([0.0, bot.min() + (top.max() - bot.min()) * 0.22])
        w = (u.max() - u.min()) * 0.30 * show + 1e-5
        h = (top.max() - bot.min()) * 0.20 * show + 1e-5
        ring = np.array([(c[0] + w * math.cos(a), c[1] + h * 0.8 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)])
        ring[:, 1] = np.maximum(ring[:, 1], bot.min() + 0.0006)
        return ring

    tv2_rest = teeth_shape("rest", 0.0)
    tg_rest = tongue_shape("rest", 0.0)
    teeth_show = {"aa": 1.0, "ee": 1.0, "ih": 0.8, "happy": 0.9, "angry": 1.0, "oh": 0.4, "surprised": 0.3}
    tongue_show = {"aa": 1.0, "oh": 0.8, "happy": 0.8, "surprised": 0.6, "ou": 0.5}
    for shape in MOUTH_SHAPES:
        if shape == "rest":
            continue
        morphs[shape] = put(lib.ring_points(mouth_outline(shape), 3), 0.0003)
        teeth_m[shape] = put(teeth_shape(shape, teeth_show.get(shape, 0.0)), 0.00045)
        tg = tongue_shape(shape, tongue_show.get(shape, 0.0))
        tongue_m[shape] = put(lib.ring_points(tg, 2), 0.0004)
    parts.add("mouth", put(mv2, 0.0003), mf, np.zeros((len(mv2), 2)), mats["mouth"], morphs)
    _, tf = strip(np.linspace(-1, 1, MOUTH_N), np.zeros(MOUTH_N), np.zeros(MOUTH_N))
    parts.add("teeth", put(tv2_rest, 0.00045), tf, np.zeros((len(tv2_rest), 2)), mats["teeth"], teeth_m)
    tgv, tgf = lib.fan_mesh_2d(tg_rest, rings=2)
    parts.add("tongue", put(tgv, 0.0004), tgf, np.zeros((len(tgv), 2)), mats["tongue"], tongue_m)


# ---------------------------------------------------------------- pictures of the eye

def iris_image(size=256, color=(0.96, 0.66, 0.16), dark=(0.42, 0.16, 0.05)):
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size * 2 - 1
    v = 1 - (y + 0.5) / size * 2
    r = np.sqrt(u * u + v * v)
    col = np.zeros((size, size, 4))
    base = np.array(color)
    dk = np.array(dark)
    # Darker toward the top (the lid's shadow), lighter low.
    t = np.clip((v + 1) / 2, 0, 1)[..., None]
    c = base * (1 - t * 0.55) + dk * (t * 0.55)
    glow = np.clip(1 - np.abs(v + 0.45) / 0.55, 0, 1)[..., None] * np.clip(1 - r, 0, 1)[..., None]
    c = c + (np.array([1.0, 0.92, 0.55]) - c) * glow * 0.55
    ang = np.arctan2(v, u)
    streak = 0.06 * np.sin(ang * 23) * np.clip(r - 0.35, 0, 1)
    c = c * (1 + streak[..., None])
    ring = np.clip((r - 0.80) / 0.14, 0, 1)[..., None]
    c = c * (1 - ring) + dk * 0.55 * ring
    pupil = ((u / 0.30) ** 2 + ((v - 0.02) / 0.40) ** 2) < 1
    c[pupil] = dk * 0.25
    hi1 = ((u + 0.30) / 0.24) ** 2 + ((v - 0.40) / 0.19) ** 2 < 1
    hi2 = ((u - 0.34) / 0.10) ** 2 + ((v + 0.44) / 0.08) ** 2 < 1
    c[hi1] = 1.0
    c[hi2] = [1.0, 0.98, 0.9]
    col[..., :3] = np.clip(c, 0, 1)
    col[..., 3] = 1.0
    return lib.image_from_array("iris", col)


def white_image(size=128):
    y, x = np.mgrid[0:size, 0:size]
    v = 1 - (y + 0.5) / size
    col = np.ones((size, size, 4))
    shadow = np.clip((v - 0.58) / 0.42, 0, 1) ** 1.3
    tint = np.array([0.78, 0.80, 0.90])
    col[..., :3] = 1 - shadow[..., None] * (1 - tint)
    return lib.image_from_array("white", col)
