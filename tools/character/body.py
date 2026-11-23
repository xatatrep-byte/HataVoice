"""The body: torso with the top's shape, arms, hands with fingers, baggy trousers, shins and boots. One fused surface
for the torso, arms and legs (garment zones are materials, their seams hidden under trims), hands and feet apart
(finer)."""
import math

import numpy as np

import lib

# Heights and places (metres), the character facing -Y, left at +X.
SHOULDER_Z = 1.365
ARM_Y = 0.006
SHOULDER_X = 0.165
ELBOW_X = 0.44
WRIST_X = 0.705
HIP_X = 0.092
HIP_Z = 0.905
KNEE_Z = 0.495
ANKLE_Z = 0.088
LEG_X = 0.094


def torso():
    keys = [
        dict(c=(0, 0.004, 0.83), rx=0.110, ry=0.085, p=2.2),
        dict(c=(0, 0.010, 0.89), rx=0.155, ry=0.100, p=2.4),
        dict(c=(0, 0.009, 0.95), rx=0.160, ry=0.099, p=2.4),
        dict(c=(0, 0.004, 1.02), rx=0.143, ry=0.089, p=2.3),
        dict(c=(0, 0.000, 1.08), rx=0.139, ry=0.089, p=2.3),
        dict(c=(0, -0.004, 1.15), rx=0.149, ry=0.095, p=2.4),
        dict(c=(0, -0.008, 1.22), rx=0.161, ry=0.101, p=2.5),
        dict(c=(0, -0.007, 1.29), rx=0.170, ry=0.100, p=2.6),
        dict(c=(0, -0.001, 1.343), rx=0.168, ry=0.090, p=2.8),
        dict(c=(0, 0.004, 1.381), rx=0.128, ry=0.071, p=2.5),
        dict(c=(0, 0.008, 1.412), rx=0.062, ry=0.058, p=2.0),
        dict(c=(0, 0.010, 1.47), rx=0.051, ry=0.052, p=2.0),
    ]
    return lib.loft(keys, n=40, sub=4, up=(1, 0, 0), name="torso")


def arm(side):
    s = 1 if side == "L" else -1
    y, z = ARM_Y, SHOULDER_Z
    # Rings: u up (vertical radius rx here), v front-back (ry).
    keys = [
        dict(c=(s * 0.095, y, z - 0.004), rx=0.064, ry=0.060),
        dict(c=(s * 0.165, y, z), rx=0.061, ry=0.056, p=2.1),
        dict(c=(s * 0.215, y, z - 0.002), rx=0.051, ry=0.048),
        dict(c=(s * 0.280, y - 0.002, z - 0.003), rx=0.045, ry=0.043),
        dict(c=(s * 0.360, y, z - 0.002), rx=0.039, ry=0.039),
        dict(c=(s * 0.430, y + 0.002, z), rx=0.034, ry=0.036),
        dict(c=(s * 0.470, y, z), rx=0.036, ry=0.040),
        dict(c=(s * 0.525, y, z), rx=0.038, ry=0.039),
        dict(c=(s * 0.595, y, z), rx=0.032, ry=0.034),
        dict(c=(s * 0.665, y, z), rx=0.026, ry=0.031),
        dict(c=(s * 0.700, y, z), rx=0.022, ry=0.030),
        dict(c=(s * 0.722, y, z), rx=0.021, ry=0.031),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"arm{side}")


def leg(side):
    """A baggy trouser leg: wide at the thigh, a little balloon at the calf, gathered into the wraps."""
    s = 1 if side == "L" else -1
    keys = [
        dict(c=(s * 0.076, 0.008, 0.965), rx=0.084, ry=0.094),
        dict(c=(s * 0.094, 0.004, 0.86), rx=0.092, ry=0.100),
        dict(c=(s * 0.100, 0.000, 0.73), rx=0.087, ry=0.094),
        dict(c=(s * 0.100, -0.002, 0.61), rx=0.080, ry=0.086),
        dict(c=(s * 0.098, -0.004, 0.51), rx=0.073, ry=0.080),
        dict(c=(s * 0.098, 0.000, 0.43), rx=0.076, ry=0.083),
        dict(c=(s * 0.097, 0.004, 0.34), rx=0.070, ry=0.075),
        dict(c=(s * 0.096, 0.006, 0.287), rx=0.058, ry=0.062),
        dict(c=(s * 0.095, 0.008, 0.255), rx=0.047, ry=0.049),
        dict(c=(s * 0.094, 0.010, 0.16), rx=0.040, ry=0.042),
        dict(c=(s * 0.094, 0.012, 0.09), rx=0.036, ry=0.040),
        dict(c=(s * 0.094, 0.012, 0.06), rx=0.034, ry=0.040),
    ]
    return lib.loft(keys, n=32, sub=4, up=(1, 0, 0), name=f"leg{side}")


def foot(side):
    """A slim ninja boot: low toe, narrow, the sole flat."""
    s = 1 if side == "L" else -1
    x = LEG_X
    # Along -Y from the heel to the toe; rings: u up (rx = height), v across (ry = width).
    keys = [
        dict(c=(s * x, 0.050, 0.044), rx=0.039, ry=0.028, p=2.3),
        dict(c=(s * x, 0.030, 0.054), rx=0.050, ry=0.034, p=2.4),
        dict(c=(s * x, 0.004, 0.060), rx=0.057, ry=0.037, p=2.5),
        dict(c=(s * (x + 0.002), -0.046, 0.041), rx=0.039, ry=0.040, p=2.6),
        dict(c=(s * (x + 0.003), -0.094, 0.027), rx=0.026, ry=0.041, p=2.8),
        dict(c=(s * (x + 0.003), -0.132, 0.021), rx=0.019, ry=0.037, p=2.8),
        dict(c=(s * (x + 0.002), -0.158, 0.018), rx=0.015, ry=0.027, p=2.4),
        dict(c=(s * (x + 0.001), -0.168, 0.017), rx=0.009, ry=0.015, p=2.2),
    ]
    return lib.loft(keys, n=28, sub=4, up=(0, 0, 1), name=f"foot{side}")


# ---------------------------------------------------------------- hands

FINGERS = {
    # name: (knuckle y, knuckle x, (proximal, intermediate, distal) lengths, base radius, tip radius, spread degrees)
    "Index": (-0.026, 0.796, (0.032, 0.022, 0.020), 0.0090, 0.0074, -5.0),
    "Middle": (-0.008, 0.801, (0.035, 0.025, 0.021), 0.0093, 0.0077, -1.0),
    "Ring": (0.010, 0.798, (0.033, 0.023, 0.020), 0.0088, 0.0072, 3.5),
    "Little": (0.026, 0.791, (0.026, 0.018, 0.017), 0.0078, 0.0064, 9.0),
}
HAND_Z = SHOULDER_Z - 0.002
CURL = math.radians(5)


def finger_joints(side):
    """For each finger: the points of its joints (knuckle, two middle joints, tip) — for the bones and the mesh."""
    s = 1 if side == "L" else -1
    out = {}
    for name, (ky, kx, lengths, r0, r1, spread) in FINGERS.items():
        a = math.radians(spread)
        d = np.array([math.cos(a), math.sin(a), 0.0])
        p = np.array([kx, ky, HAND_Z + 0.002])
        pts = [p.copy()]
        pitch = 0.0
        for L in lengths:
            pitch += CURL
            step = np.array([d[0] * math.cos(pitch), d[1] * math.cos(pitch), -math.sin(pitch)])
            p = p + step * L
            pts.append(p.copy())
        pts = np.array(pts)
        pts[:, 0] *= s
        out[name] = (pts, r0, r1)
    # The thumb: from the base of the palm, forward (-Y), out and a little down.
    base = np.array([0.722, -0.020, HAND_Z - 0.006])
    d = np.array([0.55, -0.74, -0.36])
    d /= np.linalg.norm(d)
    d2 = np.array([0.80, -0.55, -0.24])
    d2 /= np.linalg.norm(d2)
    pts = [base, base + d * 0.040]
    pts.append(pts[-1] + d2 * 0.031)
    pts.append(pts[-1] + d2 * 0.026)
    pts = np.array(pts)
    pts[:, 0] *= s
    out["Thumb"] = (pts, 0.0125, 0.0082)
    return out


def hand(side):
    s = 1 if side == "L" else -1
    z = HAND_Z
    palm = lib.loft(
        [
            dict(c=(s * 0.690, ARM_Y, z), rx=0.021, ry=0.030, p=2.3),
            dict(c=(s * 0.712, 0.000, z), rx=0.019, ry=0.033, p=2.5),
            dict(c=(s * 0.748, -0.001, z + 0.001), rx=0.0165, ry=0.040, p=3.0),
            dict(c=(s * 0.782, 0.000, z + 0.001), rx=0.0145, ry=0.042, p=3.2),
            dict(c=(s * 0.799, 0.000, z + 0.002), rx=0.0115, ry=0.039, p=3.0),
        ],
        n=28,
        sub=4,
        up=(0, 0, 1),
        name=f"palm{side}",
    )
    parts = [palm]
    for name, (pts, r0, r1) in finger_joints(side).items():
        n = len(pts)
        radii = np.linspace(r0, r1, n)
        keys = []
        # From inside the palm to the tip; joints a little thicker.
        start = pts[0] - (pts[1] - pts[0]) / np.linalg.norm(pts[1] - pts[0]) * (0.016 if name != "Thumb" else 0.006)
        keys.append(dict(c=start, rx=r0 * 1.05, ry=r0 * 1.1))
        for i in range(n - 1):
            a, b = pts[i], pts[i + 1]
            keys.append(dict(c=a, rx=radii[i] * 1.06, ry=radii[i] * 1.12))
            keys.append(dict(c=(a + b) / 2, rx=(radii[i] + radii[i + 1]) / 2 * 0.93, ry=(radii[i] + radii[i + 1]) / 2 * 1.02))
        tip = pts[-1]
        d = (pts[-1] - pts[-2]) / np.linalg.norm(pts[-1] - pts[-2])
        keys.append(dict(c=tip - d * r1 * 0.55, rx=r1 * 0.95, ry=r1 * 1.0))
        keys.append(dict(c=tip - d * r1 * 0.05, rx=r1 * 0.55, ry=r1 * 0.6))
        keys.append(dict(c=tip + d * r1 * 0.30, rx=r1 * 0.10, ry=r1 * 0.12))
        parts.append(lib.loft(keys, n=14, sub=2, up=(0, 0, 1), name=f"{name}{side}"))
    h = lib.join(parts, f"hand{side}")
    h = lib.remesh(h, 0.0022, smooth_iter=4, smooth_factor=0.5)
    h = lib.decimate(h, 0.30)
    lib.shade_smooth(h)
    return h


def body_mesh():
    """Torso, arms and legs fused into one surface."""
    parts = [torso(), arm("L"), arm("R"), leg("L"), leg("R")]
    ob = lib.join(parts, "body")
    ob = lib.remesh(ob, 0.0065, smooth_iter=6, smooth_factor=0.6)
    ob = lib.decimate(ob, 0.32)
    lib.shade_smooth(ob)
    return ob
