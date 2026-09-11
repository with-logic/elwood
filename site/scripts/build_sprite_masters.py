#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12", "scipy>=1.15"]
# ///
"""Extract selected sequences at native 4K/24fps into PNG masters + WebP pages.

Never modifies the source video. Keying is an initial extraction pass; source
coordinates and timestamps are retained so masks, registration and loop seams
can be refined later. No temporal subsampling or frame interpolation is used.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT=Path(__file__).resolve().parents[1]
PRODUCTION=ROOT/'assets/production'
REC709_WEIGHTS=np.array([.2126,.7152,.0722])
BLUE_BACKING_CLIPS=('06-grab-hang','07-climb','08-step-down','15-climb-right')
COLOR_MATCH_CLIPS=BLUE_BACKING_CLIPS+('20-tiptoe-cycle','21-toe-touch','23-side-stretch','24-sleepy-yawn','25-criss-cross','26-dust-off','27-bashful-toe','28-imaginary-watch','29-air-guitar','30-little-victory','31-quad-stretch','32-cartwheel','33-arm-inspection','34-punch-jump','35-disco-dance','36-peace-sign','37-juggling-mime','38-sneeze','39-dramatic-faint','40-zero-gravity','41-blow-kiss')
COLOR_MATCH_CLIPS+=('43-run-right','46-pickup-wriggle','47-superhero-land')


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_frames:format=duration,size','-of','json',str(path)]))


def matte(rgb, blue=False, detached_margin=100):
    # Estimate the actual encoded backing colors rather than assuming perfect
    # FF00FF / 0066FF after video encoding and enhancement.
    pixels=np.asarray(rgb,dtype=np.float32)
    background=np.median(pixels[20:100,20:100].reshape(-1,3),axis=0)
    red,green,bl=pixels[:,:,0],pixels[:,:,1],pixels[:,:,2]
    denominator=max(80.,min(background[0]-background[1],background[2]-background[1]))
    strength=np.clip(np.minimum(red-green,bl-green)/denominator,0,1)
    if blue:
        backing=np.median(pixels[-100:-20,-100:-20].reshape(-1,3),axis=0)
        denominator_blue=max(80.,backing[2]-max(backing[0],backing[1]))
        blue_strength=np.clip((bl-np.maximum(red,green))/denominator_blue,0,1)
        is_blue=blue_strength>strength
        strength=np.maximum(strength,blue_strength)
    alpha=1-strength
    alpha[alpha<0.10]=0
    alpha[alpha>0.98]=1
    # Unblend the backing from edge pixels to avoid a magenta/blue fringe.
    opacity=np.maximum(alpha,0.001)
    for channel in range(3):
        backing_channel=np.where(is_blue,backing[channel],background[channel]) if blue else background[channel]
        pixels[:,:,channel]=(pixels[:,:,channel]-(1-alpha)*backing_channel)/opacity
    # This character is monochrome. Chroma estimates near encoded silhouettes
    # are noisy; use the uncontaminated backing channel at soft edges rather
    # than amplifying that noise into red/blue fringes.
    # red/green above are views into pixels, so derive the clean edge value from
    # the original RGB image, not the now-unblended array.
    original=np.asarray(rgb)
    clean_channel=np.where(is_blue,original[:,:,0],original[:,:,1]) if blue else original[:,:,1]
    clean_gray=np.clip(clean_channel/opacity,0,255)
    edge=(alpha>0)&(alpha<0.98)
    pixels[edge]=clean_gray[edge,None]
    # Small isolated codec/upscaler specks at frame borders should not make a
    # 2,000-pixel robot occupy an entire 4K sprite cell. Retain the main connected
    # body and substantial nearby detached parts; discard tiny islands and
    # disconnected horizontal contact-shadow strokes.
    labels,total=ndimage.label(alpha>0,structure=np.ones((3,3),dtype=np.uint8))
    areas=np.bincount(labels.ravel())
    areas[0]=0
    largest=int(areas.argmax())
    objects=ndimage.find_objects(labels)
    main=objects[largest-1]
    keep=np.zeros(total+1,dtype=bool);keep[largest]=True
    y0,y1=main[0].start,main[0].stop;x0,x1=main[1].start,main[1].stop
    for index,bounds in enumerate(objects,start=1):
        if not bounds or index==largest or areas[index]<max(100,areas[largest]*0.0003):continue
        sy,sx=bounds;h=sy.stop-sy.start;w=sx.stop-sx.start
        near=(sx.start>x0-detached_margin and sx.stop<x1+detached_margin and sy.start>y0-detached_margin and sy.stop<y1+detached_margin)
        if near and not (h<25 and w>4*h):keep[index]=True
    alpha[~keep[labels]]=0
    result=np.empty((*alpha.shape,4),dtype=np.uint8)
    result[:,:,:3]=np.clip(pixels,0,255).astype(np.uint8)
    result[:,:,3]=(alpha*255).astype(np.uint8)
    result[alpha==0,:3]=0
    image=Image.fromarray(result)
    return clean_ledge_outline(image) if blue else image


def clean_ledge_outline(image):
    """Remove thin prop outlines while retaining the original body/edge pixels.

    The generated blue prop has a faint ink outline that chroma keying cannot
    distinguish from the robot. Use a substantial foreground core to reject
    distant hairlines; dilating it back preserves soft silhouette edges.
    """
    pixels=np.array(image)
    core=ndimage.binary_opening(pixels[:,:,3]>40,structure=np.ones((7,7)))
    near=ndimage.binary_dilation(core,iterations=5)
    pixels[~near]=0
    return Image.fromarray(pixels)


def match_color(image,profile):
    pixels=np.array(image)
    luma=pixels[:,:,:3].astype(np.float32)@REC709_WEIGHTS
    pixels[:,:,:3]=np.clip(np.rint(luma[:,:,None]*profile['rgb_per_luminance']),0,255).astype(np.uint8)
    pixels[pixels[:,:,3]==0,:3]=0
    return Image.fromarray(pixels)


class Pages:
    def __init__(self,folder,side,kind):
        self.folder=folder;self.side=side;self.kind=kind;self.pages=[]
        folder.mkdir(parents=True,exist_ok=True)
        self.new_page()

    def new_page(self):
        self.canvas=Image.new('RGBA',(self.side,self.side))
        self.x=4;self.y=4;self.row_height=0;self.used_x=0;self.used_y=0

    def add(self,image):
        width,height=image.size
        if width+8>self.side or height+8>self.side:raise ValueError('Sprite exceeds atlas page size')
        if self.x+width+4>self.side:
            self.x=4;self.y+=self.row_height+8;self.row_height=0
        if self.y+height+4>self.side:
            self.finish();self.new_page()
        placement={'page':len(self.pages),'x':self.x,'y':self.y,'w':width,'h':height}
        self.canvas.alpha_composite(image,(self.x,self.y))
        self.used_x=max(self.used_x,self.x+width+4)
        self.used_y=max(self.used_y,self.y+height+4)
        self.row_height=max(self.row_height,height)
        self.x+=width+8
        return placement

    def finish(self):
        if not self.used_x:return
        extension='png' if self.kind=='master' else 'webp'
        filename=f'page-{len(self.pages):03d}.{extension}'
        path=self.folder/filename
        image=self.canvas.crop((0,0,self.used_x,self.used_y))
        if self.kind=='master':image.save(path,compress_level=3)
        else:image.save(path,format='WEBP',quality=94,method=4,exact=True)
        self.pages.append({'file':filename,'width':image.width,'height':image.height,'bytes':path.stat().st_size})


def read_exact(stream,size):
    result=bytearray()
    while len(result)<size:
        block=stream.read(size-len(result))
        if not block:break
        result.extend(block)
    return result


def single_frame(video,time,width,height):
    return Image.frombytes('RGB',(width,height),subprocess.check_output(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(time),'-i',str(video),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']))


def build(spec,settings):
    name=spec['name'];run=PRODUCTION/'runs'/name;video=run/'4k.mp4'
    if not video.exists():print(json.dumps({'clip':name,'status':'waiting for 4K'}),flush=True);return
    folder=PRODUCTION/'sprites'/name
    if (folder/'atlas.json').exists():print(json.dumps({'clip':name,'status':'already exported'}),flush=True);return
    if folder.exists() and any(folder.iterdir()):
        raise RuntimeError(f'Incomplete export in {folder}; move it aside before rebuilding.')
    folder.mkdir(parents=True,exist_ok=True)
    frames_folder=folder/'frames';frames_folder.mkdir(exist_ok=True)
    metadata=probe(video);stream=metadata['streams'][0]
    width,height=stream['width'],stream['height'];fps=settings['fps']
    if (width,height)!=(2160,3840) or stream['r_frame_rate']!='24/1':
        raise RuntimeError('Expected native 2160×3840 / 24 fps source; inspect unexpected output before extraction.')
    blue=name in BLUE_BACKING_CLIPS
    profile_path=PRODUCTION/'color-profile.json'
    profile=json.loads(profile_path.read_text()) if name in COLOR_MATCH_CLIPS and profile_path.exists() else None
    neutral=matte(single_frame(video,spec['neutral_time'],width,height),blue)
    if spec.get('clean_outline'):neutral=clean_ledge_outline(neutral)
    neutral_box=neutral.getchannel('A').point(lambda v:255 if v>180 else 0).getbbox()
    # A suspended-only take has no standing frame. Its reviewed torso scale
    # supplies the equivalent standing height without stretching bent legs.
    standing_height=spec.get('standing_height_source_px',neutral_box[3]-neutral_box[1])
    scale=settings['web_standing_height_px']/standing_height
    master=Pages(folder/'master',settings['master_max_page_size'],'master')
    web=Pages(folder/'web',settings['web_max_page_size'],'web')
    records=[]
    first_frame=round(spec['start']*fps);count=round((spec['end']-spec['start'])*fps)
    process=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(spec['start']),'-i',str(video),'-frames:v',str(count),'-an','-sn','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for index in range(count):
            raw=read_exact(process.stdout,width*height*3)
            if len(raw)!=width*height*3:raise RuntimeError('Unexpected truncated decoded frame')
            image=matte(Image.frombytes('RGB',(width,height),bytes(raw)),blue,spec.get('detached_margin_source_px',100))
            if spec.get('clean_outline'):image=clean_ledge_outline(image)
            if profile:image=match_color(image,profile)
            bbox=image.getchannel('A').getbbox()
            if bbox is None:raise RuntimeError('Key removed the complete sprite')
            if bbox==(0,0,width,height):raise RuntimeError('Matte unexpectedly covers the full frame; inspect before packaging.')
            x0,y0,x1,y1=bbox
            bbox=(max(0,x0-4),max(0,y0-4),min(width,x1+4),min(height,y1+4))
            sprite=image.crop(bbox)
            filename=f'{index:04d}.png'
            sprite.save(frames_folder/filename,compress_level=3)
            master_position=master.add(sprite)
            web_sprite=sprite.resize((max(1,round(sprite.width*scale)),max(1,round(sprite.height*scale))),Image.Resampling.LANCZOS)
            web_position=web.add(web_sprite)
            records.append({'index':index,'source_frame':first_frame+index,'source_time_seconds':(first_frame+index)/fps,'duration_ms':1000/fps,'png':'frames/'+filename,'source_rect':{'x':bbox[0],'y':bbox[1],'w':sprite.width,'h':sprite.height},'master':master_position,'web':web_position})
            if index%24==0:print(json.dumps({'clip':name,'exported_frames':index+1,'total':count}),flush=True)
        process.stdout.close()
        errors=process.stderr.read().decode();code=process.wait()
        if code:raise RuntimeError(errors)
    finally:
        if process.poll() is None:process.kill();process.wait()
    master.finish();web.finish()
    result={'clip':name,'source_video':str(video.relative_to(PRODUCTION)),'source_size':{'w':width,'h':height},'fps':fps,'frame_count':count,'selection':spec,'web_scale':scale,'standing_height_source_px':standing_height,'web_standing_height_px':settings['web_standing_height_px'],'master_pages':master.pages,'web_pages':web.pages,'frames':records,'notes':['Native 24 fps retained, no interpolation or temporal subsampling.','Master PNG pixels are cropped from the native 4K source without spatial resizing.','Magenta / blue backing removal is an initial matte; original MP4 preserves the unmodified source.','Source rectangles preserve movement coordinates. Loop seam, foot registration and ledge occlusion remain integration tasks.','WebP pages use quality 94 and a fixed per-clip scale; load only the needed animation pages.']}
    result['ledge_outline_refined']=blue
    result['neutral_anchor']={'x':(neutral_box[0]+neutral_box[2])/2,'y':neutral_box[3]}
    if profile:result['color_profile_version']=profile['version']
    (folder/'atlas.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'clip':name,'status':'complete','frames':count,'master_pages':len(master.pages),'web_pages':len(web.pages),'web_bytes':sum(p['bytes'] for p in web.pages)}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clip')
    args=parser.parse_args()
    settings=json.loads((PRODUCTION/'sprite-selections.json').read_text())
    for spec in settings['selections']:
        if args.clip and args.clip!=spec['name']:continue
        build(spec,settings)
