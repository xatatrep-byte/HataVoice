"""Hair: a cap over the skull and locks — flattened tapering tubes that start under the cap, follow a direction, bend with
gravity, curl at the tip and never go into the head. A short ponytail on its own chain of bones swings."""
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import lib

CENTER = np.array([0.0, 0.010, 1.598])


class Skull:
    def __init__(self, ob):
        co, faces = lib.object_arrays(ob)
        self.tree = BVHTree.FromPolygons([tuple(v) for v in co], faces)

    def root(self, theta, phi):
        """The point of the skull seen from its centre at azimuth theta (0 front, + toward the left) and elevation phi."""
        t, p = math.radians(theta), math.radians(phi)
        d = Vector((math.sin(t) * math.cos(p), -math.cos(t) * math.cos(p), math.sin(p)))
        hit, normal, _i, _d = self.tree.ray_cast(Vector(CENTER) + d * 0.3, -d, 0.5)
        return np.array(hit), np.array(normal.normalized())

    def nearest(self, p):
        loc, normal, _i, _dist = self.tree.find_nearest(Vector(p))
        return np.array(loc), np.array(normal.normalized())

    def push_out(self, p, margin):
        loc, normal = self.nearest(p)
        d = p - loc
        if np.dot(d, normal) < margin:
            return loc + normal * margin
        return p


def lock_path(skull, root, normal, direction, length, bend, flick, steps=10, margin=(0.0075, 0.012), side=None, follow=0.68):
    """A lock lies on the head for the first `follow` of its length (bending with it, a few millimetres off), then
    leaves it: its tip falls with gravity and curls out by `flick`. Under the skull it hangs free."""
    direction = np.asarray(direction, float)
    direction /= np.linalg.norm(direction)
    pts = [root - normal * 0.006]
    p = root.copy() + normal * margin[0]
    pts.append(p.copy())
    d = direction - normal * np.dot(direction, normal)
    d /= np.linalg.norm(d) + 1e-9
    step = length / steps
    g = np.array([0, 0, -1.0])
    for i in range(steps):
        t = (i + 1) / steps
        target = direction * (1 - bend * t) + g * bend * t
        _loc, n = skull.nearest(p)
        hug = t <= follow and n[2] > -0.35
        if hug:
            target = target - n * np.dot(target, n)
        elif flick:
            # Off the head: the tip curls away from it (flick > 0) or in (flick < 0).
            k = (t - follow) / max(1e-3, 1 - follow)
            target = target + n * flick * k * 1.4
        target /= np.linalg.norm(target) + 1e-9
        d = d * 0.5 + target * 0.5
        d /= np.linalg.norm(d)
        p = p + d * step
        m = margin[0] + (margin[1] - margin[0]) * t
        if hug:
            loc, n = skull.nearest(p)
            p = loc + n * m
        else:
            p = skull.push_out(p, m)
        pts.append(p.copy())
    return np.array(pts)


def lock_mesh(path, width, thick, normal, name, n=8, root_swell=1.0, blunt=0.0):
    """A lock along `path`: wide across the head, thin off it, pointed at the tip — or cut straight across at
    `blunt` of its width (a bob's ends)."""
    m = len(path)
    t = np.linspace(0, 1, m)
    keys = []
    tang = np.gradient(path, axis=0)
    for i in range(m):
        ti = t[i]
        # Wide for most of its length, tapering to a point only toward the tip, a little fuller just off the root.
        w = width * (1 - ti ** 1.7) ** 0.85 * (0.82 + 0.18 * min(1.0, ti * 5)) * root_swell
        h = thick * (1 - ti ** 1.4) ** 0.7 * (0.85 + 0.15 * min(1.0, ti * 5))
        if blunt:
            w = width * max(blunt, (1 - ti ** 6) ** 0.5) * (0.82 + 0.18 * min(1.0, ti * 5)) * root_swell
            h = thick * max(0.5, (1 - ti ** 6) ** 0.5)
        elif i == m - 1:
            w, h = width * 0.02, thick * 0.03
        keys.append(dict(c=path[i], rx=max(w / 2, 1e-4), ry=max(h / 2, 1e-4), p=2.0))
    # The ring's wide side lies across the head: u = tangent × normal.
    t0 = tang[1] / np.linalg.norm(tang[1])
    side = np.cross(t0, normal)
    if np.linalg.norm(side) < 1e-6:
        side = np.array([1.0, 0, 0])
    side /= np.linalg.norm(side)
    ob = lib.loft(keys, n=n, sub=1, up=tuple(side), caps=True, name=name, uv=True)
    return ob


def radial(theta):
    t = math.radians(theta)
    return np.array([math.sin(t), -math.cos(t), 0.0])


# (theta, phi, length, width, thickness, direction, bend, flick)
def lock_specs():
    S = []
    down = np.array([0, 0, -1.0])
    back = np.array([0, 1.0, 0])
    fwd = np.array([0, -1.0, 0])
    up = np.array([0, 0, 1.0])
    # Bangs: nine locks of different lengths fanning over the forehead, stopping at the brows.
    bangs = [(-54, 0.130, 0.046, 0.25), (-40, 0.120, 0.050, 0.10), (-26, 0.110, 0.052, -0.05), (-12, 0.104, 0.052, 0.15), (2, 0.098, 0.050, 0.05),
             (15, 0.108, 0.052, 0.20), (28, 0.114, 0.052, -0.05), (41, 0.122, 0.049, 0.10), (55, 0.132, 0.046, 0.25)]
    for th, L, W, fl in bangs:
        d = down + fwd * 0.32 + np.array([th / 60.0, 0, 0]) * 0.55
        S.append((th, 47 - abs(th) * 0.12, L, W, 0.014, d, 0.10, fl))
    # A longer lock falling between the eyes, and short spikes over the bangs for depth.
    S.append((-5, 50, 0.120, 0.036, 0.012, down + fwd * 0.30 + np.array([0.12, 0, 0]), 0.05, 0.1))
    # Sides, in front of the ears and over them.
    for s in (1, -1):
        S.append((s * 68, 32, 0.138, 0.046, 0.013, down + np.array([s * 0.16, 0, 0]) + fwd * 0.14, 0.05, 0.15))
        S.append((s * 84, 27, 0.130, 0.052, 0.014, down + radial(s * 84) * 0.22 + back * 0.12, 0.05, 0.25))
        S.append((s * 101, 23, 0.124, 0.056, 0.014, down + radial(s * 101) * 0.28 + back * 0.25, 0.05, 0.35))
    # Behind the ears, low.
    for th in (104, -104, 124, -124):
        S.append((th, -20, 0.080, 0.048, 0.013, down + radial(th) * 0.10, 0.0, 0.2))
    # The back: down and out, tips flicking out.
    for th, ph, L in ((122, 34, 0.126), (-122, 34, 0.126), (150, 36, 0.134), (-150, 36, 0.134), (180, 38, 0.130), (136, 10, 0.118), (-136, 10, 0.118),
                      (163, 12, 0.122), (-163, 12, 0.122), (110, 6, 0.110), (-110, 6, 0.110)):
        d = down + radial(th) * 0.40 + back * 0.30
        S.append((th, ph, L, 0.060, 0.016, d, 0.08, 0.45))
    # The nape and behind the ears: down to the neck, so no skin shows over the scarf.
    for th in (118, -118, 132, -132, 147, -147, 162, -162, 177):
        S.append((th, -14, 0.104, 0.050, 0.013, down + radial(th) * 0.16, 0.0, 0.28))
    for th in (100, -100, 112, -112):
        S.append((th, -4, 0.100, 0.046, 0.013, down + radial(th) * 0.12 + back * 0.1, 0.0, 0.22))
    return S


WHORL = (168.0, 70.0)


def unit(theta, phi):
    t, p = math.radians(theta), math.radians(phi)
    return np.array([math.sin(t) * math.cos(p), -math.cos(t) * math.cos(p), math.sin(p)])


def whorl_specs():
    """The top: locks radiating from the whorl at the back of the crown, like shingles, each flowing away from it."""
    w = unit(*WHORL)
    # Two axes round the whorl.
    a1 = np.cross(w, [0, 0, 1.0])
    a1 /= np.linalg.norm(a1)
    a2 = np.cross(w, a1)
    S = []
    rings = ((4, 2, 0.115, 0.074), (12, 4, 0.125, 0.076), (28, 8, 0.142, 0.084), (46, 11, 0.150, 0.084), (64, 13, 0.140, 0.078))
    for ri, (alpha, count, L, W) in enumerate(rings):
        for k in range(count):
            beta = 2 * math.pi * (k + 0.5 * (ri % 2)) / count
            al = math.radians(alpha)
            r = w * math.cos(al) + (a1 * math.cos(beta) + a2 * math.sin(beta)) * math.sin(al)
            theta = math.degrees(math.atan2(r[0], -r[1]))
            phi = math.degrees(math.asin(max(-1, min(1, r[2]))))
            # Only the top: the bangs, sides and back have their own locks below.
            if phi < 28:
                continue
            away = r - w * np.dot(r, w)
            away /= np.linalg.norm(away) + 1e-9
            d = away + np.array([0, 0, -0.25]) * (alpha / 68.0)
            # Locks heading forward come down onto the forehead less steeply (the bangs take over there).
            # Shingles: a ring nearer the whorl lies over the next one, neighbours in a ring a hair apart.
            lift = (len(rings) - ri) * 0.0019 + (k % 2) * 0.0011
            S.append((theta, phi, L * (0.92 + 0.16 * ((k * 7) % 5) / 4), W, 0.017, d, 0.30, 0.10 + 0.06 * ((k * 3) % 3), lift))
    return S


def build(skull_ob, mats, specs=None, crown=None):
    """The locks (`specs`, «Рэн»'s by default), the crown's locks from the whorl (`crown`, «Рэн»'s spiky ones by default)
    and the cap under them."""
    skull = Skull(skull_ob)
    locks = []
    for k, spec in enumerate((lock_specs() if specs is None else specs) + (whorl_specs() if crown is None else crown)):
        th, ph, L, W, T, d, bend, flick = spec[:8]
        lift = spec[8] if len(spec) > 8 else (k % 2) * 0.0012
        # Optional per lock: how much of it lies on the head (`follow`) and a straight-cut end (`blunt`).
        opts = spec[9] if len(spec) > 9 else {}
        root, normal = skull.root(th, ph)
        side = np.cross(np.asarray(d, float), normal)
        front = abs(((th + 180) % 360) - 180) < 62 and ph < 64
        if front:
            # Bangs hang a little off the forehead and fall straight, with no curl at the tip.
            path = lock_path(skull, root, normal, d, L, bend, flick * 0.2, side=side, margin=(0.009 + lift, 0.017 + lift), follow=opts.get("follow", 0.9))
        else:
            path = lock_path(skull, root, normal, d, L, bend, flick * 0.35, side=side, margin=(0.0075 + lift, 0.012 + lift), follow=opts.get("follow", 0.78))
        lock = lock_mesh(path, W, T, normal, f"lock{k}", blunt=opts.get("blunt", 0.0))
        if "uv" in opts:
            # Only the first part of the colour along a lock (a crown lock ending on the head keeps the root's colour).
            for loop in lock.data.uv_layers.active.data:
                loop.uv = (loop.uv[0], loop.uv[1] * opts["uv"])
        locks.append(lock)
    hair = lib.join(locks, "Hair")
    lib.shade_smooth(hair)
    lib.assign(hair, mats["hair"])

    cap = cap_mesh(skull_ob)
    lib.assign(cap, mats["hair"])
    return hair, cap


def hairline(theta):
    """How high the hair starts round the head (z), by azimuth."""
    a = abs(((theta + 180) % 360) - 180)
    pts = [(0, 1.640), (40, 1.628), (70, 1.592), (92, 1.580), (110, 1.540), (135, 1.505), (180, 1.492)]
    xs, zs = zip(*pts)
    return float(np.interp(a, xs, zs))


def cap_mesh(skull_ob):
    """The skull grown by a few millimetres above the hairline."""
    co, faces = lib.object_arrays(skull_ob)
    c = CENTER
    d = co - c
    grown = c + d * 1.035
    ob = lib.mesh_object("HairCap", grown, faces)

    def below(center, normal):
        th = math.degrees(math.atan2(center[0], -(center[1] - c[1])))
        return center[2] < hairline(th)

    lib.delete_faces(ob, below)
    ob = lib.decimate(ob, 0.5)
    lib.shade_smooth(ob)
    return ob


# ---------------------------------------------------------------- the ponytail

def ponytail(skull_ob, mats):
    """A tie at the back of the head and five locks hanging from it; returns (locks, tie, chain points)."""
    skull = Skull(skull_ob)
    root, normal = skull.root(180, -4)
    tie_c = root + normal * 0.012
    chain = [tie_c + np.array([0, 0.018, -0.012]), tie_c + np.array([0, 0.040, -0.060]), tie_c + np.array([0, 0.050, -0.118]), tie_c + np.array([0, 0.046, -0.178]), tie_c + np.array([0, 0.040, -0.228])]
    locks = []
    bundle = [(0.0, 0.0, 0.228, 0.046)] + [(math.cos(a) * 0.011, math.sin(a) * 0.009, 0.20 - 0.012 * (i % 2), 0.040) for i, a in enumerate(np.linspace(0, 2 * math.pi, 6, endpoint=False))]
    for k, (dx, dy, L, W) in enumerate(bundle):
        dz = 0.0
        pts = [tie_c + np.array([dx * 0.4, -0.004 + dy * 0.4, dz]), tie_c + np.array([dx, 0.014 + dy, dz - 0.004])]
        for j, c in enumerate(chain[1:]):
            spread = 1.15 + 0.35 * j / 3
            pts.append(c + np.array([dx * spread, dy * spread, 0]))
        pts = np.array(pts)
        # Length per lock: cut the path.
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)])
        ts = np.linspace(0, min(L, cum[-1]), 10)
        path = np.stack([np.interp(ts, cum, pts[:, j]) for j in range(3)], axis=1)
        locks.append(lock_mesh(path, W, 0.022, np.array([dx, 1.0, 0.2]) / np.linalg.norm([dx, 1.0, 0.2]), f"tail{k}", n=10, root_swell=1.1))
    tail = lib.join(locks, "Ponytail")
    lib.shade_smooth(tail)
    lib.assign(tail, mats["hair"])
    tie = lib.loft(
        [dict(c=tie_c + np.array([0, -0.006, 0]), rx=0.016, ry=0.014), dict(c=tie_c + np.array([0, 0.004, -0.002]), rx=0.018, ry=0.016), dict(c=tie_c + np.array([0, 0.012, -0.005]), rx=0.016, ry=0.014)],
        n=16, sub=3, up=(1, 0, 0), name="Tie",
    )
    lib.shade_smooth(tie)
    lib.assign(tie, mats["tie"])
    return tail, tie, np.array(chain)


def hair_image(size=(64, 512)):
    """Along a lock: darker and cooler at the root, light in the middle, a bright band, a cool tip."""
    w, h = size
    v = 1 - (np.arange(h) + 0.5) / h  # 1 at the top row = the root (v=0 in the mesh is the root)
    v = 1 - v
    root = np.array([0.74, 0.77, 0.86])
    mid = np.array([0.91, 0.92, 0.96])
    tip = np.array([0.86, 0.89, 0.97])
    col = np.zeros((h, 3))
    for i, t in enumerate(v):
        if t < 0.35:
            k = (t / 0.35) ** 0.8
            c = root * (1 - k) + mid * k
        else:
            k = (t - 0.35) / 0.65
            c = mid * (1 - k) + tip * k
        band = math.exp(-((t - 0.30) / 0.05) ** 2) * 0.05
        col[i] = np.clip(c + band, 0, 1)
    img = np.ones((h, w, 4))
    img[..., :3] = col[::-1][:, None, :]
    return lib.image_from_array("hair", img)
