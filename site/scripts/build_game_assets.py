#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12", "scipy>=1.15"]
# ///
"""Build registered, direction-specific gameplay clips from selected sprite masters."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import median_filter
from PIL import Image
from build_sprite_masters import PRODUCTION, Pages, match_color

OUTPUT=PRODUCTION.parent/'game'
# Walking starts after the generated orientation prelude. Idle uses already
# side-facing frames, so releasing left never returns to the right-facing idle.
SPECS={
    'idle':('01-idle',range(72),'ground',0),
    'run':('43-run-right',range(29),'ground',1),
    'pickup-wriggle':('46-pickup-wriggle',range(168),'ground',0),
    'pickup-fall':('47-superhero-land',[18],'feet',0),
    'hero-land':('47-superhero-land',list(range(25,50))+list(range(104,148)),'planted',0),
    'idle-right':('04-turn',[50],'ground',1),
    'idle-left':('04-turn',[140],'ground',-1),
    'idle-front':('04-turn',[190],'feet',0),
    'walk-right':('02-walk-right',range(36),'ground',1),
    'walk-left':('03-walk-left',range(37),'ground',-1),
    'jump':('05-jump',range(66),'feet',1),
    # Frames 45–61 are still airborne, despite being near the end of the take.
    'land':('05-jump',range(63,69),'feet',1),
    'land-rest':('05-jump',[68],'feet',1),
    'hang':('15-climb-right',range(12),'ledge',1),
    'climb':('15-climb-right',range(162),'ledge',1),
    'climb-rest':('15-climb-right',[161],'feet',1),
    'rotation-front':('04-turn',range(154,191),'feet',1),
    'rotation-rear':('14-rear-turn',list(range(88,-1,-1)),'feet',1),
    'thinking':('09-thinking',range(20,130),'ground',0),
    'shrug':('10-shrug',range(18,130),'ground',0),
    'wave':('12-wave',range(24,132),'ground',0),
    'bow':('13-little-bow',range(30,126),'ground',0),
    'tiptoe':('20-tiptoe-cycle',range(144),'planted',1),
    'pond-hops':('17-pond-hops',range(144),'ground',1),
    'balance':('18-one-leg-balance',range(144),'planted',0),
    'crossed-arms':('19-crossed-arms',range(144),'planted',0),
    'toe-touch':('21-toe-touch',range(144),'planted',0),
    'quad-stretch':('31-quad-stretch',range(192),'planted',0),
    'side-stretch':('23-side-stretch',range(144),'planted',0),
    'sleepy-yawn':('24-sleepy-yawn',range(144),'planted',0),
    'criss-cross':('25-criss-cross',range(240),'planted',0),
    'dust-off':('26-dust-off',range(144),'planted',0),
    'bashful-toe':('27-bashful-toe',range(144),'planted',0),
    'imaginary-watch':('28-imaginary-watch',range(144),'planted',0),
    'air-guitar':('29-air-guitar',range(144),'planted',0),
    'little-victory':('30-little-victory',range(144),'planted',0),
    'cartwheel':('32-cartwheel',range(144),'ground',0),
    # Keep the clean removal, pause briefly, and reverse it to reattach. The
    # later generated scratch confuses the limbs and is intentionally unused.
    'arm-inspection':('33-arm-inspection',list(range(61))+[60]*12+list(range(59,-1,-1)),'planted',0),
    'punch-jump':('34-punch-jump',range(120),'ground',0),
    'disco-dance':('35-disco-dance',range(144),'planted',0),
    'peace-sign':('36-peace-sign',range(120),'planted',0),
    'juggling-mime':('37-juggling-mime',range(120),'planted',0),
    'sneeze':('38-sneeze',range(120),'planted',0),
    'dramatic-faint':('39-dramatic-faint',range(144),'ground',0),
    'zero-gravity':('40-zero-gravity',range(144),'ground',0),
    'blow-kiss':('41-blow-kiss',range(120),'planted',0),
}
PLAYBACK_FPS={'climb':48}
HOLD_FRAMES={'crossed-arms':94,'criss-cross':137,'dramatic-faint':101}
HOLD_LOOPS={'zero-gravity':[60,80]}
HOLD_LOOP_SECONDS={}
FINISH_BEFORE_NEXT={'hero-land','cartwheel','arm-inspection','punch-jump','dramatic-faint','zero-gravity'}
BASE_YAW={'run':90,'pickup-wriggle':30,'pickup-fall':30,'hero-land':30,'idle':30,'idle-right':90,'idle-left':-90,'idle-front':0,'idle-back':180,'walk-right':80,'walk-left':-80,'jump':60,'land':60,'land-rest':60,'hang':70,'climb':70,'climb-rest':70,'thinking':30,'shrug':30,'wave':20,'bow':30,'tiptoe':70,'pond-hops':70,'balance':30,'crossed-arms':30}


def rotation_yaw(source,index):
    if source=='14-rear-turn':return float(np.interp(index,[0,24,48,72,88],[180,170,145,110,90]))
    if index>=154:return float(np.interp(index,[154,165,175,184,190,195,205,209],[-90,-65,-35,-12,0,12,30,30]))
    return float(np.interp(index,[9,20,30,38],[37,60,82,90]))


def build_rotation(manifest,clips,torso_vectors):
    front=clips['rotation-front'];rear=clips['rotation-rear']
    # One continuous left-to-front sweep, reflected for front-to-right. Joining
    # the take's ending three-quarter pose to its opening pose caused a hitch.
    front_frames=front['frames']+[{**f,'flip':True,'yaw':-f['yaw']} for f in reversed(front['frames'][:-1])]
    pages=[{**p,'file':'../rotation-front/'+p['file']} for p in front['pages']]+[{**p,'file':'../rotation-rear/'+p['file']} for p in rear['pages']]
    rear_frames=[{**f,'page':f['page']+len(front['pages'])} for f in rear['frames']]
    # Mirroring only the missing rear-left quarter reuses the same image bytes.
    frames=[{**f,'flip':True,'yaw':-f['yaw']} for f in reversed(rear_frames) if f['yaw']>90]+front_frames+[f for f in rear_frames if f['yaw']>90]
    result={'name':'rotation','direction':0,'mirror':False,'registration':'feet','fps':24,'standing_height':384,'pages':pages,'frames':frames}
    destination=OUTPUT/'rotation';destination.mkdir(exist_ok=True)
    (destination/'clip.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
    for name in ['rotation-front','rotation-rear']:manifest['clips'].pop(name)
    manifest['clips']['rotation']={'url':'rotation/clip.json','frames':len(frames),'bytes':sum(p['bytes'] for p in pages),'direction':0,'mirror':False,'fps':24}
    manifest['rotation_angles']=[f['yaw'] for f in frames]
    manifest['angles']={}
    match_angles(manifest,front_frames,torso_vectors)


def match_angles(manifest,front_frames,torso_vectors):
    # Compare the torso around the tracked connector, leaving moving feet and
    # most arm gestures outside the comparison. Restrict ambiguous front/back
    # matches to the clip's reviewed hemisphere and smooth single-frame noise.
    candidates=np.array([f['yaw'] for f in front_frames])
    vectors=torso_vectors['rotation-front']
    reference=np.array(vectors+[v[:,::-1] for v in reversed(vectors[:-1])])
    for name,vectors in torso_vectors.items():
        if name.startswith('rotation'):continue
        base=BASE_YAW.get(name,30)
        allowed=np.where(np.abs(candidates-base)<=30)[0]
        if name in ['idle-front','idle-left','idle-right']:angles=[base]*len(vectors)
        else:
            angles=[float(candidates[allowed[np.argmin(np.mean((reference[allowed]-v)**2,axis=(1,2)))]] ) for v in vectors]
            angles=median_filter(angles,size=9,mode='nearest').tolist()
        manifest['angles'][name]=angles
    manifest['angles']['idle-back']=[180]


def runtime_vectors(name,kind):
    """Read existing registered pixels for additive exports; never recompress them."""
    folder=OUTPUT/name;clip=json.loads((folder/'clip.json').read_text())
    vectors=[];page_index=None;page=None
    for frame in clip['frames']:
        if frame['page']!=page_index:
            page_index=frame['page']
            with Image.open(folder/clip['pages'][page_index]['file']) as image:page=image.convert('RGBA')
        image=page.crop((frame['x'],frame['y'],frame['x']+frame['w'],frame['y']+frame['h']))
        if kind=='torso':
            sx=frame['anchor']['x']+frame['socket']['x'];sy=frame['anchor']['y']+frame['socket']['y']
            crop=image.crop((round(sx-34),round(sy+22),round(sx+34),round(sy+128))).resize((34,53),Image.Resampling.BILINEAR)
            backing=Image.new('RGBA',crop.size,'#eeeeee');backing.alpha_composite(crop)
            vectors.append(np.array(backing.convert('L'),dtype=float)/255)
        else:
            comparison=Image.new('RGBA',(100,130))
            thumb=image.resize((round(image.width*.3),round(image.height*.3)),Image.Resampling.LANCZOS)
            comparison.alpha_composite(thumb,(round(50-frame['anchor']['x']*.3),round(124-frame['anchor']['y']*.3)))
            backing=Image.new('RGBA',comparison.size,'white');backing.alpha_composite(comparison)
            vectors.append(np.asarray(backing.convert('L'),dtype=float)[62:]/255)
    return vectors


def map_run_gait(manifest,walk_vectors):
    for source,target in [('run','walk-right'),('walk-right','run'),('run','walk-left'),('walk-left','run')]:
        mirrored='walk-left' in [source,target]
        manifest['walk_transitions'][source+'>'+target]=[int(np.argmin([np.mean(((frame[:,::-1] if mirrored else frame)-candidate)**2) for candidate in walk_vectors[target]])) for frame in walk_vectors[source]]
    manifest['walk_starts']['run']=int(np.argmin([np.mean((walk_vectors['idle-right'][0]-frame)**2) for frame in walk_vectors['run']]))


def build_back_pose(manifest):
    image=Image.open(PRODUCTION/'reference/robot-back.png').convert('RGBA')
    image=match_color(image,json.loads((PRODUCTION/'color-profile.json').read_text()))
    image=image.crop(image.getbbox())
    ys,xs=np.where(np.array(image.getchannel('A'))>150)
    tip_y=int(ys.min())+1;tip_x=float(np.median(xs[ys<tip_y+2]))
    scale=384/image.height
    image=image.resize((round(image.width*scale),384),Image.Resampling.LANCZOS)
    destination=OUTPUT/'idle-back';destination.mkdir(exist_ok=True)
    pages=Pages(destination,2048,'web')
    placement=pages.add(image);pages.finish()
    anchor={'x':image.width/2,'y':image.height-4*scale}
    frame={**placement,'anchor':anchor,'socket':{'x':tip_x*scale-anchor['x'],'y':tip_y*scale-anchor['y']},'source_image':'../production/reference/robot-back.png'}
    result={'name':'idle-back','source':'reference/robot-back.png','direction':0,'mirror':False,'registration':'feet','fps':24,'standing_height':384,'pages':pages.pages,'frames':[frame]}
    (destination/'clip.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
    manifest['clips']['idle-back']={'url':'idle-back/clip.json','frames':1,'bytes':sum(p['bytes'] for p in pages.pages),'direction':0,'mirror':False,'fps':24}


def build(names=None):
    OUTPUT.mkdir(exist_ok=True)
    manifest=json.loads((OUTPUT/'manifest.json').read_text()) if names else {'fps':24,'standing_height':384,'clips':{}}
    walk_vectors={};torso_vectors={};clips={}
    tracks=json.loads((PRODUCTION/'connector-tracks.json').read_text())
    ledges=json.loads((PRODUCTION/'ledge-tracks.json').read_text())
    ground_motion=json.loads((PRODUCTION/'ground-motion.json').read_text())
    for name,(source,indices,registration,direction) in SPECS.items():
        if names and name not in names:continue
        folder=PRODUCTION/'sprites'/source
        atlas=json.loads((folder/'atlas.json').read_text())
        if source in ['06-grab-hang','07-climb','15-climb-right'] and not atlas.get('color_profile_version'):
            raise RuntimeError('Finish color matching before building game assets')
        selected=[atlas['frames'][index] for index in indices]
        rects=[record['source_rect'] for record in selected]
        scale=384/atlas['standing_height_source_px']
        ground=float(np.median([rect['y']+rect['h']-4 for rect in rects]))
        center=float(np.median([rect['x']+rect['w']/2 for rect in rects]))
        if registration in ['ground','planted'] and 'neutral_anchor' in atlas:
            # Hops retain their baked rise; balance retains its planted foot.
            # An airborne frame's crop bottom must never redefine the floor.
            center=atlas['neutral_anchor']['x'];ground=atlas['neutral_anchor']['y']
        destination=OUTPUT/name;destination.mkdir(exist_ok=True)
        pages=Pages(destination,2048,'web');frames=[]
        vectors=[];torsos=[]
        for record in selected:
            with Image.open(folder/record['png']) as image:
                image=image.copy()
            if source=='14-rear-turn':image=match_color(image,json.loads((PRODUCTION/'color-profile.json').read_text()))
            rect=record['source_rect']
            x=center;y=ground
            if registration=='feet':
                x=rect['x']+rect['w']/2;y=rect['y']+rect['h']-4
            elif registration=='planted':
                y=rect['y']+rect['h']-4
            elif registration=='hands':
                # Rightmost hand grips a right-hand ledge; renderer mirrors this
                # anchor together with the sprite for a left-hand ledge.
                mask=np.array(image.getchannel('A'))>180
                ys,xs=np.where(mask[:max(50,round(image.height*.07))])
                x=rect['x']+float(np.quantile(xs,.8));y=rect['y']+float(np.median(ys))
            elif registration=='ledge':
                # Cancel small source prop drift while preserving the robot's
                # supported motion relative to that exact visible corner.
                corner=ledges[source][record['source_frame']]
                x=corner['x'];y=corner['y']
            anchor={'x':(x-rect['x'])*scale,'y':(y-rect['y'])*scale}
            smaller=image.resize((round(image.width*scale),round(image.height*scale)),Image.Resampling.LANCZOS)
            placement=pages.add(smaller)
            if name.startswith('walk') or name in ['run','idle-left','idle-right']:
                comparison=Image.new('RGBA',(100,130))
                thumb=smaller.resize((round(smaller.width*.3),round(smaller.height*.3)),Image.Resampling.LANCZOS)
                comparison.alpha_composite(thumb,(round(50-anchor['x']*.3),round(124-anchor['y']*.3)))
                backing=Image.new('RGBA',comparison.size,'white');backing.alpha_composite(comparison)
                vectors.append(np.asarray(backing.convert('L'),dtype=float)[62:]/255)
            connector=tracks[source][record['index']]
            sx=(connector['x']-rect['x'])*scale;sy=(connector['y']-rect['y'])*scale
            torso=smaller.crop((round(sx-34),round(sy+22),round(sx+34),round(sy+128))).resize((34,53),Image.Resampling.BILINEAR)
            backing=Image.new('RGBA',torso.size,'#eeeeee');backing.alpha_composite(torso)
            torsos.append(np.array(backing.convert('L'),dtype=float)/255)
            frame={**placement,'anchor':anchor,'socket':{'x':(connector['x']-x)*scale,'y':(connector['y']-y)*scale},'source_frame':record['source_frame'],'source_seconds':record['source_time_seconds'],'source_index':record['index'],'source_clip':source}
            if name.startswith('rotation'):frame['yaw']=rotation_yaw(source,record['index'])
            frames.append(frame)
        pages.finish()
        for old in destination.glob('page-*.webp'):
            if old.name not in {p['file'] for p in pages.pages}:old.unlink()
        result={'name':name,'source':source,'direction':direction,'mirror':name!='idle-front','registration':registration,'fps':PLAYBACK_FPS.get(name,24),'standing_height':384,'pages':pages.pages,'frames':frames}
        if name=='pickup-wriggle':result['loop']=True
        if name=='run':result['move_speed']=json.loads((PRODUCTION/'runs'/source/'motion-calibration.json').read_text())['world_speed']
        if name in HOLD_FRAMES:result['hold_frame']=HOLD_FRAMES[name]
        if name in HOLD_LOOPS:result['hold_loop']=HOLD_LOOPS[name]
        if name in HOLD_LOOP_SECONDS:result['hold_loop_seconds']=HOLD_LOOP_SECONDS[name]
        if name in FINISH_BEFORE_NEXT:result['finish_before_next']=True
        clips[name]=result;torso_vectors[name]=torsos
        (destination/'clip.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
        manifest['clips'][name]={'url':f'{name}/clip.json','frames':len(frames),'bytes':sum(p['bytes'] for p in pages.pages),'direction':direction,'mirror':result['mirror'],'fps':result['fps']}
        for key in ['loop','move_speed']:
            if key in result:manifest['clips'][name][key]=result[key]
        if 'hold_frame' in result:manifest['clips'][name]['hold_frame']=result['hold_frame']
        if 'hold_loop' in result:manifest['clips'][name]['hold_loop']=result['hold_loop']
        if 'hold_loop_seconds' in result:manifest['clips'][name]['hold_loop_seconds']=result['hold_loop_seconds']
        if result.get('finish_before_next'):manifest['clips'][name]['finish_before_next']=True
        if name=='pond-hops':
            rise=np.array([max(0,(ground-r['y']-r['h']+4)*scale*136/384) for r in rects])
            manifest['clips'][name]['travel_speed']=(52*np.clip((rise-.8)/3,0,1)).round(3).tolist()
        if source in ground_motion:
            motion=ground_motion[source]
            # Cancel measured backward contact motion at the displayed scale.
            # Per-frame speed retains plants and acceleration from the source.
            units=atlas['source_size']['w']/motion['source_width']*scale*136/384
            offsets=np.array(motion['offset_x'])[list(indices)]
            manifest['clips'][name]['travel_speed']=(np.diff(offsets,append=offsets[-1])*units*24).round(4).tolist()
        if name=='climb':climb_end=frames[-1]
        if name=='climb-rest':
            # Re-register the SAME pixels under the feet, preserving their exact
            # world position when the player stops being attached to the ledge.
            manifest['climb_exit']={axis:(frames[0]['anchor'][axis]-climb_end['anchor'][axis])/384 for axis in ['x','y']}
        if vectors:walk_vectors[name]=vectors
        print(name,len(frames),manifest['clips'][name]['bytes'],flush=True)
    if names:
        front=json.loads((OUTPUT/'rotation-front/clip.json').read_text())
        front_frames=front['frames']+[{**f,'flip':True,'yaw':-f['yaw']} for f in reversed(front['frames'][:-1])]
        torso_vectors['rotation-front']=runtime_vectors('rotation-front','torso')
        match_angles(manifest,front_frames,torso_vectors)
        if 'run' in names:
            for name in ['walk-left','walk-right','idle-right']:walk_vectors[name]=runtime_vectors(name,'feet')
            map_run_gait(manifest,walk_vectors)
        (OUTPUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        return
    manifest['walk_transitions']={}
    manifest['walk_starts']={}
    for source,target in [('walk-right','walk-left'),('walk-left','walk-right')]:
        manifest['walk_transitions'][source+'>'+target]=[int(np.argmin([np.mean((frame[:,::-1]-candidate)**2) for candidate in walk_vectors[target]])) for frame in walk_vectors[source]]
        idle=walk_vectors[target.replace('walk','idle')][0]
        manifest['walk_starts'][target]=int(np.argmin([np.mean((idle-frame)**2) for frame in walk_vectors[target]]))
    if 'run' in walk_vectors:map_run_gait(manifest,walk_vectors)
    build_back_pose(manifest)
    build_rotation(manifest,clips,torso_vectors)
    (OUTPUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--clip',action='append',choices=list(SPECS));args=parser.parse_args()
    build(args.clip)
