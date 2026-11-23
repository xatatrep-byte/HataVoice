"""Flight jacket, postal radio, boots and the ringed tail."""
import math
import numpy as np
from mathutils import Vector

from geometry import TAU, Section, badge, ball, blend, cord, loft, rings, smooth, sweep

SHOULDER, ELBOW, WRIST, ARM_Z = .180,.405,.605,1.255
TAIL = [(0,.143,.75,.062,.060),(.078,.248,.696,.101,.095),(.210,.344,.586,.133,.125),
        (.362,.399,.531,.146,.139),(.497,.410,.553,.142,.135),(.585,.409,.642,.119,.114),
        (.603,.402,.745,.090,.086),(.576,.383,.831,.056,.053),(.524,.366,.886,.024,.021),
        (.499,.357,.913,.003,.003)]


def fingers(side):
    s = 1 if side == 'left' else -1
    result = {}
    for name,y,length in (("Index",-.043,.085),("Middle",-.014,.097),("Ring",.016,.087),("Little",.044,.068)):
        base=.679 if name != "Little" else .673
        result[name]=[(s*(base+length*t), y*(1+.19*t)-.003*t, ARM_Z-.006-.013*t*t) for t in (0,.43,.73,1)]
    result["Thumb"]=[(s*.628,-.034,ARM_Z-.013),(s*.646,-.067,ARM_Z-.021),
                     (s*.669,-.082,ARM_Z-.025),(s*.691,-.089,ARM_Z-.030)]
    return result


def torso_weights(p):
    z=p[2]
    if z<.925: return blend("hips","spine",(z-.850)/.075)
    if z<1.084: return blend("spine","chest",(z-.925)/.159)
    return blend("chest","upperChest",(z-1.084)/.115)


JACKET=[(0,0,.812,.170,.128),(0,0,.834,.196,.144),(0,.002,.891,.211,.152),
        (0,.007,.982,.218,.153),(0,.012,1.106,.215,.146),(0,.013,1.192,.220,.140),
        (0,.012,1.251,.202,.119),(0,.010,1.284,.155,.100),(0,.007,1.310,.100,.082)]
J_SURF = np.array(smooth(JACKET,6))


def jacket_front(x,z):
    cy,rx,ry = (np.interp(z,J_SURF[:,2],J_SURF[:,i]) for i in (1,3,4))
    return cy-ry*math.sqrt(max(.035,1-(x/rx)**2))


def clothing():
    body = Section("05  •  Air-mail flight jacket","chest")
    loft(body,[(0,.009,.720,.100,.083),(0,.009,.744,.162,.109),(0,.009,.784,.185,.126),
               (0,.009,.823,.174,.119)],"Night denim",40,3,"hips")
    loft(body,JACKET,"Petrol twill",52,4,torso_weights)
    loft(body,[(0,0,.798,.164,.125),(0,0,.804,.182,.137),(0,0,.834,.188,.139),
               (0,0,.850,.183,.135)],"Storm rib",52,2,"hips")
    for z in (.809,.840):
        loft(body,[(0,0,z,.184,.138),(0,0,z+.003,.185,.139)],"Tide piping",52,1,"hips")
    # Zipper follows the cloth through the bend at the belly.
    for x,r,col in ((0,.009,"Storm rib"),(0,.0029,"Brass")):
        zs=[.85+i*.026 for i in range(17)]
        sweep(body,[(x,jacket_front(x,z)-.003,z,r,r) for z in zs],col,10,2,
              lambda t:torso_weights((0,0,zs[0]+t*(zs[-1]-zs[0]))))
    for s,side in ((1,"left"),(-1,"right")):
        def jacket_strip(outline, mat, depth):
            return badge(body,[(s*x,z) for x,z in outline],lambda x,z:jacket_front(x,z)-.002,mat,depth,
                         weight="chest" if min(z for x,z in outline)>1.05 else "spine")
        # Slanted hand-warmer pockets enclosed with a curved facing.
        pocket=[(.068,.914),(.132,.984),(.195,1.002),(.174,.959),(.107,.900),(.080,.899)]
        jacket_strip(pocket,"Deep teal",.004)
        p=[(s*x,jacket_front(s*x,z)-.009,z) for x,z in ((.079,.911),(.107,.935),(.151,.970),(.182,.985))]
        cord(body,p,.0043,"Tide piping",9,4,"spine")
        panel=[(.042,1.254),(.140,1.278),(.194,1.243),(.207,1.20),(.121,1.164),(.058,1.181)]
        jacket_strip(panel,"Yoke twill",.003)
        p=[(s*x,jacket_front(s*x,z)-.009,z) for x,z in ((.050,1.183),(.105,1.170),(.141,1.175),(.185,1.196))]
        cord(body,p,.0023,"Tide piping",7,4,"upperChest")
        for i in range(4):
            x=s*(.084+i*.019)
            z=.909+i*.015
            cord(body,[(x,jacket_front(x,z)-.011,z),(x+s*.008,jacket_front(x+s*.008,z+.007)-.011,z+.007)],.0014,"Flax",6,1,"spine")
        arms(s,side)
        legs(s,side)
    pin=Section("06  •  Winged envelope insignia","upperChest")
    wing_stamp(pin,.102,1.127,.074,lambda x,z:jacket_front(x,z)-.012)
    handset(pin)
    sling()
    # Brass zipper slider and its vermilion leather pull.
    ball(body,(0,-.139,1.160),(.013,.012,.019),"Brass","chest",16,9)
    badge(body,[(-.006,1.155),(.005,1.155),(.014,1.111),(.002,1.106)],-.153,"Paprika",.003,"chest")
    loft(body,[(0,.007,1.265,.082,.070),(0,.007,1.292,.088,.071),(0,0,1.387,.077,.071),
               (0,-.013,1.435,.092,.084),(0,-.020,1.470,.095,.085)],"Chestnut",30,3,"neck")
    scarf()
    radio()
    tail()


def wing_stamp(s,cx,cz,size,fn):
    def part(pts,mat,d):
        badge(s,[(cx+size*x,cz+size*z) for x,z in pts],fn,mat,d,rounds=1)
    for sign in (-1,1):
        part([(sign*x,z) for x,z in ((.15,.10),(.55,.20),(.48,.04),(.32,-.02),(.40,-.02),(.32,-.12),(.14,-.16))],"Sun",.003)
    part([(-.24,.14),(.24,.14),(.24,-.14),(-.24,-.14)],"Flax",.004)
    pts=[(cx+size*x,fn(cx+size*x,cz+size*z)-.0058,cz+size*z) for x,z in ((-.20,.096),(0,-.021),(.20,.096))]
    cord(s,pts,size*.021,"Chestnut",6,1)


def handset(s):
    outline=[(.091,1.263),(.165,1.261),(.170,1.191),(.094,1.189)]
    def surface(x,z): return jacket_front(x,z)-.014
    badge(s,outline,surface,"Espresso",.022)
    face=[(.097,1.255),(.157,1.254),(.160,1.203),(.100,1.201)]
    badge(s,face,lambda x,z:surface(x,z)-.022,"Storm rib",.004)
    for i in range(4):
        z=1.214+i*.009
        cord(s,[(x,surface(x,z)-.028,z) for x in (.108,.128,.150)],.0018,"Tide piping",6,2)
    ball(s,(.106,surface(.106,1.247)-.030,1.247),(.0038,.003,.0038),"Sun",n=10,stacks=6)
    # Curled lead leaves the shoulder mic and runs around the side to the receiver.
    lead=[]
    for i in range(139):
        t=i/138
        a=t*math.tau*12
        x=.154+.065*t+.0037*math.cos(a)
        y=-.094+.194*t-.0043*math.sin(a)
        z=1.199-.135*math.sin(math.pi*t)+.020*t
        lead.append((x,y,z))
    cord(s,lead,.0025,"Espresso",6,1)


def sling():
    belt=Section("15  •  Crossbody radio harness","chest")
    path=smooth([(-.146,1.283),(-.116,1.239),(-.070,1.174),(.001,1.082),
                 (.074,.994),(.139,.912),(.181,.859)],6)
    def pos(x,z,d): return (x,jacket_front(x,z)-d,z)
    rows=[]
    for x,z in path:
        rows.append([pos(x+du*.82,z+du*.57,d) for du,d in
                     ((-.018,.008),(-.020,.012),(-.017,.017),(.016,.017),(.020,.012),(.017,.008))])
    # The path goes down and right. Its section goes clockwise looking down the strap.
    rings(belt,[list(reversed(row)) for row in rows],"Oxblood",[torso_weights((0,0,z)) for x,z in path])
    for j in range(1,len(path)-2,2):
        x,z=path[j]
        nx,nz=path[j+1]
        for side in (-1,1):
            cord(belt,[pos(x+side*.012,z+side*.008,.019),pos(nx+side*.012,nz+side*.008,.019)],.0011,
                 "Welt",6,1,torso_weights((0,0,z)))
    cx,cz=-.020,1.112
    corners=[(cx+dx*.82-dz*.57,cz+dx*.57+dz*.82) for dx,dz in ((-.025,-.018),(.025,-.018),(.025,.018),(-.025,.018),(-.025,-.018))]
    cord(belt,[pos(x,z,.025) for x,z in corners],.0042,"Brass",9,1,"chest")
    cord(belt,[pos(cx-.004,cz-.008,.026),pos(cx+.008,cz+.019,.026)],.0024,"Brass",7,1,"chest")


def arms(s,side):
    arm,fore,hand=(side+p for p in ("UpperArm","LowerArm","Hand"))
    sleeve=Section("07  •  Raglan sleeve "+side,arm)
    z=ARM_Z
    ball(sleeve,(s*.170,.007,z-.008),(.093,.083,.086),"Petrol twill",
         blend("upperChest",arm,.52),n=28,stacks=16)
    coords=[(.137,.086,.084),(.174,.097,.097),(.216,.097,.095),(.260,.087,.089),(.344,.079,.084),
            (.394,.081,.082),(.434,.076,.077),(.482,.071,.071),(.528,.074,.073),
            (.551,.068,.064),(.563,.057,.056)]
    sp=[(x*s,.006,z,a,b) for x,a,b in coords]
    sweep(sleeve,sp,"Petrol twill",32,3,lambda t:blend(arm,fore,(np.interp(t,np.linspace(0,1,len(coords)),[p[0] for p in coords])-.350)/.102))
    sp=[(s*x,.003,z,a,b) for x,a,b in ((.547,.058,.056),(.555,.061,.059),(.593,.054,.052),(.599,.050,.050))]
    sweep(sleeve,sp,"Storm rib",32,3,fore)
    for x,r in ((.565,.060),(.580,.057)):
        sweep(sleeve,[(s*x,.003,z,r,r-.002),(s*(x+.004),.003,z,r-.0005,r-.0025)],"Tide piping",32,1,fore)
    if side=="right":
        for x,r in ((.261,.089),(.283,.085)):
            sweep(sleeve,[(s*x,.005,z,r,r+.004),(s*(x+.012),.005,z,r-.001,r+.003)],"Sun",32,2,arm)
    glove=Section("08  •  Leather glove "+side,hand)
    sweep(glove,[(s*x,0,z+dz,ry,rz) for x,ry,rz,dz in ((.579,.039,.037,0),(.604,.044,.036,0),(.637,.058,.033,0),
        (.665,.058,.029,-.002),(.686,.043,.023,-.004))],"Espresso",28,3,hand)
    for finger,points in fingers(side).items():
        names=["Metacarpal","Proximal","Distal"] if finger=="Thumb" else ["Proximal","Intermediate","Distal"]
        width=.0148 if finger!="Little" else .0128
        for i,(a,b) in enumerate(zip(points,points[1:])):
            bone=side+finger+names[i]
            va,vb=Vector(a),Vector(b)
            r=width*(1-.10*i)
            specs=[(*(va+(vb-va)*t),r*factor,r*factor*.91) for t,factor in ((-.12,.62),(.02,1),(.67,.97),(.91,.83),(1.02,.45),(1.05,.08))]
            sweep(glove,specs,"Cocoa glove" if i else "Espresso",12,2,bone)


def legs(s,side):
    thigh,shin,foot=(side+p for p in ("UpperLeg","LowerLeg","Foot"))
    pants=Section("09  •  Pleated breeches "+side,thigh)
    sp=[(.253,.120,.071,.070),(.288,.120,.085,.081),(.36,.120,.085,.087),(.434,.120,.090,.097),
        (.486,.122,.103,.105),(.565,.125,.109,.115),(.676,.115,.120,.132),(.767,.101,.123,.141),
        (.833,.095,.111,.125),(.864,.088,.089,.092)]
    loft(pants,[(s*x,.010,z,rx,ry) for z,x,rx,ry in sp],"Night denim",36,3,
         lambda p:blend(shin,thigh,(p[2]-.386)/.136))
    path=[(s*(x+rx*.77),.009-ry*.68,z) for z,x,rx,ry in sp[1:-1]]
    sweep(pants,[(*p,.0034,.0032) for p in path],"Denim seam",8,3,
          lambda t:blend(shin,thigh,(np.interp(t,np.linspace(0,1,len(path)),[p[2] for p in path])-.386)/.136))
    profile=np.array(sp)
    def pant_front(x,z):
        cx,rx,ry=(np.interp(z,profile[:,0],profile[:,j]) for j in (1,2,3))
        return .01-ry*math.sqrt(max(.035,1-((x-s*cx)/rx)**2))
    # Curved twill knees, hem darts, and the screen-printed route number.
    shield=[(.066,.503),(.122,.516),(.180,.491),(.179,.420),(.154,.392),(.101,.399),(.072,.420)]
    badge(pants,[(s*x,z) for x,z in shield],lambda x,z:pant_front(x,z)-.002,"Knee twill",.003,
          blend(shin,thigh,.52))
    for delta in (0,.012):
        points=[(s*x,z+delta) for x,z in ((.079,.423),(.115,.411),(.151,.412),(.170,.424))]
        cord(pants,[(x,pant_front(x,z)-.006,z) for x,z in points],.0015,"Denim seam",7,3,blend(shin,thigh,.40))
    if side=="left":
        badge(pants,[(.087,.687),(.157,.687),(.158,.648),(.087,.647)],lambda x,z:pant_front(x,z)-.002,"Storm rib",.004,thigh)
        shapes=[[(.100,.655),(.100,.679),(.115,.679),(.115,.655),(.100,.655)],
                [(.124,.679),(.143,.679),(.132,.655)]]
        for points in shapes:
            cord(pants,[(x,pant_front(x,z)-.009,z) for x,z in points],.0025,"Flax",7,1,thigh)
    boot=Section("10  •  Trail boot "+side,foot)
    cx=s*.12
    def row(z,y,rx,ry): return (cx,y,z,rx,ry)
    loft(boot,[row(.009,-.038,.088,.142),row(.014,-.040,.095,.149),row(.038,-.040,.096,.150),
               row(.051,-.038,.095,.147)],"Sole rubber",36,3,foot,.78)
    loft(boot,[row(.050,-.039,.094,.147),row(.062,-.041,.095,.146),row(.086,-.043,.093,.141),
               row(.108,-.038,.090,.133),row(.138,-.019,.083,.109),row(.170,-.002,.077,.081),
               row(.204,.004,.072,.076)],"Oxblood",36,4,foot,.80)
    loft(boot,[row(.151,.008,.075,.078),row(.183,.007,.084,.085),row(.235,.012,.085,.087),
               row(.269,.011,.088,.087),row(.283,.012,.082,.082)],"Chestnut",36,3,lambda p:blend(foot,shin,(p[2]-.15)/.06))
    for z in (.20,.249):
        loft(boot,[row(z,.009,.087,.089),row(z+.006,.009,.090,.091),row(z+.020,.009,.088,.089)],
             "Oxblood",36,2,shin)
        bx=cx+s*.062
        rect=[(bx-.014,z+.017),(bx+.014,z+.017),(bx+.014,z-.001),(bx-.014,z-.001)]
        badge(boot,rect,-.062,"Brass",.005,shin)
    # Light welt against the dark sole, crossed lacing up the vamp.
    loft(boot,[row(.048,-.039,.095,.149),row(.054,-.039,.096,.149)],"Welt",40,1,foot,.78)
    for i in range(3):
        z=.093+i*.022
        y=(-.181,-.165,-.139)[i]
        for d in (-1,1):
            cord(boot,[(cx+d*.034,y+.004,z),(cx,y-.004,z+.008),(cx-d*.032,y+.013,z+.018)],.0034,"Welt",8,3,foot)


def scarf():
    neck=Section("11  •  Persimmon silk neckerchief","upperChest")
    loft(neck,[(0,0,1.270,.098,.086),(0,-.004,1.286,.132,.107),(0,0,1.310,.140,.114),
               (0,.006,1.339,.127,.106),(0,.008,1.366,.102,.089)],"Paprika",48,4)
    for z,r,col in ((1.300,.005,"Ember"),(1.330,.003,"Apricot")):
        points=[]
        for j in range(39):
            a=TAU*j/38
            points.append((.135*math.sin(a),-.111*math.cos(a),z+.012*math.sin(a+.7)))
        cord(neck,points,r,col,8,2)
    ball(neck,(-.112,-.071,1.296),(.045,.037,.040),"Ember",n=24,tilt=-.5)
    ends=Section("12  •  Neckerchief ends","upperChest")
    for side,points in (("A",[(-.119,-.075,1.292),(-.149,-.098,1.254),(-.175,-.107,1.205),(-.203,-.121,1.152),(-.216,-.131,1.133)]),
                        ("B",[(-.105,-.077,1.291),(-.122,-.126,1.251),(-.126,-.152,1.209),(-.130,-.159,1.166),(-.115,-.166,1.139)])):
        widths=(.010,.029,.031,.023,.002)
        specs=[(*p,w,.009 if i<4 else .002) for i,(p,w) in enumerate(zip(points,widths))]
        sweep(ends,specs,lambda t:"Flax" if .74<t<.82 else ("Apricot" if .83<t<.89 else "Paprika"),
              12,7,lambda t:blend("scarf."+side,"scarf."+side+".tip",(t-.35)/.35),axis=(1,0,0))


def radio():
    pack=Section("13  •  Field receiver No. 07","upperChest")
    # The satchel sits high enough to leave the tail free to turn beneath it.
    loft(pack,[(0,.164,.873,.104,.055),(0,.184,.890,.157,.075),(0,.193,.94,.171,.085),
               (0,.199,1.15,.173,.086),(0,.192,1.213,.162,.080),(0,.180,1.234,.137,.064)],
         "Oxblood",48,3,square=.45)
    loft(pack,[(0,.197,1.117,.169,.087),(0,.203,1.13,.179,.093),(0,.198,1.202,.173,.092),
               (0,.186,1.231,.149,.078)],"Chestnut",40,3,square=.47)
    for s in (-1,1):
        path=[(s*.103,-.063,1.290),(s*.131,.005,1.302),(s*.151,.099,1.269),(s*.142,.165,1.219)]
        sweep(pack,[(*p,.019,.009) for p in path],"Chestnut",12,4,axis=(1,0,0))
        ball(pack,(s*.117,.280,1.152),(.017,.010,.017),"Brass",n=14,stacks=8)
    # Rear enamel faceplate, frequency dial, speaker grille, two brass controls.
    ball(pack,(0,.279,1.024),(.124,.016,.076),"Deep teal",n=38,stacks=16)
    for idx in range(5):
        z=.995+idx*.013
        cord(pack,[(-.095,.291,z),(-.072,.296,z),(-.035,.297,z)],.0028,"Tide piping",7,3)
    for x,r in ((.020,.025),(.074,.018)):
        ball(pack,(x,.298,1.023),(r,.008,r),"Brass",n=22,stacks=10)
        ball(pack,(x,.304,1.023),(r*.65,.006,r*.65),"Espresso",n=20,stacks=9)
    ant=[(-.141,.186,1.222,.017,.017),(-.158,.187,1.303,.014,.014),(-.182,.192,1.454,.008,.008),
         (-.243,.201,1.734,.005,.005),(-.284,.204,1.923,.003,.003)]
    sweep(pack,ant,"Brass",12,3)
    ball(pack,ant[-1][:3],(.010,.010,.013),"Sun",n=12,stacks=8)
    for i in range(5):
        t=i/5
        ball(pack,(-.145-.014*t,.187,1.239+.073*t),(.016,.016,.004),"Storm rib",n=14,stacks=6)


def tail():
    t=Section("14  •  Ringed brush","tail.0")
    def weights(t):
        f=min(4,t*4.55)
        j=min(3,int(f))
        return blend("tail."+str(j),"tail."+str(j+1),f-j)
    rows=sweep(t,TAIL,"Ringed pelt",42,12,weights)
    for i,row in enumerate(rows):
        for j,index in enumerate(row):
            t.uv[index]=(j/len(row),i/(len(rows)-1))
