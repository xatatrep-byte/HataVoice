"""«Кай»: the third hero, a street-style guy to stand beside «Мира»: a black bomber jacket with ribbed collar, hem and
cuffs (an orange stripe in each), a zip and a mint patch on the sleeve; grey cargo trousers with pockets on the thighs;
black high-top sneakers on white soles; an orange beanie with a folded cuff over short dark hair. The skeleton, the face
and its expressions are «Рэн»'s (`body`, `head`, `rig`), so every motion and emote of the app fits him at once.

Sizes in metres, facing -Y, left at +X, the same joints as `body`.
"""
import math

import numpy as np

import body
import hair as hairmod
import lib

# Where the clothes end: the jacket's hem (z) and its cuffs (|x|).
JACKET_HEM = 1.0
CUFF_X = 0.655

# ---------------------------------------------------------------- the body


def torso():
    """«Рэн»'s build; above the hem the surface is the bomber itself: full over the chest and back, bloused a little over
    its ribbed hem."""
    keys = [
        dict(c=(0, 0.004, 0.83), rx=0.112, ry=0.086, p=2.2),
        dict(c=(0, 0.010, 0.89), rx=0.157, ry=0.101, p=2.4),
        dict(c=(0, 0.009, 0.95), rx=0.160, ry=0.100, p=2.4),
        dict(c=(0, 0.006, 1.00), rx=0.152, ry=0.096, p=2.4),
        dict(c=(0, 0.004, 1.05), rx=0.163, ry=0.105, p=2.4),
        dict(c=(0, 0.000, 1.11), rx=0.166, ry=0.107, p=2.4),
        dict(c=(0, -0.004, 1.18), rx=0.170, ry=0.109, p=2.5),
        dict(c=(0, -0.006, 1.25), rx=0.176, ry=0.109, p=2.6),
        dict(c=(0, -0.004, 1.30), rx=0.180, ry=0.104, p=2.7),
        dict(c=(0, 0.000, 1.343), rx=0.176, ry=0.095, p=2.8),
        dict(c=(0, 0.004, 1.381), rx=0.132, ry=0.075, p=2.5),
        dict(c=(0, 0.008, 1.412), rx=0.060, ry=0.057, p=2.0),
        dict(c=(0, 0.010, 1.47), rx=0.051, ry=0.052, p=2.0),
    ]
    return lib.loft(keys, n=40, sub=4, up=(1, 0, 0), name="torso")


def arm(side):
    """A puffy sleeve gathered into the cuff, then the wrist."""
    s = 1 if side == "L" else -1
    y, z = body.ARM_Y, body.SHOULDER_Z
    keys = [
        dict(c=(s * 0.095, y, z - 0.004), rx=0.067, ry=0.063),
        dict(c=(s * 0.165, y, z), rx=0.066, ry=0.061, p=2.1),
        dict(c=(s * 0.215, y, z - 0.002), rx=0.060, ry=0.058),
        dict(c=(s * 0.290, y - 0.002, z - 0.003), rx=0.057, ry=0.055),
        dict(c=(s * 0.370, y, z - 0.002), rx=0.054, ry=0.053),
        dict(c=(s * 0.440, y + 0.002, z), rx=0.052, ry=0.052),
        dict(c=(s * 0.520, y, z), rx=0.053, ry=0.053),
        dict(c=(s * 0.595, y, z), rx=0.050, ry=0.051),
        dict(c=(s * 0.632, y, z), rx=0.040, ry=0.043),
        dict(c=(s * 0.668, y, z), rx=0.025, ry=0.030),
        dict(c=(s * 0.700, y, z), rx=0.022, ry=0.030),
        dict(c=(s * 0.722, y, z), rx=0.021, ry=0.031),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"arm{side}")


def leg(side):
    """A cargo trouser leg: roomy, straight, bunching over the high-top."""
    s = 1 if side == "L" else -1
    keys = [
        dict(c=(s * 0.078, 0.008, 0.965), rx=0.088, ry=0.096),
        dict(c=(s * 0.094, 0.004, 0.86), rx=0.094, ry=0.100),
        dict(c=(s * 0.099, 0.000, 0.73), rx=0.087, ry=0.093),
        dict(c=(s * 0.099, -0.002, 0.61), rx=0.079, ry=0.085),
        dict(c=(s * 0.098, -0.004, 0.51), rx=0.073, ry=0.079),
        dict(c=(s * 0.098, 0.000, 0.43), rx=0.073, ry=0.079),
        dict(c=(s * 0.097, 0.003, 0.34), rx=0.069, ry=0.075),
        dict(c=(s * 0.096, 0.006, 0.26), rx=0.066, ry=0.071),
        dict(c=(s * 0.095, 0.008, 0.200), rx=0.062, ry=0.067),
        dict(c=(s * 0.094, 0.010, 0.160), rx=0.052, ry=0.057),
        dict(c=(s * 0.094, 0.012, 0.10), rx=0.036, ry=0.040),
        dict(c=(s * 0.094, 0.012, 0.07), rx=0.033, ry=0.038),
    ]
    return lib.loft(keys, n=32, sub=4, up=(1, 0, 0), name=f"leg{side}")


def body_mesh():
    parts = [torso(), arm("L"), arm("R"), leg("L"), leg("R")]
    ob = lib.join(parts, "body")
    ob = lib.remesh(ob, 0.0065, smooth_iter=6, smooth_factor=0.6)
    ob = lib.decimate(ob, 0.32)
    lib.shade_smooth(ob)
    return ob


def zone_body(ob, mats):
    """Skin, jacket or trousers for each face of the fused body."""
    me = ob.data
    order = [mats["skin"], mats["jacket"], mats["pants"]]
    me.materials.clear()
    for m in order:
        me.materials.append(m)
    idx = []
    for p in me.polygons:
        x, y, z = p.center
        ax = abs(x)
        if ax > CUFF_X + 0.01:
            k = 0
        elif z < JACKET_HEM and ax < 0.30:
            k = 2
        elif z > 1.41 and ax < 0.07:
            k = 0
        else:
            k = 1
        idx.append(k)
    me.polygons.foreach_set("material_index", idx)
    me.update()


# ---------------------------------------------------------------- shoes


def sneaker(side):
    """The shoe below the ankle (rings: u up = height, v across = width)."""
    s = 1 if side == "L" else -1
    x = body.LEG_X
    keys = [
        dict(c=(s * x, 0.054, 0.062), rx=0.044, ry=0.034, p=2.3),
        dict(c=(s * x, 0.034, 0.074), rx=0.056, ry=0.041, p=2.4),
        dict(c=(s * x, 0.004, 0.078), rx=0.058, ry=0.045, p=2.5),
        dict(c=(s * (x + 0.003), -0.048, 0.062), rx=0.044, ry=0.049, p=2.6),
        dict(c=(s * (x + 0.004), -0.098, 0.052), rx=0.034, ry=0.050, p=2.7),
        dict(c=(s * (x + 0.004), -0.138, 0.047), rx=0.028, ry=0.047, p=2.6),
        dict(c=(s * (x + 0.003), -0.164, 0.045), rx=0.021, ry=0.036, p=2.3),
        dict(c=(s * (x + 0.002), -0.176, 0.044), rx=0.012, ry=0.020, p=2.1),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"sneaker{side}")


def high_top(side):
    """The high-top's collar round the ankle, up to the trousers."""
    s = 1 if side == "L" else -1
    x = body.LEG_X
    keys = [dict(c=(s * x, 0.012, 0.080), rx=0.050, ry=0.058, p=2.3), dict(c=(s * x, 0.012, 0.130), rx=0.047, ry=0.054, p=2.3), dict(c=(s * x, 0.012, 0.168), rx=0.049, ry=0.055, p=2.3)]
    return lib.loft(keys, n=28, sub=3, up=(1, 0, 0), name=f"collar{side}")


def sole(side):
    s = 1 if side == "L" else -1
    x = body.LEG_X
    keys = [
        dict(c=(s * x, 0.064, 0.019), rx=0.019, ry=0.034, p=3.0),
        dict(c=(s * x, 0.038, 0.018), rx=0.020, ry=0.045, p=3.2),
        dict(c=(s * (x + 0.002), -0.020, 0.017), rx=0.019, ry=0.051, p=3.2),
        dict(c=(s * (x + 0.004), -0.100, 0.017), rx=0.019, ry=0.053, p=3.2),
        dict(c=(s * (x + 0.003), -0.160, 0.019), rx=0.017, ry=0.044, p=2.8),
        dict(c=(s * (x + 0.002), -0.184, 0.023), rx=0.011, ry=0.024, p=2.3),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"sole{side}")


def toe_cap(side):
    """The white rubber toe of a canvas high-top."""
    s = 1 if side == "L" else -1
    x = body.LEG_X
    return lib.ellipsoid((s * (x + 0.003), -0.150, 0.040), (0.046, 0.034, 0.026), name=f"toe{side}", n=24)


def laces(mats):
    parts = []
    for s in (1, -1):
        x = s * body.LEG_X
        for k, (y, z) in enumerate(((-0.010, 0.150), (-0.020, 0.125), (-0.034, 0.104), (-0.054, 0.090), (-0.076, 0.080))):
            w = 0.024 - k * 0.0015
            parts.append(lib.capsule((x - w, y - 0.034, z), (x + w, y - 0.036, z + 0.002), 0.0036, name="lace"))
    ob = lib.join(parts, "Laces")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["lace"])


# ---------------------------------------------------------------- the jacket and the trousers on top


def _front(surf, x, z, offset):
    return surf.project((x, -0.3, z), (0, 1, 0), offset)


def _side(surf, s, y, z, offset):
    return surf.project((s * 0.4, y, z), (-s, 0, 0), offset)


def _sheet(points_grid, name):
    """A sheet through a grid of points (rows × columns)."""
    rows, cols = len(points_grid), len(points_grid[0])
    verts = [p for row in points_grid for p in row]
    faces = [[j * cols + i, j * cols + i + 1, (j + 1) * cols + i + 1, (j + 1) * cols + i] for j in range(rows - 1) for i in range(cols - 1)]
    return lib.mesh_object(name, np.array(verts), faces)


def jacket_parts(surf, mats):
    """The ribs (collar, hem, cuffs) with an orange stripe each, the zip down the front with its pull, the mint patch on
    the left sleeve."""
    ribs, stripes = [], []
    hem = lib.loft([dict(c=(0, 0.007, JACKET_HEM - 0.012), rx=0.158, ry=0.100, p=2.4), dict(c=(0, 0.006, JACKET_HEM + 0.030), rx=0.160, ry=0.102, p=2.4)], n=48, sub=3, up=(1, 0, 0), caps=False, name="hem")
    ribs.append(lib.solidify(hem, 0.008, offset=0.0))
    stripes.append(lib.solidify(lib.loft([dict(c=(0, 0.007, JACKET_HEM + 0.006), rx=0.163, ry=0.105, p=2.4), dict(c=(0, 0.007, JACKET_HEM + 0.014), rx=0.163, ry=0.105, p=2.4)], n=48, sub=2, up=(1, 0, 0), caps=False, name="hstripe"), 0.004, offset=0.0))
    collar = lib.loft([dict(c=(0, 0.004, 1.376), rx=0.090, ry=0.082, p=2.2), dict(c=(0, 0.006, 1.402), rx=0.073, ry=0.069, p=2.2), dict(c=(0, 0.008, 1.425), rx=0.066, ry=0.062, p=2.2)], n=40, sub=3, up=(1, 0, 0), caps=False, name="collar")
    ribs.append(lib.solidify(collar, 0.009, offset=0.0))
    stripes.append(lib.solidify(lib.loft([dict(c=(0, 0.007, 1.405), rx=0.075, ry=0.071, p=2.2), dict(c=(0, 0.007, 1.411), rx=0.073, ry=0.069, p=2.2)], n=40, sub=2, up=(1, 0, 0), caps=False, name="cstripe"), 0.004, offset=0.0))
    for s in (1, -1):
        y, z = body.ARM_Y, body.SHOULDER_Z
        cuff = lib.loft([dict(c=(s * (CUFF_X - 0.030), y, z), rx=0.040, ry=0.043), dict(c=(s * (CUFF_X + 0.012), y, z), rx=0.031, ry=0.035)], n=28, sub=3, up=(0, 0, 1), caps=False, name="cuff")
        ribs.append(lib.solidify(cuff, 0.007, offset=0.0))
        stripes.append(lib.solidify(lib.loft([dict(c=(s * (CUFF_X - 0.012), y, z), rx=0.039, ry=0.042), dict(c=(s * (CUFF_X - 0.005), y, z), rx=0.037, ry=0.040)], n=28, sub=2, up=(0, 0, 1), caps=False, name="kstripe"), 0.004, offset=0.0))
    rib = lib.join(ribs, "Rib")
    lib.shade_smooth(rib)
    lib.assign(rib, mats["rib"])
    stripe = lib.join(stripes, "Stripes")
    lib.shade_smooth(stripe)
    lib.assign(stripe, mats["stripe"])

    # The zip: a narrow metal track down the middle, and its pull just under the collar.
    track = [[_front(surf, x, z, 0.004)[0] for x in (-0.006, 0.0, 0.006)] for z in np.linspace(JACKET_HEM + 0.03, 1.385, 16)]
    zip_ob = lib.solidify(_sheet(track, "Zip"), 0.003, offset=0.0)
    top, _n = _front(surf, 0.0, 1.372, 0.008)
    pull = lib.capsule(top, top + np.array([0.004, -0.006, -0.026]), 0.0055, name="pull")
    zipper = lib.join([zip_ob, pull], "Zipper")
    lib.shade_smooth(zipper)
    lib.assign(zipper, mats["metal"])

    # The patch: a mint disc on the front of the left upper arm.
    ring = []
    for r in np.linspace(0.0, 0.030, 4):
        row = []
        for a in np.linspace(0, 2 * math.pi, 25):
            p, _n = surf.project((0.29 + r * math.cos(a), -0.3, body.SHOULDER_Z + 0.006 + r * math.sin(a)), (0, 1, 0), 0.004)
            row.append(p)
        ring.append(row)
    patch = lib.solidify(_sheet(ring, "Patch"), 0.004, offset=0.0)
    lib.shade_smooth(patch)
    lib.assign(patch, mats["patch"])
    return rib, stripe, zipper, patch


def cargo_pockets(surf, mats):
    """A pocket with a flap on the outside of each thigh."""
    parts = []
    for s in (1, -1):
        grid = [[_side(surf, s, y, z, 0.006)[0] for y in np.linspace(-0.048, 0.044, 7)] for z in np.linspace(0.600, 0.715, 7)]
        parts.append(lib.solidify(_sheet(grid, "pocket"), 0.007, offset=0.0))
        flap = [[_side(surf, s, y, z, 0.013)[0] for y in np.linspace(-0.052, 0.048, 7)] for z in np.linspace(0.700, 0.738, 3)]
        parts.append(lib.solidify(_sheet(flap, "flap"), 0.006, offset=0.0))
    ob = lib.join(parts, "Pockets")
    lib.shade_smooth(ob)
    return lib.assign(ob, mats["pants_dark"])


# ---------------------------------------------------------------- the beanie and the hair under it


def _beanie_line(theta):
    """Where the beanie's edge sits round the head (z), by azimuth: over the brows in front, low behind the ears."""
    a = abs(((theta + 180) % 360) - 180)
    pts = [(0, 1.662), (40, 1.652), (75, 1.612), (100, 1.580), (140, 1.548), (180, 1.536)]
    xs, zs = zip(*pts)
    return float(np.interp(a, xs, zs))


def beanie(skull_ob, mats):
    """The skull grown well over the hair above the line, slouching a little up and back at the top, and a folded cuff
    round its edge: a smooth ring that follows the line (cut out of the skull's faces, its edges would be staircases)."""
    co, faces = lib.object_arrays(skull_ob)
    c = hairmod.CENTER

    def theta_of(p):
        return math.degrees(math.atan2(p[0], -(p[1] - c[1])))

    d = co - c
    grown = c + d * 1.18
    top = np.clip((grown[:, 2] - 1.67) / 0.09, 0, None)
    grown[:, 2] += 0.018 * top ** 1.4
    grown[:, 1] += 0.012 * top ** 1.2
    # Its cut edge is a staircase of the skull's faces, hidden under the cuff.
    dome = lib.mesh_object("Dome", grown, faces)
    lib.delete_faces(dome, lambda center, n: center[2] < _beanie_line(theta_of(center)) - 0.030)
    lib.shade_smooth(dome)
    lib.assign(dome, mats["beanie"])

    # The cuff: round the head at the line, as far out as the dome there plus its own thickness.
    skull = hairmod.Skull(skull_ob)
    from mathutils import Vector

    path = []
    for a in np.linspace(0, 360, 37)[:-1]:
        z = _beanie_line(a) - 0.026
        r = math.radians(a)
        out = np.array([math.sin(r), -math.cos(r), 0.0])
        hit, _n, _i, _dd = skull.tree.ray_cast(Vector((0, c[1], z)) + Vector(out) * 0.3, Vector(-out), 0.5)
        at = np.array(hit) if hit is not None else np.array([0, c[1], z]) + out * 0.09
        path.append(at + out * 0.021)
    path = path + path[:3]
    keys = [dict(c=p, rx=0.027, ry=0.009, p=2.8) for p in path]
    cuff = lib.loft(keys, n=16, sub=3, up=(0, 0, 1), name="Cuff")
    lib.shade_smooth(cuff)
    lib.assign(cuff, mats["beanie_cuff"])

    # A small mint label on the cuff's front.
    p, _n = lib.Surface(cuff).project((0.035, -0.4, _beanie_line(0) - 0.026), (0, 1, 0), 0.002)
    label = lib.ellipsoid(p, (0.016, 0.004, 0.009), name="Label", n=16)
    lib.assign(label, mats["patch"])
    return dome, cuff, label


def short_specs():
    """Short hair showing under the beanie: a fringe swept to his right out from under the cuff, short sides over the
    ears, and a short nape below the cuff at the back (lying on the head: an undercut has no flicks)."""
    S = []
    down = np.array([0, 0, -1.0])
    fwd = np.array([0, -1.0, 0])
    back = np.array([0, 1.0, 0])
    radial = hairmod.radial
    lie = dict(follow=0.95, blunt=0.55)
    for k, (th, L, W) in enumerate(((-46, 0.080, 0.050), (-30, 0.088, 0.054), (-14, 0.092, 0.056), (2, 0.092, 0.056), (18, 0.086, 0.054), (34, 0.078, 0.050), (50, 0.068, 0.046))):
        d = down * 0.8 + fwd * 0.45 + np.array([-0.55, 0, 0])
        S.append((th, 30, L, W, 0.013, d, 0.10, 0.25, (k % 2) * 0.0012))
    for s in (1, -1):
        S.append((s * 70, 18, 0.064, 0.050, 0.012, down + fwd * 0.12, 0.05, 0.08, 0.0, lie))
        S.append((s * 86, 12, 0.060, 0.054, 0.012, down + radial(s * 86) * 0.04, 0.05, 0.08, 0.0012, lie))
        S.append((s * 102, 6, 0.064, 0.056, 0.012, down + back * 0.10, 0.05, 0.08, 0.0, lie))
    for th in (114, -114, 130, -130, 148, -148, 165, -165, 180):
        S.append((th, -6, 0.098, 0.070, 0.012, down + radial(th) * 0.04, 0.0, 0.0, 0.0012 * (abs(th) % 2), lie))
    for th in (122, -122, 140, -140, 158, -158, 176):
        S.append((th, -24, 0.064, 0.064, 0.011, down + radial(th) * 0.03, 0.0, 0.0, 0.0, lie))
    return S


def hair_image(size=(64, 512)):
    """Dark brown, a little lighter toward the tips, a soft shine band."""
    w, h = size
    v = (np.arange(h) + 0.5) / h
    root = np.array([0.17, 0.12, 0.10])
    tip = np.array([0.33, 0.24, 0.18])
    col = np.zeros((h, 3))
    for i, t in enumerate(v):
        c = root * (1 - t) + tip * t
        band = math.exp(-((t - 0.32) / 0.06) ** 2) * 0.08
        col[i] = np.clip(c + band, 0, 1)
    img = np.ones((h, w, 4))
    img[..., :3] = col[::-1][:, None, :]
    return lib.image_from_array("hair_kai", img)

