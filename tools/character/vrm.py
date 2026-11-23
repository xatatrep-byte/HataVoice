"""Makes a VRM 1.0 out of the GLB that build.py writes: the humanoid by the bones' names, expressions from the shape keys
of the same names, gaze by expressions, spring bones for the chains, MToon for every material.

python vrm.py <in.glb> <out.vrm> [--name Имя]
"""
import json
import os
import struct
import sys

HUMAN = [
    "hips", "spine", "chest", "upperChest", "neck", "head", "leftEye", "rightEye", "jaw",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
    "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
]
for side in ("left", "right"):
    HUMAN += [f"{side}Thumb{p}" for p in ("Metacarpal", "Proximal", "Distal")]
    for finger in ("Index", "Middle", "Ring", "Little"):
        HUMAN += [f"{side}{finger}{p}" for p in ("Proximal", "Intermediate", "Distal")]

# Expression: (shape keys it binds, its overrides).
EXPRESSIONS = {
    "happy": (["happy"], dict(overrideBlink="block", overrideMouth="blend")),
    "angry": (["angry"], dict(overrideBlink="blend")),
    "sad": (["sad"], dict(overrideBlink="blend")),
    "relaxed": (["relaxed"], dict(overrideBlink="block")),
    "surprised": (["surprised"], dict(overrideBlink="blend", overrideMouth="blend")),
    "aa": (["aa"], {}),
    "ih": (["ih"], {}),
    "ou": (["ou"], {}),
    "ee": (["ee"], {}),
    "oh": (["oh"], {}),
    "blink": (["blink_L", "blink_R"], {}),
    "blinkLeft": (["blink_L"], {}),
    "blinkRight": (["blink_R"], {}),
    "lookUp": (["lookUp"], {}),
    "lookDown": (["lookDown"], {}),
    "lookLeft": (["lookLeft"], {}),
    "lookRight": (["lookRight"], {}),
}


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qrot(q, v):
    x, y, z, w = q
    p = qmul(qmul(q, (v[0], v[1], v[2], 0.0)), (-x, -y, -z, w))
    return (p[0], p[1], p[2])


def world_frames(gltf):
    """Each node's place in the room: (rotation quaternion, translation), scale taken as 1 (bones have none)."""
    nodes = gltf["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    out = {}

    def frame(i):
        if i in out:
            return out[i]
        n = nodes[i]
        q = tuple(n.get("rotation", (0, 0, 0, 1)))
        t = tuple(n.get("translation", (0, 0, 0)))
        if i in parent:
            pq, pt = frame(parent[i])
            r = qrot(pq, t)
            out[i] = (qmul(pq, q), (pt[0] + r[0], pt[1] + r[1], pt[2] + r[2]))
        else:
            out[i] = (q, t)
        return out[i]

    for i in range(len(nodes)):
        frame(i)
    return out


def to_local(frames, node, blender_point):
    """A point given in Blender's room (Z up) as an offset in the node's own axes (glTF, Y up)."""
    x, y, z = blender_point
    p = (x, z, -y)
    q, t = frames[node]
    inv = (-q[0], -q[1], -q[2], q[3])
    return [round(c, 5) for c in qrot(inv, (p[0] - t[0], p[1] - t[1], p[2] - t[2]))]


def read_glb(path):
    data = open(path, "rb").read()
    assert struct.unpack("<I", data[:4])[0] == 0x46546C67
    at = 12
    json_chunk, bin_chunk = None, b""
    while at < len(data):
        size, kind = struct.unpack("<II", data[at : at + 8])
        chunk = data[at + 8 : at + 8 + size]
        if kind == 0x4E4F534A:
            json_chunk = json.loads(chunk)
        elif kind == 0x004E4942:
            bin_chunk = chunk
        at += 8 + size
    return json_chunk, bin_chunk


def write_glb(path, gltf, binary):
    text = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    text += b" " * ((4 - len(text) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(text), 0x4E4F534A))
        f.write(text)
        f.write(struct.pack("<II", len(binary), 0x004E4942))
        f.write(binary)


def mtoon(look, base, texture=None):
    shade = look.get("hv_shade", [c * 0.62 for c in base[:3]])
    outline = float(look.get("hv_outline", 0.0))
    out = {
        "specVersion": "1.0",
        "transparentWithZWrite": False,
        "renderQueueOffsetNumber": 0,
        "shadeColorFactor": [float(c) for c in shade[:3]],
        "shadingShiftFactor": float(look.get("hv_shift", -0.05)),
        "shadingToonyFactor": float(look.get("hv_toony", 0.9)),
        "giEqualizationFactor": 0.9,
        "matcapFactor": [0, 0, 0],
        "parametricRimColorFactor": [float(look.get("hv_rim", 0.0))] * 3,
        "parametricRimFresnelPowerFactor": 5.0,
        "parametricRimLiftFactor": 0.0,
        "rimLightingMixFactor": 1.0,
        "outlineWidthMode": "worldCoordinates" if outline > 0 else "none",
        "outlineWidthFactor": outline * 0.001,
        "outlineColorFactor": [0.10, 0.07, 0.10],
        "outlineLightingMixFactor": 1.0,
        "uvAnimationScrollXSpeedFactor": 0.0,
        "uvAnimationScrollYSpeedFactor": 0.0,
        "uvAnimationRotationSpeedFactor": 0.0,
    }
    # With a picture, the shade is the picture darkened by the shade colour, not one flat colour.
    if texture is not None:
        out["shadeMultiplyTexture"] = {"index": texture}
    return out


def convert(src, dst, name, springs_path=None):
    gltf, binary = read_glb(src)
    # Blender 5 makes every new shape key at full strength, and the GLB keeps that as the mesh's resting weights: the face
    # would rest with every expression on at once wherever nothing drives them. At rest none is on.
    for mesh in gltf.get("meshes", []):
        if "weights" in mesh:
            mesh["weights"] = [0] * len(mesh["weights"])
    looks_path = os.path.splitext(src)[0] + ".looks.json"
    looks = json.load(open(looks_path, encoding="utf-8")) if os.path.exists(looks_path) else {}
    nodes = gltf["nodes"]
    by_name = {n.get("name"): i for i, n in enumerate(nodes)}

    human = {b: {"node": by_name[b]} for b in HUMAN if b in by_name}
    missing = [b for b in ("hips", "spine", "head", "leftUpperArm", "rightUpperArm", "leftUpperLeg", "rightUpperLeg") if b not in human]
    if missing:
        raise SystemExit(f"bones missing: {missing}")

    # Shape keys by name: which mesh node holds them, at which index.
    targets = {}
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        mesh = gltf["meshes"][n["mesh"]]
        names = (mesh.get("extras") or {}).get("targetNames") or []
        for k, t in enumerate(names):
            targets.setdefault(t, []).append((i, k))

    preset = {}
    for expr, (keys, overrides) in EXPRESSIONS.items():
        binds = [{"node": node, "index": index, "weight": 1.0} for k in keys for node, index in targets.get(k, [])]
        if not binds:
            continue
        e = {"morphTargetBinds": binds, "isBinary": False, "overrideBlink": "none", "overrideLookAt": "none", "overrideMouth": "none"}
        e.update(overrides)
        preset[expr] = e

    head_node = human["head"]["node"]
    meshes = [i for i, n in enumerate(nodes) if "mesh" in n]
    vrm = {
        "specVersion": "1.0",
        "meta": {
            "name": name,
            "version": "1.0",
            "authors": ["ХатаВойс"],
            "copyrightInformation": "Сделан с нуля для ХатаВойс",
            "licenseUrl": "https://vrm.dev/licenses/1.0/",
            "avatarPermission": "everyone",
            "allowExcessivelyViolentUsage": False,
            "allowExcessivelySexualUsage": False,
            "commercialUsage": "personalNonProfit",
            "allowPoliticalOrReligiousUsage": False,
            "allowAntisocialOrHateUsage": False,
            "creditNotation": "unnecessary",
            "allowRedistribution": True,
            "modification": "allowModificationRedistribution",
        },
        "humanoid": {"humanBones": human},
        "firstPerson": {"meshAnnotations": [{"node": i, "type": "auto"} for i in meshes]},
        "lookAt": {
            "type": "expression",
            "offsetFromHeadBone": [0.0, 0.09, 0.07],
            "rangeMapHorizontalInner": {"inputMaxValue": 16.0, "outputScale": 1.0},
            "rangeMapHorizontalOuter": {"inputMaxValue": 16.0, "outputScale": 1.0},
            "rangeMapVerticalDown": {"inputMaxValue": 10.0, "outputScale": 1.0},
            "rangeMapVerticalUp": {"inputMaxValue": 10.0, "outputScale": 1.0},
        },
        "expressions": {"preset": preset, "custom": {}},
    }
    ext = gltf.setdefault("extensions", {})
    ext["VRMC_vrm"] = vrm
    used = set(gltf.get("extensionsUsed", []))
    used.add("VRMC_vrm")

    # Spring bones, from the file build.py wrote next to the GLB.
    springs_path = springs_path or os.path.splitext(src)[0] + ".springs.json"
    if os.path.exists(springs_path):
        spec = json.load(open(springs_path, encoding="utf-8"))
        colliders, groups = [], []
        frames = world_frames(gltf)
        for g in spec.get("colliderGroups", []):
            idx = []
            for c in g["colliders"]:
                node = by_name[c["bone"]]
                off = to_local(frames, node, c["at"]) if "at" in c else c["offset"]
                tail = to_local(frames, node, c["to"]) if "to" in c else c.get("tail")
                shape = {"sphere": {"offset": off, "radius": c["radius"]}} if tail is None else {"capsule": {"offset": off, "radius": c["radius"], "tail": tail}}
                colliders.append({"node": by_name[c["bone"]], "shape": shape})
                idx.append(len(colliders) - 1)
            groups.append({"name": g["name"], "colliders": idx})
        group_index = {g["name"]: i for i, g in enumerate(groups)}
        springs = []
        for s in spec.get("springs", []):
            joints = []
            for j in s["joints"]:
                joints.append({
                    "node": by_name[j],
                    "hitRadius": s.get("hitRadius", 0.02),
                    "stiffness": s.get("stiffness", 1.0),
                    "gravityPower": s.get("gravityPower", 0.0),
                    "gravityDir": [0.0, -1.0, 0.0],
                    "dragForce": s.get("dragForce", 0.4),
                })
            spring = {"name": s["name"], "joints": joints, "colliderGroups": [group_index[g] for g in s.get("colliderGroups", []) if g in group_index]}
            if s.get("center"):
                spring["center"] = by_name[s["center"]]
            springs.append(spring)
        ext["VRMC_springBone"] = {"specVersion": "1.0", "colliders": colliders, "colliderGroups": groups, "springs": springs}
        used.add("VRMC_springBone")

    for m in gltf.get("materials", []):
        look = looks.get(m.get("name"), {})
        base = m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
        tex = m.get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("index")
        m.setdefault("extensions", {})["VRMC_materials_mtoon"] = mtoon(look, base, tex)
        if look.get("hv_alpha") == "MASK":
            m["alphaMode"] = "MASK"
            m.setdefault("alphaCutoff", 0.5)
        if "hv_emission" in look:
            m["emissiveFactor"] = look["hv_emission"][:3]
        # Faces are seen from one side; decals and thin parts from both.
        m["doubleSided"] = bool(look.get("hv_double", False))
    used.add("VRMC_materials_mtoon")
    gltf["extensionsUsed"] = sorted(used)
    write_glb(dst, gltf, binary)
    return {"bones": len(human), "expressions": sorted(preset), "materials": len(gltf.get("materials", [])), "springs": len(ext.get("VRMC_springBone", {}).get("springs", []))}


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    name = sys.argv[sys.argv.index("--name") + 1] if "--name" in sys.argv else "Персонаж"
    print(json.dumps(convert(src, dst, name), ensure_ascii=False))
