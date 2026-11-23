"""Clothes over the body: garment zones as materials on the fused body, and the pieces on top that hide the seams and give
the look — the crossed collar, the armholes' hems, the sash with its knot and ends, the scarf with its tails, the wraps
on forearms and shins, the fingerless gloves with a plate, the boots' cuffs."""
import math

import numpy as np

import body
import lib


def zone_body(ob, mats):
    """Skin, top or trousers for each face of the fused body."""
    me = ob.data
    order = [mats["skin"], mats["top"], mats["pants"], mats["wrap"]]
    me.materials.clear()
    for m in order:
        me.materials.append(m)
    idx = []
    for p in me.polygons:
        x, y, z = p.center
        ax = abs(x)
        if ax > 0.462:
            k = 3
        elif z < 0.272:
            k = 3
        elif z < 1.018:
            k = 2
        elif z > 1.432 or (z > 1.395 and ax < 0.066):
            k = 0
        elif ax > 0.176 and z < 1.43:
            k = 0
        elif y < -0.02 and z > 1.19 and ax < 0.010 + (z - 1.19) * 0.36:
            k = 0
        else:
            k = 1
        idx.append(k)
    me.polygons.foreach_set("material_index", idx)
    me.update()


def on_body(surf, pts, offset, toward=None):
    """Points pressed onto the body from outside (along -normal guess), `offset` out."""
    out = []
    for p in pts:
        p = np.asarray(p, float)
        if toward is None:
            c = np.array([0.0, 0.0, p[2]])
            d = c - p
            d[2] = 0
        else:
            d = np.asarray(toward, float)
        d /= np.linalg.norm(d)
        q, _n = surf.project(p - d * 0.05, d, offset)
        out.append(q)
    return np.array(out)


def collar(surf, mats):
    """The crossed collar: a band down each side of the V and round the back of the neck."""
    parts = []
    for s in (1, -1):
        zs = np.linspace(1.188, 1.41, 9)
        front = [(s * (0.010 + (z - 1.19) * 0.36 + 0.006), -0.2, z) for z in zs]
        pts = on_body(surf, front, 0.004, toward=(0, 1, 0))
        # Round the neck to the back.
        back = []
        for a in np.linspace(0.0, 1.0, 6)[1:]:
            ang = (1 - a) * math.radians(55) + a * math.radians(178)
            back.append((s * math.sin(ang) * 0.072, 0.008 - math.cos(ang) * 0.064, 1.415 + 0.006 * a))
        pts = np.vstack([pts, back])
        widths = [0.018] + [0.026] * (len(pts) - 2) + [0.024]
        r = lib.ribbon(pts, widths, 0.006, normal_hint=(0, -1, 0.4), name=f"collar{s}", sub=3)
        parts.append(r)
    ob = lib.join(parts, "Collar")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["trim"])


def armholes(mats):
    parts = []
    for s in (1, -1):
        x = s * 0.180
        keys = [dict(c=(x - s * 0.006, body.ARM_Y, body.SHOULDER_Z - 0.002), rx=0.061, ry=0.058), dict(c=(x + s * 0.008, body.ARM_Y, body.SHOULDER_Z - 0.002), rx=0.059, ry=0.056)]
        r = lib.loft(keys, n=32, sub=2, up=(0, 0, 1), caps=False, name="hem")
        r = lib.solidify(r, 0.0028, offset=1.0)
        parts.append(r)
    ob = lib.join(parts, "Armholes")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["piping"])


def sash(mats):
    """A wide sash round the waist, a knot on the left hip and two ends hanging from it (they swing)."""
    keys = [dict(c=(0, 0.004, 0.982), rx=0.158, ry=0.099, p=2.35), dict(c=(0, 0.003, 1.025), rx=0.150, ry=0.095, p=2.3), dict(c=(0, 0.001, 1.068), rx=0.146, ry=0.094, p=2.3)]
    band = lib.loft(keys, n=48, sub=3, up=(1, 0, 0), caps=False, name="band", uv=True)
    band = lib.solidify(band, 0.006, offset=1.0)
    # A bow: two loops either side of a small knot.
    knot = lib.ellipsoid((0.116, -0.080, 1.026), (0.016, 0.014, 0.018), name="knot", n=16, rot=lib.rot_z(math.radians(-35)))
    loops = [knot]
    for ang, dz in ((50, 0.012), (-130, -0.006)):
        r = lib.rot_z(math.radians(-35)) @ lib.rot_y(math.radians(ang))
        c = np.array([0.116, -0.080, 1.026]) + r @ np.array([0.030, 0.0, 0.0]) + np.array([0, 0, dz])
        loops.append(lib.ellipsoid(tuple(c), (0.030, 0.010, 0.017), name="loop", n=16, rot=r))
    knot = lib.recalc_normals(lib.subdivide(lib.join(loops, "bow"), 1))
    ob = lib.join([band, knot], "Sash")
    lib.shade_smooth(ob)
    lib.assign(ob, mats["sash"])
    ends = []
    chains = []
    for k, (dx, L, w) in enumerate(((0.0, 0.22, 0.050), (0.026, 0.18, 0.044))):
        start = np.array([0.120 + dx, -0.078, 1.015])
        pts = [start + np.array([0, -0.006, 0]), start + np.array([0.006, -0.012, -L * 0.33]), start + np.array([0.010, -0.010, -L * 0.66]), start + np.array([0.014, -0.006, -L])]
        r = lib.ribbon(pts, [w * 0.8, w, w * 1.02, w * 1.05], 0.006, normal_hint=(0.4, -1, 0), name=f"end{k}", sub=4)
        ends.append(r)
        chains.append(np.array(pts))
    e = lib.join(ends, "SashEnds")
    lib.shade_smooth(e)
    lib.assign(e, mats["sash"])
    return ob, e, chains


def scarf(surf, mats):
    """Two loose loops round the neck and two long tails down the back (they swing)."""
    loops = []
    for z, r, rr, tilt, ph in ((1.398, 0.083, 0.024, 0.022, 0.0), (1.436, 0.076, 0.021, 0.018, 1.3)):
        pts = []
        for a in np.linspace(0, 2 * math.pi, 26):
            wob = 1 + 0.035 * math.sin(3 * a + ph)
            pts.append((math.sin(a) * r * wob, 0.010 - math.cos(a) * r * 0.94 * wob, z - tilt * math.cos(a)))
        pts += pts[1:3]
        keys = [dict(c=p, rx=rr * (1 + 0.12 * math.sin(5 * i * 0.24 + ph)), ry=rr * 0.78) for i, p in enumerate(pts)]
        loops.append(lib.loft(keys, n=16, sub=2, up=(0, 0, 1), name="loop"))
    wrap = lib.join(loops, "Scarf")
    wrap = lib.remesh(wrap, 0.0035, smooth_iter=3, smooth_factor=0.5)
    wrap = lib.decimate(wrap, 0.25)
    lib.shade_smooth(wrap)
    lib.assign(wrap, mats["scarf"])
    tails = []
    chains = []
    for k, (x0, x1, L, w) in enumerate(((0.022, 0.048, 0.46, 0.064), (-0.016, -0.030, 0.40, 0.058))):
        top = np.array([x0, 0.084, 1.418])
        pts = [top]
        for t in np.linspace(0.2, 1.0, 5):
            z = top[2] - L * t
            x = x0 + (x1 - x0) * t
            # Over the back, off it a little; the cloth's own surface is pressed out from the body.
            # Over the sword on the back: off the body by more than the scabbard is thick.
            p = on_body(surf, [(x, 0.3, z)], 0.046 + 0.008 * t, toward=(0, -1, 0))[0]
            pts.append(p)
        pts = np.array(pts)
        r = lib.ribbon(pts, [w * 0.85] + [w] * (len(pts) - 2) + [w * 0.92], [0.014, 0.012, 0.011, 0.010, 0.010, 0.010], normal_hint=(0, 1, 0), name=f"tail{k}", sub=4, twist=[0, 0.05, 0.10, 0.12, 0.08, 0.04])
        tails.append(r)
        chains.append(pts)
    t = lib.join(tails, "ScarfTails")
    lib.shade_smooth(t)
    lib.assign(t, mats["scarf"])
    return wrap, t, chains


def forearm_wraps(mats):
    parts = []
    for s in (1, -1):
        keys = []
        for x, rz, ry in ((0.462, 0.0395, 0.0435), (0.50, 0.0415, 0.0430), (0.55, 0.0395, 0.0405), (0.60, 0.0355, 0.0375), (0.65, 0.0305, 0.0345), (0.69, 0.0265, 0.0335), (0.712, 0.0255, 0.0345)):
            keys.append(dict(c=(s * x, body.ARM_Y, body.SHOULDER_Z), rx=rz, ry=ry))
        r = lib.loft(keys, n=28, sub=4, up=(0, 0, 1), caps=False, name="fwrap", uv=True)
        r = lib.solidify(r, 0.002, offset=1.0)
        parts.append(r)
    ob = lib.join(parts, "ArmWraps")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["bandage"])


def shin_wraps(mats):
    parts = []
    for s in (1, -1):
        x = s * body.LEG_X
        keys = [dict(c=(x, 0.006, z), rx=r, ry=r * 1.06) for z, r in ((0.282, 0.053), (0.25, 0.048), (0.20, 0.0445), (0.15, 0.0425), (0.11, 0.0405), (0.075, 0.0410), (0.055, 0.0440))]
        r = lib.loft(keys, n=28, sub=4, up=(1, 0, 0), caps=False, name="swrap", uv=True)
        r = lib.solidify(r, 0.002, offset=1.0)
        parts.append(r)
    ob = lib.join(parts, "ShinWraps")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["bandage"])


def glove_zones(hand, side, mats):
    """The glove covers the palm and the first joint of each finger; the rest of the fingers is skin."""
    joints = body.finger_joints(side)
    me = hand.data
    me.materials.clear()
    me.materials.append(mats["glove"])
    me.materials.append(mats["skin"])
    idx = []
    for p in me.polygons:
        c = np.array(p.center)
        k = 0
        best = 1e9
        for finger, (pts, _r0, _r1) in joints.items():
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                ab = b - a
                t = np.clip(np.dot(c - a, ab) / np.dot(ab, ab), 0, 1)
                d = np.linalg.norm(a + t * ab - c)
                if d < best:
                    best = d
                    # Past the middle of the first segment: bare.
                    bare = (i >= 1) or (i == 0 and t > 0.62 and finger != "Thumb")
                    if finger == "Thumb":
                        bare = i >= 2 or (i == 1 and t > 0.45)
                    k = 1 if (bare and d < 0.02) else 0
        idx.append(k)
    me.polygons.foreach_set("material_index", idx)
    me.update()


def glove_parts(mats):
    parts = []
    for s in (1, -1):
        cuff = lib.loft([dict(c=(s * 0.700, body.ARM_Y, body.SHOULDER_Z - 0.001), rx=0.0265, ry=0.0355), dict(c=(s * 0.722, body.ARM_Y - 0.001, body.SHOULDER_Z - 0.001), rx=0.0245, ry=0.0365)], n=28, sub=2, up=(0, 0, 1), caps=False, name="cuff")
        cuff = lib.solidify(cuff, 0.003, offset=1.0)
        parts.append(cuff)
    ob = lib.join(parts, "Cuffs")
    lib.shade_smooth(ob)
    lib.assign(ob, mats["glove"])
    plates = []
    for s in (1, -1):
        p = lib.ellipsoid((s * 0.757, -0.004, body.HAND_Z + 0.0145), (0.020, 0.026, 0.0045), name="plate", n=20)
        plates.append(p)
    pl = lib.recalc_normals(lib.join(plates, "Plates"))
    lib.shade_smooth(pl)
    lib.assign(pl, mats["metal"])
    return ob, pl


def boot_cuffs(mats):
    parts = []
    for s in (1, -1):
        x = s * body.LEG_X
        keys = [dict(c=(x, 0.010, 0.030), rx=0.050, ry=0.064), dict(c=(x, 0.010, 0.060), rx=0.046, ry=0.056), dict(c=(x, 0.010, 0.088), rx=0.0455, ry=0.0500)]
        r = lib.loft(keys, n=28, sub=3, up=(1, 0, 0), caps=False, name="bcuff")
        r = lib.solidify(r, 0.003, offset=1.0)
        parts.append(r)
    ob = lib.join(parts, "BootCuffs")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["boot"])


def bandage_image(size=256):
    """Wraps: off-white bands crossing on a slant, with soft dark seams."""
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size
    v = (y + 0.5) / size
    band = ((u * 1.0 + v * 7.0) % 1.0)
    seam = np.exp(-((band - 0.02) / 0.025) ** 2) + np.exp(-((band - 0.98) / 0.02) ** 2)
    base = np.array([0.90, 0.88, 0.82])
    dark = np.array([0.62, 0.58, 0.52])
    shade = 1 - 0.06 * np.sin(band * math.pi)
    col = base[None, None, :] * shade[..., None]
    col = col * (1 - seam[..., None] * 0.65) + dark * seam[..., None] * 0.65
    img = np.ones((size, size, 4))
    img[..., :3] = np.clip(col, 0, 1)
    return lib.image_from_array("bandage", img)


def sash_image(size=128):
    y, x = np.mgrid[0:size, 0:size]
    v = (y + 0.5) / size
    base = np.array([0.66, 0.10, 0.14])
    gold = np.array([0.86, 0.66, 0.30])
    stripe = (np.abs(v - 0.16) < 0.025) | (np.abs(v - 0.84) < 0.025)
    col = np.tile(base, (size, size, 1))
    col[stripe] = gold
    img = np.ones((size, size, 4))
    img[..., :3] = col
    return lib.image_from_array("sash", img)


def fishnet(body_ob, mats):
    """A net undershirt seen in the V of the top: the body's skin there, a little out, with a net picture."""
    import bmesh

    co, faces = lib.object_arrays(body_ob)
    keep = []
    for f in faces:
        c = co[f].mean(axis=0)
        x, y, z = c
        if y < -0.01 and 1.17 < z < 1.41 and abs(x) < 0.012 + (z - 1.17) * 0.40:
            keep.append(f)
    used = sorted({i for f in keep for i in f})
    remap = {i: k for k, i in enumerate(used)}
    verts = co[used]
    fs = [[remap[i] for i in f] for f in keep]
    uvs = [((co[i][0] + 0.2) * 14.0, (co[i][2] - 1.0) * 14.0) for f in keep for i in f]
    ob = lib.mesh_object("Fishnet", verts, fs, uvs)
    # A little off the skin.
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * 0.0012
    bm.to_mesh(ob.data)
    bm.free()
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["fishnet"])


def fishnet_image(size=128):
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size
    v = (y + 0.5) / size
    a = ((u + v) * 4) % 1.0
    b = ((u - v) * 4) % 1.0
    line = np.minimum(np.minimum(a, 1 - a), np.minimum(b, 1 - b))
    alpha = np.clip(1.0 - (line - 0.035) / 0.03, 0, 1)
    img = np.zeros((size, size, 4))
    img[..., :3] = np.array([0.10, 0.10, 0.13])
    img[..., 3] = alpha
    return lib.image_from_array("fishnet", img)
