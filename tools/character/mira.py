"""«Мира»: the second hero, made like «Рэн» from nothing but with her own body, hair, clothes and things. A DJ girl in
ХатаВойс's colours: a dark bob with mint tips and blunt bangs, a loose cream hoodie with the hood down, drawstrings and a
kangaroo pocket, denim shorts over dark leggings, chunky sneakers with mint soles, big headphones round the neck with
glowing mint rings. The skeleton, the face and its expressions are «Рэн»'s (`body`, `head`, `rig`), so every motion and
emote of the app fits her at once.

Sizes in metres, facing -Y, left at +X, the same joints as `body`.
"""
import math

import numpy as np

import body
import hair as hairmod
import lib

# Where the clothes end: the hoodie's hem (z), the shorts' hem (z), the sleeve's cuff (|x|).
HOODIE_HEM = 0.975
SHORTS_HEM = 0.79
CUFF_X = 0.668

# ---------------------------------------------------------------- the body


def torso():
    """Hips a little fuller than «Рэн»'s, narrower shoulders; above the hem the surface is the hoodie itself, so it hangs
    straight from the chest (no waist) like a loose one does."""
    keys = [
        dict(c=(0, 0.006, 0.83), rx=0.118, ry=0.088, p=2.2),
        dict(c=(0, 0.012, 0.89), rx=0.166, ry=0.104, p=2.4),
        dict(c=(0, 0.010, 0.95), rx=0.170, ry=0.106, p=2.4),
        dict(c=(0, 0.008, 1.00), rx=0.162, ry=0.102, p=2.4),
        dict(c=(0, 0.004, 1.06), rx=0.152, ry=0.098, p=2.4),
        dict(c=(0, -0.002, 1.12), rx=0.148, ry=0.100, p=2.4),
        dict(c=(0, -0.010, 1.18), rx=0.148, ry=0.106, p=2.5),
        dict(c=(0, -0.014, 1.23), rx=0.150, ry=0.106, p=2.5),
        dict(c=(0, -0.009, 1.28), rx=0.153, ry=0.099, p=2.6),
        dict(c=(0, -0.003, 1.32), rx=0.155, ry=0.092, p=2.7),
        dict(c=(0, 0.002, 1.350), rx=0.150, ry=0.086, p=2.8),
        dict(c=(0, 0.005, 1.383), rx=0.116, ry=0.066, p=2.5),
        dict(c=(0, 0.008, 1.412), rx=0.052, ry=0.050, p=2.0),
        dict(c=(0, 0.010, 1.47), rx=0.044, ry=0.045, p=2.0),
    ]
    return lib.loft(keys, n=40, sub=4, up=(1, 0, 0), name="torso")


def arm(side):
    """A loose sleeve down to the cuff, then a slim wrist."""
    s = 1 if side == "L" else -1
    y, z = body.ARM_Y, body.SHOULDER_Z
    keys = [
        dict(c=(s * 0.095, y, z - 0.004), rx=0.062, ry=0.058),
        dict(c=(s * 0.165, y, z), rx=0.060, ry=0.056, p=2.1),
        dict(c=(s * 0.215, y, z - 0.002), rx=0.055, ry=0.053),
        dict(c=(s * 0.290, y - 0.002, z - 0.003), rx=0.051, ry=0.050),
        dict(c=(s * 0.370, y, z - 0.002), rx=0.048, ry=0.048),
        dict(c=(s * 0.440, y + 0.002, z), rx=0.046, ry=0.047),
        dict(c=(s * 0.520, y, z), rx=0.047, ry=0.048),
        dict(c=(s * 0.600, y, z), rx=0.046, ry=0.047),
        dict(c=(s * 0.650, y, z), rx=0.040, ry=0.042),
        # The wrist past the cuff.
        dict(c=(s * 0.680, y, z), rx=0.023, ry=0.028),
        dict(c=(s * 0.704, y, z), rx=0.020, ry=0.027),
        dict(c=(s * 0.722, y, z), rx=0.019, ry=0.028),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"arm{side}")


def leg(side):
    """A slim leg in leggings; the shorts' width over the thigh."""
    s = 1 if side == "L" else -1
    keys = [
        dict(c=(s * 0.078, 0.010, 0.965), rx=0.090, ry=0.098),
        dict(c=(s * 0.094, 0.006, 0.86), rx=0.092, ry=0.096),
        dict(c=(s * 0.098, 0.002, 0.79), rx=0.082, ry=0.088),
        dict(c=(s * 0.098, -0.001, 0.72), rx=0.066, ry=0.072),
        dict(c=(s * 0.097, -0.003, 0.60), rx=0.058, ry=0.064),
        dict(c=(s * 0.096, -0.004, 0.50), rx=0.050, ry=0.056),
        dict(c=(s * 0.096, 0.000, 0.42), rx=0.052, ry=0.059),
        dict(c=(s * 0.095, 0.004, 0.33), rx=0.048, ry=0.053),
        dict(c=(s * 0.095, 0.006, 0.24), rx=0.040, ry=0.043),
        dict(c=(s * 0.094, 0.010, 0.16), rx=0.033, ry=0.036),
        dict(c=(s * 0.094, 0.012, 0.10), rx=0.031, ry=0.035),
        dict(c=(s * 0.094, 0.012, 0.07), rx=0.030, ry=0.035),
    ]
    return lib.loft(keys, n=32, sub=4, up=(1, 0, 0), name=f"leg{side}")


def body_mesh():
    parts = [torso(), arm("L"), arm("R"), leg("L"), leg("R")]
    ob = lib.join(parts, "body")
    ob = lib.remesh(ob, 0.0062, smooth_iter=6, smooth_factor=0.6)
    ob = lib.decimate(ob, 0.32)
    lib.shade_smooth(ob)
    return ob


def zone_body(ob, mats):
    """Skin, hoodie, shorts or leggings for each face of the fused body."""
    me = ob.data
    order = [mats["skin"], mats["hoodie"], mats["shorts"], mats["leggings"]]
    me.materials.clear()
    for m in order:
        me.materials.append(m)
    idx = []
    for p in me.polygons:
        x, y, z = p.center
        ax = abs(x)
        if ax > CUFF_X:
            k = 0  # past the cuff: the wrist
        elif z < SHORTS_HEM:
            k = 3
        elif z < HOODIE_HEM and ax < 0.30:
            k = 2
        elif z > 1.398 and ax < 0.085:
            k = 0  # the neck over the hoodie's collar
        else:
            k = 1
        idx.append(k)
    me.polygons.foreach_set("material_index", idx)
    me.update()


def sneaker(side):
    """A chunky sneaker over the foot (rings: u up = height, v across = width), its thick sole apart."""
    s = 1 if side == "L" else -1
    x = body.LEG_X
    keys = [
        dict(c=(s * x, 0.056, 0.064), rx=0.044, ry=0.033, p=2.3),
        dict(c=(s * x, 0.036, 0.076), rx=0.058, ry=0.040, p=2.4),
        dict(c=(s * x, 0.006, 0.080), rx=0.060, ry=0.044, p=2.5),
        dict(c=(s * (x + 0.003), -0.046, 0.066), rx=0.046, ry=0.048, p=2.6),
        dict(c=(s * (x + 0.004), -0.096, 0.056), rx=0.036, ry=0.050, p=2.7),
        dict(c=(s * (x + 0.004), -0.136, 0.050), rx=0.029, ry=0.047, p=2.6),
        dict(c=(s * (x + 0.003), -0.162, 0.047), rx=0.022, ry=0.036, p=2.3),
        dict(c=(s * (x + 0.002), -0.174, 0.046), rx=0.012, ry=0.020, p=2.1),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"sneaker{side}")


def sneaker_sole(side):
    s = 1 if side == "L" else -1
    x = body.LEG_X
    keys = [
        dict(c=(s * x, 0.066, 0.021), rx=0.020, ry=0.034, p=3.0),
        dict(c=(s * x, 0.040, 0.020), rx=0.021, ry=0.044, p=3.2),
        dict(c=(s * (x + 0.002), -0.020, 0.019), rx=0.020, ry=0.050, p=3.2),
        dict(c=(s * (x + 0.004), -0.100, 0.019), rx=0.020, ry=0.054, p=3.2),
        dict(c=(s * (x + 0.003), -0.160, 0.021), rx=0.018, ry=0.044, p=2.8),
        dict(c=(s * (x + 0.002), -0.184, 0.025), rx=0.012, ry=0.024, p=2.3),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"sole{side}")


def laces(mats):
    """Three white laces across each sneaker's tongue."""
    parts = []
    for s in (1, -1):
        x = s * body.LEG_X
        for k, (y, z) in enumerate(((-0.020, 0.124), (-0.044, 0.112), (-0.068, 0.100))):
            w = 0.026 - k * 0.002
            parts.append(lib.capsule((x - w, y, z), (x + w, y - 0.002, z + 0.002), 0.0042, name="lace"))
    ob = lib.join(parts, "Laces")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["lace"])


# ---------------------------------------------------------------- clothes on top


def _front(surf, x, z, offset):
    return surf.project((x, -0.3, z), (0, 1, 0), offset)


def _patch(surf, rows, offset, name, nx=12):
    """A sheet lying on the front of the body: `rows` are (z, x_left, x_right) from the bottom up."""
    verts = []
    for z, xl, xr in rows:
        for i in range(nx + 1):
            x = xl + (xr - xl) * i / nx
            p, _n = _front(surf, x, z, offset)
            verts.append(p)
    faces = []
    for j in range(len(rows) - 1):
        for i in range(nx):
            a = j * (nx + 1) + i
            b = a + nx + 1
            faces.append([a, a + 1, b + 1, b])
    return lib.mesh_object(name, np.array(verts), faces)


def hoodie_parts(surf, mats):
    """The rib at the hem and the cuffs, the hood lying down on the upper back with its rim round the neck, the kangaroo
    pocket, and the drawstrings (returned apart with their chains: they swing)."""
    rings = []
    hem = lib.loft(
        [dict(c=(0, 0.010, HOODIE_HEM - 0.006), rx=0.176, ry=0.112, p=2.4), dict(c=(0, 0.009, HOODIE_HEM + 0.030), rx=0.170, ry=0.108, p=2.4)],
        n=48, sub=3, up=(1, 0, 0), caps=False, name="hem",
    )
    rings.append(lib.solidify(hem, 0.007, offset=0.0))
    for s in (1, -1):
        cuff = lib.loft(
            [dict(c=(s * (CUFF_X - 0.034), body.ARM_Y, body.SHOULDER_Z), rx=0.044, ry=0.046), dict(c=(s * (CUFF_X + 0.004), body.ARM_Y, body.SHOULDER_Z), rx=0.033, ry=0.036)],
            n=28, sub=3, up=(0, 0, 1), caps=False, name="cuff",
        )
        rings.append(lib.solidify(cuff, 0.006, offset=0.0))
    rib = lib.join(rings, "Rib")
    lib.shade_smooth(rib)
    lib.assign(rib, mats["rib"])

    # The hood, down: a soft rim round the back of the neck from shoulder to shoulder, and the hood itself lying flat on
    # the upper back below it.
    path = []
    for a in np.linspace(-1.0, 1.0, 13):
        t = a * math.pi * 0.50
        path.append((math.sin(t) * 0.098, 0.016 + math.cos(t) * 0.066, 1.402 + 0.012 * math.cos(t)))
    keys = []
    for i, c in enumerate(path):
        k = i / (len(path) - 1)
        back = math.cos((k - 0.5) * math.pi)
        keys.append(dict(c=c, rx=0.020 + 0.016 * back, ry=0.018 + 0.014 * back, p=2.2))
    rim = lib.loft(keys, n=20, sub=3, up=(0, 0, 1), name="HoodRim")
    # The hood: a soft teardrop lying on the back, wide under the rim, narrowing to a point between the shoulder blades.
    keys = []
    for z, half, thick in ((1.402, 0.092, 0.010), (1.384, 0.108, 0.016), (1.352, 0.106, 0.018), (1.318, 0.088, 0.017), (1.288, 0.058, 0.014), (1.266, 0.026, 0.010), (1.256, 0.006, 0.005)):
        q, _n = surf.project((0, 0.3, z), (0, -1, 0), thick * 0.7)
        keys.append(dict(c=q, rx=half, ry=thick, p=2.4))
    flap = lib.loft(keys, n=28, sub=3, up=(1, 0, 0), name="HoodFlap")
    hood = lib.join([rim, flap], "Hood")
    lib.shade_smooth(hood)
    lib.assign(hood, mats["hoodie"])

    # The pocket: on the belly, its sides slanting in toward the top (the openings).
    rows = [(1.000 + 0.012 * j, -0.112 + 0.0035 * j, 0.112 - 0.0035 * j) for j in range(10)]
    pocket = lib.solidify(_patch(surf, rows, 0.006, "Pocket"), 0.006, offset=0.0)
    lib.shade_smooth(pocket)
    lib.assign(pocket, mats["hoodie"])

    # The drawstrings: out of the collar's front, down over the chest.
    strings, chains, tips = [], [], []
    for s in (1, -1):
        zs = (1.388, 1.346, 1.300, 1.255, 1.214)
        pts = np.array([_front(surf, s * (0.040 + 0.004 * k), z, 0.008)[0] for k, z in enumerate(zs)])
        chains.append(pts)
        strings.append(lib.loft([dict(c=q, rx=0.0042, ry=0.0042) for q in pts], n=10, sub=4, up=(1, 0, 0), name="string"))
        end = pts[-1] + (pts[-1] - pts[-2]) / np.linalg.norm(pts[-1] - pts[-2]) * 0.022
        tips.append(lib.capsule(pts[-1], end, 0.0058, name="aglet"))
    cords = lib.join(strings, "Drawstrings")
    lib.shade_smooth(cords)
    lib.assign(cords, mats["string"])
    aglets = lib.join(tips, "Aglets")
    lib.shade_smooth(aglets)
    lib.assign(aglets, mats["metal"])
    return rib, hood, pocket, cords, aglets, chains


def shorts_hems(mats):
    """Rolled hems at the thighs."""
    parts = []
    for s in (1, -1):
        roll = lib.loft(
            [dict(c=(s * 0.098, 0.002, SHORTS_HEM - 0.002), rx=0.086, ry=0.092), dict(c=(s * 0.098, 0.002, SHORTS_HEM + 0.024), rx=0.088, ry=0.094)],
            n=32, sub=3, up=(1, 0, 0), caps=False, name="roll",
        )
        parts.append(lib.solidify(roll, 0.007, offset=0.0))
    ob = lib.join(parts, "ShortsHems")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["shorts_dark"])


def headphones(mats):
    """Big headphones resting round the neck: the band behind the neck over the hood's rim, the cups on the collarbones
    facing up and out, a glowing mint ring on each cup's face."""
    dark, soft, rings = [], [], []
    arc = []
    for a in np.linspace(-1, 1, 15):
        t = a * math.pi * 0.56
        arc.append((math.sin(t) * 0.100, 0.024 + math.cos(t) * 0.070, 1.424 + 0.020 * math.cos(t)))
    dark.append(lib.loft([dict(c=q, rx=0.012, ry=0.007, p=2.6) for q in arc], n=14, sub=3, up=(0, 0, 1), name="band"))
    for s in (1, -1):
        c = np.array([s * 0.102, -0.030, 1.414])
        axis = np.array([s * 0.55, -0.45, 0.70])
        axis /= np.linalg.norm(axis)
        up = np.cross(axis, [0, 1.0, 0])
        up = tuple(up / np.linalg.norm(up))
        dark.append(lib.loft([dict(c=c - axis * 0.012, rx=0.036, ry=0.036, p=2.2), dict(c=c, rx=0.042, ry=0.042, p=2.2), dict(c=c + axis * 0.013, rx=0.040, ry=0.040, p=2.2)], n=28, sub=3, up=up, name="cup"))
        soft.append(lib.loft([dict(c=c - axis * 0.028, rx=0.033, ry=0.033, p=2.0), dict(c=c - axis * 0.014, rx=0.039, ry=0.039, p=2.0)], n=28, sub=3, up=up, name="pad"))
        ring = lib.loft([dict(c=c + axis * 0.0135, rx=0.031, ry=0.031, p=2.0), dict(c=c + axis * 0.0165, rx=0.026, ry=0.026, p=2.0)], n=32, sub=2, up=up, caps=False, name="ring")
        rings.append(lib.solidify(ring, 0.004, offset=0.0))
        # The yoke from the cup's outer side up to the band's end.
        dark.append(lib.capsule(c + np.array([s * 0.030, 0.012, 0.010]), np.array(arc[0 if s < 0 else -1]), 0.0058, name="yoke"))
    hp = lib.join(dark, "Headphones")
    lib.shade_smooth(hp)
    lib.assign(hp, mats["phones"])
    pads = lib.join(soft, "EarPads")
    lib.shade_smooth(pads)
    lib.assign(pads, mats["pads"])
    glow = lib.join(rings, "PhoneRings")
    lib.shade_smooth(glow)
    lib.assign(glow, mats["glow"])
    return hp, pads, glow


# ---------------------------------------------------------------- the hair: a bob with bangs


def bob_specs():
    """Locks for a jaw-length bob (the crown has its own, `crown_specs`): blunt bangs to the brows; the sides lie on the
    head only to its widest point and fall straight from there past the cheeks, cut straight and tucked in a little; the
    back rounds down to the nape. (theta, phi, length, width, thickness, direction, bend, flick, lift, options)."""
    S = []
    down = np.array([0, 0, -1.0])
    back = np.array([0, 1.0, 0])
    fwd = np.array([0, -1.0, 0])
    radial = hairmod.radial
    bangs = [(-50, 0.116, 0.052), (-36, 0.110, 0.056), (-22, 0.104, 0.058), (-8, 0.100, 0.058), (6, 0.098, 0.058), (20, 0.104, 0.058), (34, 0.110, 0.056), (48, 0.116, 0.052)]
    for k, (th, L, W) in enumerate(bangs):
        d = down + fwd * 0.34 + np.array([th / 60.0, 0, 0]) * 0.30
        S.append((th, 48 - abs(th) * 0.10, L, W, 0.014, d, 0.10, 0.0, (k % 2) * 0.0012, dict(blunt=0.62, uv=0.82)))
    side = dict(follow=0.34, blunt=0.70)
    for s in (1, -1):
        # In front of the ear (framing the face, the longest), over it, and behind it.
        S.append((s * 62, 36, 0.214, 0.054, 0.015, down + fwd * 0.10, 0.30, -0.18, 0.0, dict(follow=0.30, blunt=0.66)))
        S.append((s * 74, 32, 0.204, 0.060, 0.015, down + radial(s * 74) * 0.04 + fwd * 0.04, 0.30, -0.24, 0.0012, side))
        S.append((s * 86, 30, 0.198, 0.064, 0.016, down + radial(s * 86) * 0.04, 0.30, -0.28, 0.0, side))
        S.append((s * 98, 30, 0.192, 0.066, 0.016, down + radial(s * 98) * 0.04 + back * 0.04, 0.30, -0.30, 0.0012, side))
    nape = dict(follow=0.46, blunt=0.70)
    for th, ph, L in ((112, 32, 0.190), (-112, 32, 0.190), (128, 34, 0.186), (-128, 34, 0.186), (146, 36, 0.182), (-146, 36, 0.182), (164, 38, 0.180),
                      (-164, 38, 0.180), (180, 38, 0.180)):
        S.append((th, ph, L, 0.070, 0.017, down + radial(th) * 0.05, 0.30, -0.36, 0.0012, nape))
    for th, ph, L in ((120, 10, 0.140), (-120, 10, 0.140), (138, 12, 0.136), (-138, 12, 0.136), (156, 12, 0.134), (-156, 12, 0.134), (172, 12, 0.132), (-172, 12, 0.132)):
        S.append((th, ph, L, 0.066, 0.015, down + radial(th) * 0.04, 0.25, -0.30, 0.0, nape))
    for th in (106, -106, 122, -122, 140, -140, 158, -158, 176):
        S.append((th, -12, 0.084, 0.056, 0.013, down + radial(th) * 0.06, 0.0, -0.20, 0.0, dict(blunt=0.66)))
    return S


def crown_specs():
    """The top: smooth locks from the whorl lying on the head all their length (no spikes); the bob's locks below take
    over where they end."""
    w = hairmod.unit(*hairmod.WHORL)
    a1 = np.cross(w, [0, 0, 1.0])
    a1 /= np.linalg.norm(a1)
    a2 = np.cross(w, a1)
    S = []
    rings = ((6, 3, 0.120, 0.078), (16, 6, 0.132, 0.080), (30, 9, 0.140, 0.084), (46, 12, 0.140, 0.084), (62, 14, 0.130, 0.080))
    for ri, (alpha, count, L, W) in enumerate(rings):
        for k in range(count):
            beta = 2 * math.pi * (k + 0.5 * (ri % 2)) / count
            al = math.radians(alpha)
            r = w * math.cos(al) + (a1 * math.cos(beta) + a2 * math.sin(beta)) * math.sin(al)
            theta = math.degrees(math.atan2(r[0], -r[1]))
            phi = math.degrees(math.asin(max(-1, min(1, r[2]))))
            if phi < 28:
                continue
            away = r - w * np.dot(r, w)
            away /= np.linalg.norm(away) + 1e-9
            d = away + np.array([0, 0, -0.30]) * (alpha / 62.0)
            lift = (len(rings) - ri) * 0.0019 + (k % 2) * 0.0011
            front = abs(((theta + 180) % 360) - 180) < 60
            length = L * (0.70 if front else 1.0) * (0.94 + 0.12 * ((k * 7) % 5) / 4)
            S.append((theta, phi, length, W, 0.016, d, 0.10, 0.0, lift, dict(follow=1.0, uv=0.5)))
    return S


def hair_image(size=(64, 512)):
    """Along a lock: deep blue-black at the root, mint at the tip (the house colour), a soft shine band."""
    w, h = size
    v = (np.arange(h) + 0.5) / h  # 0 at the root
    root = np.array([0.13, 0.14, 0.22])
    mid = np.array([0.20, 0.22, 0.34])
    tip = np.array([0.40, 0.88, 0.74])
    col = np.zeros((h, 3))
    for i, t in enumerate(v):
        if t < 0.64:
            k = (t / 0.64) ** 1.2
            c = root * (1 - k) + mid * k
        else:
            k = ((t - 0.64) / 0.36) ** 1.3
            c = mid * (1 - k) + tip * k
        band = math.exp(-((t - 0.28) / 0.05) ** 2) * 0.10
        col[i] = np.clip(c + band, 0, 1)
    img = np.ones((h, w, 4))
    img[..., :3] = col[::-1][:, None, :]
    return lib.image_from_array("hair_mira", img)
