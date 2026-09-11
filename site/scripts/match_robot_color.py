#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12", "scipy>=1.15"]
# ///
"""Match selected animation chroma to neutral takes, preserving luminance and alpha."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import numpy as np
from PIL import Image, ImageDraw
from build_sprite_masters import PRODUCTION, Pages, match_color, REC709_WEIGHTS, COLOR_MATCH_CLIPS

NAMES=COLOR_MATCH_CLIPS
WEIGHTS=REC709_WEIGHTS
PROFILE=PRODUCTION/'color-profile.json'


def make_profile():
    if PROFILE.exists():return json.loads(PROFILE.read_text())
    ratios=[]
    for name in ['01-idle','02-walk-right','09-thinking']:
        pixels=np.array(Image.open(PRODUCTION/'sprites'/name/'frames/0000.png'))
        rgb=pixels[:,:,:3].astype(float);luma=rgb@WEIGHTS
        mask=(pixels[:,:,3]>250)&(luma>130)&(luma<240)
        ratios.append(np.median(rgb[mask]/luma[mask,None],axis=0))
    target=np.mean(ratios,axis=0);target/=target@WEIGHTS
    profile={'version':1,'rgb_per_luminance':target.tolist(),'reference_takes':['01-idle','02-walk-right','09-thinking'],'method':'Match opaque midtone chroma; retain per-pixel Rec.709 luminance and original alpha.'}
    PROFILE.write_text(json.dumps(profile,indent=2)+'\n')
    return profile


def sprites(name,profile):
    folder=PRODUCTION/'sprites'/name
    metadata=json.loads((folder/'atlas.json').read_text())
    if metadata.get('color_profile_version')==profile['version']:return
    temporary=Path(tempfile.mkdtemp(prefix=name+'-color-',dir=folder.parent))
    (temporary/'frames').mkdir()
    master=Pages(temporary/'master',8192,'master');web=Pages(temporary/'web',4096,'web')
    for record in metadata['frames']:
        with Image.open(folder/record['png']) as original:
            corrected=match_color(original,profile)
            if record['index']==len(metadata['frames'])//2:
                comparison=Image.new('RGB',(900,800),'#eeeee9');draw=ImageDraw.Draw(comparison)
                for index,im in enumerate([original.copy(),corrected.copy()]):
                    im.thumbnail((420,740));comparison.paste(im,(index*450+(450-im.width)//2,50),im)
                    draw.text((index*450+20,16),'Before' if index==0 else 'Matched to idle / walking',fill='black')
                comparison.save(PRODUCTION/'runs'/name/'color-comparison.png')
        corrected.save(temporary/record['png'],compress_level=3)
        record['master']=master.add(corrected)
        scale=metadata['web_scale']
        record['web']=web.add(corrected.resize((round(corrected.width*scale),round(corrected.height*scale)),Image.Resampling.LANCZOS))
    master.finish();web.finish()
    metadata.update(master_pages=master.pages,web_pages=web.pages,color_profile_version=profile['version'])
    metadata['notes'].append('Color matched to idle and walking references; luminance, alpha, resolution, and frame timing retained.')
    (temporary/'atlas.json').write_text(json.dumps(metadata,indent=2)+'\n')
    archive=Path(tempfile.mkdtemp(prefix='elwood-before-color-match-'))/name
    folder.rename(archive);temporary.rename(folder)
    print(json.dumps({'clip':name,'color_matched_frames':len(metadata['frames']),'original_export':str(archive)}),flush=True)


def video_lut(profile):
    path=PRODUCTION/'robot-neutral.cube'
    target=np.array(profile['rgb_per_luminance']);size=33
    lines=['TITLE "Elwood neutral robot, preserve chroma backing"',f'LUT_3D_SIZE {size}','DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1']
    for b in np.linspace(0,1,size):
        for g in np.linspace(0,1,size):
            for r in np.linspace(0,1,size):
                rgb=np.array([r,g,b]);neutral=(rgb@WEIGHTS)*target
                # Retain saturated magenta/blue key colors and blend edge pixels.
                backing=max(min(r-g,b-g),b-max(r,g))
                keep=np.clip(backing/.28,0,1)
                out=np.clip(neutral*(1-keep)+rgb*keep,0,1)
                lines.append(' '.join(f'{c:.7f}' for c in out))
    path.write_text('\n'.join(lines)+'\n')
    return path


def videos(name,lut):
    folder=PRODUCTION/'runs'/name
    for source,destination in [('source.mp4','graded.mp4'),('4k.mp4','4k-graded.mp4')]:
        output=folder/destination
        if output.exists():continue
        part=output.with_suffix('.part.mp4')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(folder/source),'-vf',f'lut3d=file={lut}:interp=tetrahedral','-an','-c:v','h264_videotoolbox','-b:v','24M' if source=='4k.mp4' else '6M','-pix_fmt','yuv420p','-movflags','+faststart','-y',str(part)],check=True)
        part.rename(output)
    print(name,'matched video previews and 4K master ready',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('names',nargs='*',choices=NAMES)
    args=parser.parse_args();names=args.names or NAMES
    profile=make_profile();lut=video_lut(profile)
    for name in names:sprites(name,profile)
    for name in names:videos(name,lut)
