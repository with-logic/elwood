#!/usr/bin/env python3
"""Export native-size PNG review frames and lossless contact sheets from videos."""
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
RUNS=ROOT/'assets/production/runs'


def inspect(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_frames:format=duration,size','-of','json',str(path)]))


def build(folder):
    graded=(folder/'graded.mp4').exists()
    source=folder/('graded.mp4' if graded else 'source.mp4')
    if not source.exists():return
    metadata=inspect(source)
    stream=metadata['streams'][0]
    a,b=map(int,stream['r_frame_rate'].split('/'));fps=a/b
    count=int(stream.get('nb_frames') or round(float(metadata['format']['duration'])*fps))
    indices=[round(i*(count-1)/14) for i in range(15)]
    destination=folder/('review-frames-graded' if graded else 'review-frames')
    destination.mkdir(exist_ok=True)
    manifest=destination/'frames.json'
    if not manifest.exists():
        select='+'.join(f'eq(n,{n})' for n in indices)
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(source),'-vf',f"select='{select}'",'-fps_mode','vfr','-start_number','0',str(destination/'frame-%02d.png')],check=True)
        manifest.write_text(json.dumps([{'file':f'frame-{i:02d}.png','frame':n,'seconds':n/fps} for i,n in enumerate(indices)],indent=2)+'\n')
    contact=folder/('contact-graded.png' if graded else 'contact.png')
    if not contact.exists():
        width,height=stream['width'],stream['height']
        label_height=44
        sheet=Image.new('RGB',(width*5,(height+label_height)*3),'#f5f0e6')
        try:font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',24)
        except OSError:font=ImageFont.load_default(size=24)
        draw=ImageDraw.Draw(sheet)
        for i,item in enumerate(json.loads(manifest.read_text())):
            frame=Image.open(destination/item['file']).convert('RGB')
            x=(i%5)*width;y=(i//5)*(height+label_height)
            sheet.paste(frame,(x,y))
            draw.text((x+16,y+height+6),f"{item['seconds']:.3f}s  /  frame {item['frame']}",font=font,fill='#252525')
        sheet.save(contact)
    overview=folder/('overview-graded.png' if graded else 'overview.png')
    if not overview.exists():
        sheet=Image.new('RGB',(1500,1200),'#e8edf1');draw=ImageDraw.Draw(sheet)
        for i,item in enumerate(json.loads(manifest.read_text())):
            frame=Image.open(destination/item['file']).convert('RGB')
            r,g,b=frame.split()
            magenta=ImageChops.darker(ImageChops.subtract(r,g),ImageChops.subtract(b,g))
            blue=ImageChops.subtract(b,ImageChops.lighter(r,g))
            mask=ImageChops.lighter(magenta,blue).point(lambda value:255 if value<65 else 0)
            box=mask.getbbox()
            if not box:continue
            body=frame.crop((max(0,box[0]-15),max(0,box[1]-15),min(frame.width,box[2]+15),min(frame.height,box[3]+15)))
            body.thumbnail((280,365))
            x=i%5*300+(300-body.width)//2;y=i//5*400
            sheet.paste(body,(x,y))
            draw.text((i%5*300+12,y+375),f"{item['seconds']:.3f}s / source {item['frame']}",fill='black')
        sheet.save(overview)
    old=folder/'contact.jpg'
    if old.exists():old.rename(folder/'contact-preview.jpg')
    (folder/('graded-metadata.json' if graded else 'source-metadata.json')).write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps({'clip':folder.name,'contact':'contact.png','native_source_frame_size':[stream['width'],stream['height']],'review_stills':15}),flush=True)


if __name__=='__main__':
    for folder in sorted(RUNS.iterdir()):
        if folder.is_dir():build(folder)
