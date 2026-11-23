"""The pelt is painted in the head's own UV space. Features follow its actual surface."""
import math
import struct
import zlib

import bpy
import numpy as np

from geometry import TAU, MATERIALS, Section, badge, ball, cord, rings, smooth, sweep

PROFILE = np.array(smooth([
    (1.411,.009,.012,-.035), (1.439,.128,.116,-.032), (1.495,.235,.190,-.017),
    (1.574,.319,.224,.002), (1.681,.337,.240,.008), (1.787,.318,.239,.014),
    (1.891,.283,.220,.022), (1.976,.203,.174,.031), (2.025,.105,.094,.035), (2.041,.008,.009,.035)
], 6))


def shape(z):
    return tuple(np.interp(z, PROFILE[:,0], PROFILE[:,i]) for i in (1,2,3))


def snout(x,z):
    bridge=.103*np.exp(-((x/.126)**2+((z-1.607)/.080)**2))
    pads=.032*np.exp(-(((abs(x)-.049)/.046)**2+((z-1.579)/.043)**2))
    return bridge + pads + .018*np.exp(-((x/.21)**2+((z-1.525)/.09)**2))


def front(x,z):
    rx,ry,cy = shape(z)
    c = math.sqrt(max(.004,1-(x/rx)**2))
    return cy-ry*c - snout(x,z)*c**3


def paint(path):
    w,h = 1024,768
    a = (np.arange(w)[None,:]+.5)/w*TAU - math.pi
    z = PROFILE[-1,0] - (np.arange(h)[:,None]+.5)/h*(PROFILE[-1,0]-PROFILE[0,0])
    x = abs(shape(z)[0] * np.sin(a))
    forward = np.cos(a)
    def fade(v,lo,hi):
        t = np.clip((v-lo)/(hi-lo),0,1)
        return t*t*(3-2*t)
    def color(hexcolor):
        return np.array([int(hexcolor[i:i+2],16) for i in (0,2,4)])
    canvas = np.zeros((h,w,3)) + color('AC4B33')
    def layer(col,k):
        nonlocal canvas
        canvas = canvas+(color(col)-canvas)*np.clip(k,0,1)[:,:,None]
    fine = .0011*np.sin(a*101+z*48) + .0007*np.sin(a*223-z*93) + .0015*np.sin(a*47+z*28)
    frontside = fade(forward,-.15,.42)
    layer('DC7442',fade(z+forward*.07,1.47,1.94))
    layer('EF995A',np.exp(-((x/.08)**2+((z-1.82)/.16)**2))*frontside*.65)
    # Dark tear stripe underneath the eye, tapering down towards the lower cheek.
    mid = .144 + (z-1.71)*.42
    d = ((x-mid)/.086)**2 + ((z-1.705)/.111)**2
    layer('844130',(1-fade(d+fine*27,.64,1.75))*frontside)
    # Curved pale cheek stripe runs high at the outside and low under the nose bridge.
    edge = 1.573 + .155*fade(x,.154,.327) + .066*np.exp(-(x/.101)**2)
    layer('F7DDAB',(1-fade(z+fine,edge-.002,edge+.004))*fade(forward,-.5,.20))
    layer('FFF0CE',np.exp(-((x/.16)**2+((z-1.56)/.09)**2))*frontside*.82)
    for offset in (.044,.100):
        stripe=np.exp(-((x-offset-.30*(z-1.89))/.014)**2-((z-1.917)/.065)**2)
        layer('A55233',stripe*frontside*.40)
    for cx,cz in ((.232,1.652),(.249,1.660),(.223,1.644)):
        layer('EBA46A',(1-fade(((x-cx)/.0038)**2+((z-cz)/.0031)**2,.6,1.15))*frontside)
    # Small changes in pigment follow the direction of the fur.
    grain = np.random.default_rng(42).normal(0, .90, (h,w)) + .70*np.sin(a*237 + 13*np.sin(12*z+a))
    data = np.uint8(np.clip(canvas+grain[:,:,None],0,255))
    texture(path,data,"Painted pelt","Facial markings")


def texture(path,data,mat,name):
    h,w,_=data.shape
    def chunk(tag, payload):
        return struct.pack('>I',len(payload))+tag+payload+struct.pack('>I',zlib.crc32(tag+payload)&0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0)) +
                     chunk(b'IDAT',zlib.compress(b''.join(b'\x00'+row.tobytes() for row in data),8))+chunk(b'IEND',b''))
    m = MATERIALS[mat]
    tex = m.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(str(path))
    tex.image.name = "Iskra | "+name
    tex.image.pack()
    m.node_tree.links.new(tex.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])


def paint_tail(path):
    w,h=512,768
    a=(np.arange(w)[None,:]+.5)/w*math.tau
    t=1-(np.arange(h)[:,None]+.5)/h
    fiber=np.sin(77*a+13*t+1.4*np.sin(29*a-12*t))
    warped=t+.010*np.sin(3*a+9*t)+.004*np.sin(7*a-14*t)+.0023*fiber
    shades=[(150,66,42),(219,122,66),(153,68,43),(226,131,73),(151,64,43),(221,121,67),(159,73,45),(249,225,182)]
    pic=np.zeros((h,w,3))+shades[0]
    for cut,color in zip((.096,.206,.325,.437,.561,.683,.815),shades[1:]):
        v=np.clip((warped-cut)/.016+.5,0,1)
        pic=pic+(np.array(color)-pic)*(v*v*(3-2*v))[:,:,None]
    light=2.1*fiber+1.4*np.sin(211*a+12*t)+np.random.default_rng(7).normal(0,.8,(h,w))
    texture(path,np.uint8(np.clip(pic+light[:,:,None],0,255)),"Ringed pelt","Brush markings")


def build_head():
    head = Section("01  •  Cinnamon and cream pelt", "head")
    rows = []
    n = 96
    for z,rx,ry,cy in PROFILE:
        row = []
        for j in range(n):
            a = (j/n-.5)*TAU
            x,c = rx*math.sin(a),math.cos(a)
            row.append((x,cy-ry*c-snout(x,z)*max(0,c)**3,z))
        rows.append(row)
    ids = rings(head,rows,"Painted pelt")
    for i, row in enumerate(ids):
        for j, vertex in enumerate(row):
            head.uv[vertex] = (j/n,(PROFILE[i,0]-PROFILE[0,0])/(PROFILE[-1,0]-PROFILE[0,0]))
    for s,side in ((1,"L"),(-1,"R")):
        # Feather-shaped cheek ruffs continue the pale contour of the face.
        tuft = [(s*x,z) for x,z in [( .239,1.688),(.31,1.707),(.357,1.719),(.342,1.680),
                   (.399,1.663),(.361,1.635),(.382,1.629),(.326,1.594),(.341,1.592),(.29,1.547),(.231,1.563)]]
        badge(head,tuft,lambda x,z:-.127+(abs(x)-.245)*.79,"Biscuit",.024,rounds=1)
        for dx,dz in ((.009,.008),(-.012,-.019)):
            path = [(s*(x+dx),-.144+(x-.25)*.80,z+dz) for x,z in ((.268,1.628),(.302,1.641),(.337,1.654))]
            sweep(head,[(*p,r,r) for p,r in zip(path,(.0006,.0023,.0005))],"Flax",7,3)
        ear = Section("02  •  Listening ear "+side,"ear."+side)
        outer = [(s*x,z) for x,z in [( .146,1.877),(.162,1.997),(.220,2.075),(.300,2.124),
                 (.347,2.125),(.374,2.097),(.381,2.024),(.353,1.944),(.296,1.867),(.226,1.857)]]
        def ear_y(x,z):
            return -.004+(abs(x)-.25)*.28+(z-1.94)*.31
        badge(ear,outer,ear_y,"Biscuit",.058,rounds=3)
        inner = [(s*(.267+(abs(x)-.267)*.76),1.983+(z-1.983)*.77) for x,z in outer]
        badge(ear,inner,lambda x,z:ear_y(x,z)-.053,"Ear umber",.016,rounds=3)
        inner2 = [(s*(.266+(abs(x)-.266)*.76),1.978+(z-1.978)*.76) for x,z in inner]
        badge(ear,inner2,lambda x,z:ear_y(x,z)-.068,"Petal",.008,rounds=3)
        tuft2 = [(s*x,z) for x,z in [(.211,1.935),(.22,1.965),(.235,1.952),(.249,1.998),(.257,1.960),(.284,1.979),(.268,1.932)]]
        badge(ear,tuft2,lambda x,z:ear_y(x,z)-.080,"Flax",.005,rounds=1)
        eye(s,side)
        brow=Section("03  •  Expressive brow "+side,"head")
        brow_shape=[(.070,1.815),(.093,1.839),(.132,1.851),(.167,1.849),(.201,1.843),
                    (.185,1.833),(.151,1.827),(.109,1.814),(.082,1.809)]
        badge(brow,[(s*x,z+(.003 if s<0 else 0)) for x,z in brow_shape],lambda x,z:front(x,z)-.0018,"Biscuit",.006)
        for i,p in enumerate(brow.verts):
            x,y,z=p
            for key,dy,slope in (("happy",.004,-.08),("relaxed",-.004,-.04),("angry",-.011,.19),
                                 ("sad",.003,-.20),("surprised",.021,-.08)):
                nz=z+dy+slope*(abs(x)-.135)
                brow.keys[key][i]=(x,y+front(x,nz)-front(x,z),nz)
    muzzle = Section("04  •  Muzzle and expression shapes","head")
    nose = [(-.074,1.637),(-.060,1.655),(-.020,1.661),(0,1.656),(.025,1.661),(.065,1.652),
            (.075,1.636),(.054,1.614),(.018,1.595),(0,1.591),(-.019,1.595),(-.058,1.614)]
    badge(muzzle,nose,lambda x,z:front(x,z)-.007,"Nose leather",.029)
    cord(muzzle,[(x,front(x,z)-.034,z) for x,z in ((-.037,1.645),(-.019,1.649),(-.003,1.649))],.0024,"Nose glint",6)
    for s in (-1,1):
        for x,z,r in ((.078,1.596,.004),(.105,1.603,.0031),(.09,1.582,.0025)):
            ball(muzzle,(s*x,front(s*x,z)-.001,z),(r,.002,r*.8),"Chestnut",n=10,stacks=6)
    mouth(muzzle)
    aviator(head)


def eye(s,side):
    e = Section("03  •  Amber eye "+side,"head")
    cx,cz = s*.128,1.730
    def shell(x,z):
        u,v=(x-cx)/.069,(z-cz)/.067
        return front(x,z)-.004-.017*math.sqrt(max(.01,1-u*u-v*v))
    def patch(x,z,rx,rz,mat,d,contour,slant=0):
        segments=12 if rx<.007 else 20 if rx<.03 else 40
        pts=[(x+rx*math.cos(TAU*i/segments),z+rz*math.sin(TAU*i/segments)+s*slant*math.cos(TAU*i/segments)) for i in range(segments)]
        return badge(e,pts,lambda xx,zz:contour(xx,zz)-d,mat,.0018,rounds=0)
    patch(cx,cz,.072,.062,"Kohl",.001,shell,.007)
    liner_end=len(e.verts)
    patch(cx,cz-.001,.066,.054,"Biscuit",.004,shell,.005)
    start = len(e.verts)
    patch(cx-s*.005,cz,.049,.052,"Iris outer",.006,shell)
    patch(cx-s*.005,cz-.001,.045,.049,"Honey",.0075,shell)
    patch(cx-s*.006,cz+.004,.043,.045,"Iris copper",.009,shell)
    patch(cx-s*.007,cz+.007,.036,.040,"Deep ink",.011,shell)
    # Two highlights of unequal size give each eye a consistent light direction.
    patch(cx-.018,cz+.031,.011,.012,"Porcelain",.014,shell)
    patch(cx+.021,cz-.009,.0055,.0055,"Flax",.014,shell)
    for j in range(8):
        a = math.radians(218+j*12)
        x,z=cx-s*.005+.042*math.cos(a),cz+.047*math.sin(a)
        patch(x,z,.0019,.0038,"Sun",.010,shell)
    for i,p in enumerate(e.verts):
        x,y,z=p
        for key,f in (("blink_"+side,.035),("happy",.06 if side=="R" else .76),("relaxed",.83),("surprised",1.08)):
            nz=cz+(z-cz)*f
            if key=="happy": nz+=.009*(1-min(1,((x-cx)/.066)**2))
            ny=y+front(x,nz)-front(x,z)
            if f<.1:
                # The eyelid closes over the pupil and its highlights, leaving the lash line visible.
                ny=front(x,nz)+(.018 if i>=liner_end else -.005)
            e.keys[key][i]=(x,ny,nz)
        if i >= start:
            for key,dx,dz in (("lookLeft",.011,0),("lookRight",-.011,0),("lookUp",0,.010),("lookDown",0,-.010)):
                e.keys[key][i]=(x+dx,y+shell(x+dx,z+dz)-shell(x,z),z+dz)


def mouth(m):
    ids = []
    for i in range(29):
        t=i/28*2-1
        x=t*.061
        base=1.557+.017*t*t+.006*math.exp(-(t/.18)**2)
        row=[]
        for v in (1,0,-1):
            z=base+v*(.001+.0048*(1-t*t))
            y=front(x,z)-.004-.003*(1-t*t)
            row.append(m.vert((x,y,z)))
            for key,w,h in (("aa",.87,.037),("ih",1.10,.013),("ou",.54,.031),("ee",1.20,.015),
                            ("oh",.65,.034),("happy",1.20,.013),("relaxed",1.06,.002),
                            ("sad",.94,.003),("angry",.88,.006),("surprised",.68,.033)):
                nz=z - h*(1-t*t)*(1-v)*.5
                if key=="happy": nz+=.022*t*t
                if key=="sad": nz-=.018*t*t
                nx=x*w
                m.keys[key][row[-1]]=(nx,front(nx,nz)-.008,nz)
        ids.append(row)
    for a,b in zip(ids,ids[1:]):
        for j,col in ((0,"Deep ink"),(1,"Mouth rose")):
            m.face((a[j],a[j+1],b[j+1],b[j]),col)


def aviator(h):
    # A six-panel leather flying cap. The lower edge drops behind the ears into a nape guard.
    def cap_point(angle,t,lift=0):
        c=math.cos(angle)
        edge=1.828+.103*c+.014*c*c
        z=edge+(2.040-edge)*t
        rx,ry,cy=shape(z)
        r=.010+lift
        return ((rx+r*(1-t))*math.sin(angle),cy-(ry+r*(1-t))*c,z+.015*t)
    rows=[[cap_point(TAU*j/96,t/26) for j in range(96)] for t in range(27)]
    rings(h,rows,["Espresso"]*2+["Flight leather"]*24)
    edge=[cap_point(TAU*j/96,0,.002) for j in range(97)]
    cord(h,edge,.004,"Welt",8,1)
    for angle in (.38,-.38,1.56,-1.56,2.68,-2.68):
        line=[cap_point(angle,j/28,.0025) for j in range(1,28)]
        cord(h,line,.0029,"Oxblood",7,1)
        for j in range(1,25,3):
            cord(h,[cap_point(angle+.018,k/28,.0028) for k in (j,j+.9)],.00125,"Welt",6,1)
    for s in (-1,1):
        ball(h,(s*.300,.023,1.802),(.050,.079,.087),"Espresso",n=28,stacks=18)
        ball(h,(s*.325,.025,1.802),(.038,.065,.072),"Brass",n=28,stacks=16)
        ball(h,(s*.344,.026,1.802),(.027,.053,.059),"Deep teal",n=28,stacks=16)
        for i in range(3):
            ang=(i-1)*.52
            ball(h,(s*.368,.025+math.sin(ang)*.024,1.801+math.cos(ang)*.020),(.004,.004,.004),"Brass",n=10,stacks=6)
    # A leather strap wraps completely around the crown underneath the two brass eyepieces.
    rows = []
    for dz,offset in ((-.019,.004),(-.016,.009),(.015,.009),(.019,.004)):
        row=[]
        for i in range(80):
            a=TAU*i/80
            z=1.886+.052*math.cos(a)+dz
            rx,ry,cy=shape(z)
            row.append(((rx+offset+.009)*math.sin(a),cy-(ry+offset+.009)*math.cos(a),z))
        rows.append(row)
    rings(h,rows,"Oxblood")
    for s in (-1,1):
        cx,cz=.105*s,1.932
        def lens_y(x,z):
            return -.160+s*(x-cx)*.44 + (z-cz)*.82
        for rx,rz,d,mat in ((.106,.068,.015,"Espresso"),(.097,.063,.029,"Brass"),(.085,.052,.041,"Rim shadow"),
                           (.079,.047,.045,"Lagoon glass")):
            pts=[(cx+rx*math.cos(TAU*i/52),cz+rz*math.sin(TAU*i/52)+s*.018*math.cos(TAU*i/52)) for i in range(52)]
            badge(h,pts,lambda x,z,d=d:lens_y(x,z)-d,mat,.007,rounds=0)
        for off,scale in ((-.018,1),(.003,.50)):
            pts=[(cx+off-.032*scale,cz+.022),(cx+off-.020*scale,cz+.026),(cx+off+.018*scale,cz-.012),(cx+off+.008*scale,cz-.020)]
            badge(h,pts,lambda x,z:lens_y(x,z)-.054,"Glacier",.0015,rounds=1)
    cord(h,[(-.031,-.208,1.928),(-.017,-.221,1.939),(0,-.224,1.942),(.017,-.221,1.939),(.031,-.208,1.928)],.008,"Brass")
