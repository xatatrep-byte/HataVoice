"""Gear: a straight sword on the back (lacquered scabbard, wrapped hilt, a guard), the leather strap across the chest that
holds it, and a lacquered plate on the left shoulder."""
import math

import numpy as np

import lib
from garments import on_body

# The sword lies across the back from over the right shoulder (-x) down to the left hip.
SWORD_TOP = np.array([-0.205, 0.150, 1.585])
SWORD_BOTTOM = np.array([0.175, 0.140, 0.965])


def _axis():
    d = SWORD_BOTTOM - SWORD_TOP
    return d / np.linalg.norm(d)


def sword(mats):
    """Returns (scabbard, hilt, guard)."""
    d = _axis()
    L = np.linalg.norm(SWORD_BOTTOM - SWORD_TOP)
    # Scabbard: a flattened tube, a little wider at the mouth, capped at the end.
    keys = []
    for t, w, h in ((0.0, 0.020, 0.012), (0.05, 0.019, 0.0115), (0.5, 0.018, 0.011), (0.93, 0.017, 0.0105), (1.0, 0.012, 0.008)):
        keys.append(dict(c=SWORD_TOP + d * (L * t), rx=w, ry=h, p=2.6))
    scabbard = lib.loft(keys, n=16, sub=3, up=(0, 1, 0), name="Scabbard")
    lib.shade_smooth(scabbard)
    lib.assign(scabbard, mats["lacquer"])
    # Metal end cap and mouth ring.
    caps = []
    for t0, t1, r in ((0.0, 0.035, 1.12), (0.94, 1.005, 1.08)):
        k = [dict(c=SWORD_TOP + d * (L * t0), rx=0.0205 * r, ry=0.0125 * r, p=2.6), dict(c=SWORD_TOP + d * (L * t1), rx=0.0185 * r, ry=0.0115 * r, p=2.6)]
        caps.append(lib.loft(k, n=16, sub=2, up=(0, 1, 0), name="cap"))
    fittings = lib.join(caps, "Fittings")
    lib.shade_smooth(fittings)
    lib.assign(fittings, mats["gold"])
    # Guard: a rounded square plate at the mouth.
    gc = SWORD_TOP - d * 0.006
    guard = lib.loft([dict(c=gc - d * 0.004, rx=0.034, ry=0.030, p=3.5), dict(c=gc + d * 0.004, rx=0.034, ry=0.030, p=3.5)], n=24, sub=1, up=(0, 1, 0), name="Guard")
    lib.shade_smooth(guard)
    lib.assign(guard, mats["gold"])
    # Hilt: wrapped grip with a pommel, up past the shoulder.
    hk = []
    for t, r in ((0.0, 0.0145), (0.02, 0.0150), (0.09, 0.0142), (0.165, 0.0140), (0.178, 0.0150), (0.188, 0.0120), (0.195, 0.004)):
        hk.append(dict(c=gc - d * t, rx=r, ry=r * 0.82, p=2.2))
    hilt = lib.loft(hk, n=16, sub=2, up=(0, 1, 0), name="Hilt", uv=True)
    lib.shade_smooth(hilt)
    lib.assign(hilt, mats["grip"])
    return scabbard, lib.join([fittings, guard], "SwordMetal"), hilt


def strap(surf, mats):
    """From over the right shoulder, across the chest to the left hip, and back up behind to the scabbard."""
    front = []
    for t in np.linspace(0, 1, 9):
        x = -0.105 + 0.25 * t
        z = 1.385 - 0.31 * t
        front.append((x, -0.3, z))
    pts = on_body(surf, front, 0.007, toward=(0, 1, 0))
    back = []
    for t in np.linspace(0, 1, 7):
        x = 0.145 - 0.25 * t
        z = 1.075 + 0.31 * t
        back.append((x, 0.3, z))
    pts_b = on_body(surf, back, 0.008, toward=(0, -1, 0))
    a = lib.ribbon(pts, [0.026] * len(pts), 0.005, normal_hint=(0, -1, 0), name="strapF", sub=3)
    b = lib.ribbon(pts_b, [0.026] * len(pts_b), 0.005, normal_hint=(0, 1, 0), name="strapB", sub=3)
    # Over the shoulder and round the side, joining the two.
    # Each point pressed toward the middle of the shoulder, so none slips off it down the back.
    over = []
    centre = np.array([-0.110, 0.004, 1.300])
    for t in np.linspace(0, 1, 9):
        ang = math.pi * t
        p = np.array([-0.105 - 0.015 * math.sin(ang), -math.cos(ang) * 0.10, 1.40 + 0.03 * math.sin(ang)])
        d = centre - p
        q, _n = surf.project(p - d / np.linalg.norm(d) * 0.05, d / np.linalg.norm(d), 0.007)
        over.append(q)
    o = lib.ribbon(np.array(over), [0.026] * 9, 0.005, normal_hint=(0, 0, 1), name="strapO", sub=3)
    buckle = lib.loft([dict(c=pts[5] - np.array([0, 0.004, 0]), rx=0.018, ry=0.016, p=4), dict(c=pts[5] - np.array([0, 0.009, 0]), rx=0.018, ry=0.016, p=4)], n=16, sub=1, up=(1, 0, 0), name="Buckle")
    lib.assign(buckle, mats["gold"])
    # Both ends go under the sash.
    ob = lib.join([a, b, o], "Strap")
    lib.shade_smooth(ob)
    lib.assign(ob, mats["leather"])
    return ob, buckle


def shoulder_plate(mats):
    """A guard of three overlapping lames round the top of the left shoulder, flaring down the arm, a cord at the top."""
    import body

    lames = []
    for k in range(3):
        x0 = 0.132 + 0.032 * k
        nu, nv = 16, 3
        verts, faces = [], []
        for i in range(nu + 1):
            a = math.radians(-82 + 164 * i / nu)
            for j in range(nv + 1):
                f = j / nv
                x = x0 + 0.054 * f
                # Each lame flares down the arm and tips outward, like a cap over the deltoid.
                r = 0.070 + 0.006 * k + 0.012 * f
                drop = 0.010 * f + 0.006 * k
                verts.append((x, body.ARM_Y + 0.004 + r * math.sin(a), body.SHOULDER_Z + 0.010 - drop + r * math.cos(a)))
        for i in range(nu):
            for j in range(nv):
                q = i * (nv + 1) + j
                faces.append([q, q + 1, q + nv + 2, q + nv + 1])
        lame = lib.mesh_object(f"lame{k}", np.array(verts), faces)
        lame = lib.solidify(lame, 0.0045, offset=1.0)
        lames.append(lame)
    ob = lib.join(lames, "ShoulderPlate")
    lib.shade_smooth(ob)
    lib.assign(ob, mats["metal"])
    pts = []
    for i in range(9):
        a = math.radians(-78 + 156 * i / 8)
        r = 0.073
        pts.append(dict(c=(0.134, body.ARM_Y + 0.004 + r * math.sin(a), body.SHOULDER_Z + 0.010 + r * math.cos(a)), rx=0.0045, ry=0.0045))
    cord = lib.loft(pts, n=8, sub=3, up=(1, 0, 0), name="Cord")
    lib.shade_smooth(cord)
    lib.assign(cord, mats["piping"])
    return ob, cord


def grip_image(size=128):
    """The hilt's wrap: dark cord crossing in diamonds over pale ray skin."""
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size
    v = (y + 0.5) / size
    a = ((u * 2 + v * 9) % 1.0)
    b = ((u * 2 - v * 9) % 1.0)
    cord = (np.minimum(a, 1 - a) < 0.22) | (np.minimum(b, 1 - b) < 0.22)
    img = np.ones((size, size, 4))
    img[..., :3] = np.array([0.86, 0.84, 0.78])
    img[cord, :3] = np.array([0.10, 0.10, 0.13])
    return lib.image_from_array("grip", img)
