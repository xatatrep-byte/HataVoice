"""Softbox portrait lighting and a painted enamel display plinth."""
import math
import bpy
from mathutils import Vector
from geometry import material, rgb


def aim(obj, point):
    obj.rotation_euler=(Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()


def setup(scene,arm,objects):
    studio=bpy.data.collections.new("STUDIO  |  lights and plinth")
    scene.collection.children.link(studio)
    character=bpy.data.collections.new("ISKRA  |  character")
    scene.collection.children.link(character)
    for obj in [arm]+objects:
        for coll in list(obj.users_collection): coll.objects.unlink(obj)
        character.objects.link(obj)
    def stage_object(o):
        for coll in list(o.users_collection): coll.objects.unlink(o)
        studio.objects.link(o)
        return o
    floor=material("Studio | sea salt","A6C8BE",.86)
    base=material("Studio | enamel","315C60",.36,.16)
    brass=material("Studio | brass rim","B89560",.35,.48)
    top=material("Studio | celadon","CAD8BC",.70)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.116))
    o=stage_object(bpy.context.object)
    o.name="Sea glass cyclorama"
    o.data.materials.append(floor)
    def disk(name,r,h,z,mat,bevel):
        bpy.ops.mesh.primitive_cylinder_add(vertices=128,radius=r,depth=h,location=(0,0,z))
        obj=stage_object(bpy.context.object)
        obj.name=name
        obj.data.materials.append(mat)
        for poly in obj.data.polygons: poly.use_smooth=len(poly.vertices)==4
        mod=obj.modifiers.new("Rolled edge",'BEVEL')
        mod.width=bevel
        mod.segments=4
        obj.modifiers.new("Planar caps","WEIGHTED_NORMAL")
    disk("Signal station | enamel foot",.675,.092,-.069,base,.024)
    disk("Signal station | brass seam",.672,.009,-.039,brass,.003)
    disk("Signal station | deck",.661,.038,-.015,top,.014)
    world=bpy.data.worlds.new("Soft north sky")
    scene.world=world
    world.use_nodes=True
    bg=world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value=(.61,.71,.80,1)
    bg.inputs[1].default_value=.31
    def light(name,pos,power,size,color,target=(0,0,1.05)):
        data=bpy.data.lights.new(name,'AREA')
        data.energy=power
        data.shape='DISK'
        data.size=size
        data.color=rgb(color)
        o=bpy.data.objects.new(name,data)
        studio.objects.link(o)
        o.location=pos
        aim(o,target)
    light("01  |  linen key",(-3.4,-3.8,5.5),460,4.0,"FFF1DE")
    light("02  |  sky fill",(3.4,-2.2,3.3),195,3.7,"DCEFFF")
    light("03  |  honey rim",(1.1,2.4,4.5),550,2.8,"FFE1B5")
    light("04  |  eye light",(-.2,-4.1,2.0),40,2.1,"FFF6DD")
    data=bpy.data.cameras.new("Portrait  |  80 mm")
    cam=bpy.data.objects.new("Camera  |  flight log",data)
    studio.objects.link(cam)
    scene.camera=cam
    data.type='ORTHO'
    # Follow the microphone closer, pull back for the dance, and finish with a turnaround.
    focus=bpy.data.objects.new("Camera  |  framing target",None)
    studio.objects.link(focus)
    tracking=cam.constraints.new('TRACK_TO')
    tracking.target=focus
    tracking.track_axis='TRACK_NEGATIVE_Z'
    tracking.up_axis='UP_Y'
    for frame,angle,scale,height in [(1,18,2.72,1.025),(63,12,2.69,1.04),(79,8,2.15,1.24),
                                    (99,7,2.15,1.24),(116,11,2.68,1.035),(221,16,2.72,1.02),
                                    (227,16,2.72,1.02),(245,90,2.75,1.02),(262,180,2.75,1.02),
                                    (280,284,2.75,1.02),(296,378,2.72,1.025)]:
        angle=math.radians(angle)
        cam.location=(7.8*math.sin(angle),-7.8*math.cos(angle),2.88)
        focus.location=(.03,0,height)
        data.ortho_scale=scale
        cam.keyframe_insert(data_path="location",frame=frame)
        focus.keyframe_insert(data_path="location",frame=frame)
        data.keyframe_insert(data_path="ortho_scale",frame=frame)
    scene.render.engine='CYCLES'
    scene.cycles.samples=32
    scene.cycles.use_denoising=True
    scene.render.resolution_x=850
    scene.render.resolution_y=920
    scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    scene.view_settings.look='AgX - Medium High Contrast'
    scene.render.film_transparent=False
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                space=area.spaces.active
                space.region_3d.view_perspective='CAMERA'
                space.region_3d.view_camera_zoom=7
                space.shading.type='MATERIAL'
                space.overlay.show_overlays=False
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active=arm
