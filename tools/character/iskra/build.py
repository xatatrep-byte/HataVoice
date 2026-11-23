"""Build Iskra.blend, its three Actions, and the gallery VRM from this directory."""
import json
import math
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Euler, Quaternion, Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(HERE),str(HERE.parent)]
from geometry import MATERIALS, SECTIONS, material
from outfit import ARM_Z, ELBOW, SHOULDER, TAIL, WRIST, clothing, fingers
from face import build_head, paint, paint_tail
from rig import make_armature
from vrm import convert, read_glb, write_glb

FPS=24
MOTIONS=json.loads((ROOT/'client/src/characters/iskra-motions.json').read_text(encoding='utf8'))
BASE={"armL":[2.86,0,7.45],"armR":[2.86,0,-7.45],"foreL":[-14.32,0,0],"foreR":[-14.32,0,0],
      "legL":[0,0,1.15],"legR":[0,0,-1.15]}
RIG={"arm":"UpperArm","fore":"LowerArm","hand":"Hand","leg":"UpperLeg","shin":"LowerLeg","foot":"Foot"}


def colors():
    for name,color in {
        "Painted pelt":"FFFFFF","Ringed pelt":"FFFFFF","Chestnut":"955038","Biscuit":"F7DEB4","Flax":"FBE7C6",
        "Ear umber":"6B3834","Petal":"D18479","Kohl":"412C31","Iris outer":"633F2E","Honey":"DAA14E",
        "Iris copper":"986437","Deep ink":"242731","Porcelain":"FFFAE9","Mouth rose":"994F4B","Nose leather":"463133",
        "Nose glint":"986C5E","Espresso":"4B3733","Brass":"D89F50","Sun":"F2BB65","Rim shadow":"334D52",
        "Lagoon glass":"307F89","Glacier":"A1DAD3","Petrol twill":"34777B","Yoke twill":"4C8986",
        "Deep teal":"28595D","Storm rib":"294F55","Tide piping":"81ADA0","Paprika":"D44E35","Ember":"AB392F",
        "Apricot":"EF9060","Night denim":"374C5A","Denim seam":"668080","Oxblood":"743F34","Sole rubber":"373A3D",
        "Welt":"C19764","Cocoa glove":"604235","Knee twill":"435969","Flight leather":"825140"
    }.items():
        metal=.56 if name=="Brass" else .13 if name=="Lagoon glass" else 0
        rough=.25 if name in ("Lagoon glass","Deep ink","Iris copper","Honey","Nose leather") else .37 if metal else .65
        material(name,color,rough,metal)


def armature():
    b={}
    def bone(name,head,tail,parent=None):
        b[name]=(head,tail,parent,False)
    for name,z1,z2,parent in (("hips",.77,.88,None),("spine",.88,1.04,"hips"),("chest",1.04,1.17,"spine"),
            ("upperChest",1.17,1.282,"chest"),("neck",1.282,1.395,"upperChest"),("head",1.395,1.91,"neck")):
        bone(name,(0,0,z1),(0,0,z2),parent)
    springs=[]
    for side,s,l in (("left",1,"L"),("right",-1,"R")):
        px=[.033,SHOULDER,ELBOW,WRIST,.68]
        parent="upperChest"
        for i,suffix in enumerate(("Shoulder","UpperArm","LowerArm","Hand")):
            name=side+suffix
            bone(name,(s*px[i],0,ARM_Z),(s*px[i+1],0,ARM_Z),parent)
            parent=name
        for finger,points in fingers(side).items():
            segments=["Metacarpal","Proximal","Distal"] if finger=="Thumb" else ["Proximal","Intermediate","Distal"]
            parent=side+"Hand"
            for i,part in enumerate(segments):
                name=side+finger+part
                bone(name,points[i],points[i+1],parent)
                parent=name
        parent="hips"
        pts=[(s*.096,.008,.776),(s*.121,-.008,.445),(s*.120,.010,.159),(s*.120,-.092,.060),(s*.12,-.176,.047)]
        for i,name in enumerate(("UpperLeg","LowerLeg","Foot","Toes")):
            bone(side+name,pts[i],pts[i+1],parent)
            parent=side+name
        name="ear."+l
        bone(name,(s*.224,.006,1.882),(s*.320,.052,2.104),"head")
        bone(name+".tip",(s*.320,.052,2.104),(s*.337,.060,2.156),name)
        springs.append(dict(name="Listening ear "+l,joints=[name,name+".tip"],center="head",stiffness=3.0,dragForce=.66))
    for tag,points in (("A",[(-.119,-.075,1.292),(-.176,-.107,1.205),(-.216,-.131,1.133)]),
                       ("B",[(-.105,-.077,1.291),(-.126,-.152,1.209),(-.115,-.166,1.139)])):
        names=["scarf."+tag,"scarf."+tag+".tip","scarf."+tag+".end"]
        bone(names[0],points[0],points[1],"upperChest")
        bone(names[1],points[1],points[2],names[0])
        bone(names[2],points[2],tuple(Vector(points[2])+Vector((0,-.001,-.012))),names[1])
        springs.append(dict(name="Silk "+tag,joints=names,center="upperChest",stiffness=1.65,dragForce=.60))
    pts=[TAIL[i][:3] for i in (0,2,4,6,8,9)]
    for i in range(5):
        bone("tail."+str(i),pts[i],pts[i+1],"tail."+str(i-1) if i else "hips")
    bone("tail.end",pts[-1],tuple(Vector(pts[-1])+Vector((-.006,0,.009))),"tail.4")
    springs.append(dict(name="Ringed brush",joints=["tail."+str(i) for i in range(5)]+["tail.end"],
                        center="hips",stiffness=2.3,dragForce=.68,hitRadius=.025))
    arm=make_armature(b)
    arm.name="ISKRA  |  performance rig"
    arm.data.display_type='STICK'
    return arm,{"springs":springs}


def base_pose(frame):
    p=dict(BASE)
    p.update(MOTIONS["poses"][frame[1]])
    if len(frame)>2: p.update(frame[2])
    return p


def rotations(p):
    # Pose conventions match the stage's normalizedBone(). Rotate from glTF Y-up into Blender Z-up,
    # then into each bone's own rest frame when writing its action.
    out={}
    basis=Quaternion((1,0,0),math.pi/2)
    for joint in ["hips","spine","chest","neck","head"]+[k+l for l in ("L","R") for k in RIG]:
        x,y,z=(math.radians(v) for v in p.get(joint,[0,0,0]))
        turn=Quaternion((0,1,0),y)@Quaternion((1,0,0),x)@Quaternion((0,0,1),z)
        name=joint
        if joint[-1] in ("L","R"):
            side="left" if joint[-1]=="L" else "right"
            down=Quaternion((0,0,1),(-1 if side=="left" else 1)*math.pi/2)
            part=joint[:-1]
            name=side+RIG[part]
            if part=="arm": turn=turn@down
            if part in ("fore","hand"): turn=down.inverted()@turn@down
        out[name]=basis@turn@basis.inverted()
    return out


def animate(arm, objects):
    key_objects=[o for o in objects if o.data.shape_keys]
    tracks={ob:[] for ob in [arm]+[o.data.shape_keys for o in key_objects]}
    offset=1
    seq=[(tag,s["name"],s["keys"][-1][0]) for tag,s in MOTIONS["actions"].items()]+[("idle","На дежурстве",3.0)]
    for tag,label,duration in seq:
        count=round(duration*FPS)
        raw=MOTIONS["actions"][tag]["keys"] if tag!="idle" else [[0,"ready"],[duration,"ready"]]
        poses=[base_pose(k) for k in raw]
        rotations_list=[rotations(p) for p in poses]
        times=[k[0] for k in raw]
        for ob in tracks:
            ob.animation_data_create()
            act=bpy.data.actions.new(label if ob==arm else label+" · "+ob.name)
            act.use_fake_user=True
            ob.animation_data.action=act
        for f in range(count+1):
            t=duration*f/count
            j=next((k for k in range(len(times)-1) if t<=times[k+1]),len(times)-2)
            a,b=poses[j],poses[j+1]
            u=(t-times[j])/(times[j+1]-times[j])
            u=u*u*(3-2*u)
            def value(k,default=0): return a.get(k,default)*(1-u)+b.get(k,default)*u
            phase=math.tau*f/count
            for name,q in rotations_list[j].items():
                pb=arm.pose.bones[name]
                q=q.slerp(rotations_list[j+1][name],u)
                if tag=="idle":
                    if name=="chest": q=q@Quaternion((1,0,0),.026*math.sin(phase))
                    if name=="head": q=q@Quaternion((0,0,1),.065*math.sin(phase))
                rest=pb.bone.matrix_local.to_quaternion()
                pb.rotation_quaternion=rest.inverted()@q@rest
                pb.keyframe_insert(data_path="rotation_quaternion",frame=f+1,group=name)
            hips=arm.pose.bones["hips"]
            # Stage translations are metres after the app sizes Iskra to its standard 1.46 m height.
            shift=Vector((value("x")*2.13/1.46,0,value("y")))
            hips.location=hips.bone.matrix_local.to_quaternion().inverted()@shift
            hips.keyframe_insert(data_path="location",frame=f+1,group="hips")
            for i in range(5):
                pb=arm.pose.bones["tail."+str(i)]
                amp=.08 if tag=="idle" else .15 if tag=="dance" else .11
                pb.rotation_quaternion=Euler((amp*.6*math.sin(phase*(2 if tag=="dance" else 1)-i*.48),
                    .016*math.sin(phase-i*.3),amp*math.sin(phase*(3 if tag=="dance" else 1)-i*.57))).to_quaternion()
                pb.keyframe_insert(data_path="rotation_quaternion",frame=f+1,group="Tail")
            for s,l in ((1,"L"),(-1,"R")):
                ear=arm.pose.bones["ear."+l]
                ear.rotation_quaternion=Euler((.038*math.sin(phase*2+s),0,s*(.04*math.sin(phase+s)+.10*value("brow")))).to_quaternion()
                ear.keyframe_insert(data_path="rotation_quaternion",frame=f+1,group="Ears")
            for side,sgn in (("left",1),("right",-1)):
                for finger in ("Index","Middle","Ring","Little"):
                    for part in ("Proximal","Intermediate","Distal"):
                        pb=arm.pose.bones[side+finger+part]
                        rest=pb.bone.matrix_local.to_quaternion()
                        pb.rotation_quaternion=rest.inverted()@Quaternion((0,1,0),sgn*.14)@rest
                        if f==0: pb.keyframe_insert(data_path="rotation_quaternion",frame=1,group="Fingers")
            blink=value("eyes")
            if tag=="idle": blink=max(blink,max(0,1-abs(t-2.12)/.12))
            for ob in key_objects:
                for k in ob.data.shape_keys.key_blocks[1:]:
                    val={"blink_L":blink,"blink_R":blink,"happy":value("happy"),"aa":value("mouth"),
                         "ee":max(0,value("mouthWide"))*value("mouth")*.25,
                         "lookLeft":max(0,value("lookX")),"lookRight":max(0,-value("lookX"))}.get(k.name,0)
                    k.value=val
                    k.keyframe_insert(data_path="value",frame=f+1)
        for ob,parts in tracks.items():
            data=ob.animation_data
            parts.append((label,offset,data.action,data.action_slot))
            data.action=None
        bpy.context.scene.timeline_markers.new(label,frame=offset)
        offset+=count
    for ob,parts in tracks.items():
        track=ob.animation_data.nla_tracks.new()
        track.name="Flight log  •  solo performances"
        for label,start,act,slot in parts:
            strip=track.strips.new(label,start,act)
            strip.action_slot=slot
            strip.extrapolation='NOTHING'
    return offset-1


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version=0
    colors()
    scene=bpy.context.scene
    scene.render.fps=FPS
    arm,springs=armature()
    with tempfile.TemporaryDirectory() as tmp:
        tmp=Path(tmp)
        paint(tmp/'coat.png')
        paint_tail(tmp/'brush.png')
        build_head()
        clothing()
        objects=[section.finish(arm) for section in SECTIONS]
        scene.view_layers[0].update()
        glb=tmp/'iskra.glb'
        (tmp/'iskra.springs.json').write_text(json.dumps(springs))
        bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',export_animations=False,export_morph_normal=False,
                                  export_cameras=False,export_lights=False,export_yup=True,export_extras=False)
        vrm=ROOT/'client/public/avatars/iskra.vrm'
        info=convert(str(glb),str(vrm),"Искра")
        # Preserve the leather, enamel and brass response to the actual light of the stage.
        gltf,bin_chunk=read_glb(str(vrm))
        for m in gltf['materials']:
            m.get('extensions',{}).pop('VRMC_materials_mtoon',None)
            if m.get('extensions')=={}: del m['extensions']
        gltf['extensionsUsed'].remove('VRMC_materials_mtoon')
        meta=gltf['extensions']['VRMC_vrm']['meta']
        meta.update(otherLicenseUrl="https://creativecommons.org/publicdomain/zero/1.0/",commercialUsage="corporation",
                    allowPoliticalOrReligiousUsage=True,allowAntisocialOrHateUsage=True,
                    allowExcessivelySexualUsage=True,allowExcessivelyViolentUsage=True)
        write_glb(str(vrm),gltf,bin_chunk)
        print("Iskra VRM",info)
    scene.frame_start=1
    scene.frame_end=animate(arm,objects)
    # Subtle material relief for close camera work. Object-space coordinates stay fixed to the rest mesh.
    for name,frequency,depth in (("Petrol twill",165,.0010),("Night denim",140,.0010),
                                  ("Flight leather",125,.0013),("Oxblood",160,.001),("Chestnut",140,.0008)):
        tree=MATERIALS[name].node_tree
        noise=tree.nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value=frequency
        noise.inputs['Detail'].default_value=2
        bump=tree.nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value=.22
        bump.inputs['Distance'].default_value=depth
        tree.links.new(noise.outputs['Fac'],bump.inputs['Height'])
        tree.links.new(bump.outputs['Normal'],tree.nodes.get('Principled BSDF').inputs['Normal'])
    from studio import setup
    setup(scene,arm,objects)
    scene.frame_set(1+round(1.13*FPS))
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'Iskra.blend'),compress=True)


if __name__=="__main__":
    main()
