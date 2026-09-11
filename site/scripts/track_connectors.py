#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12", "opencv-python-headless>=4.12"]
# ///
"""Track the actual top connector in the PNG masters, offline, in source pixels.

Optical flow follows the connector when the torso tips over. An isolated tip
above the neck re-locks the track on upright poses, excluding raised hands.
The output is inspected with marked contact sheets before gameplay export.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw

PRODUCTION=Path(__file__).resolve().parents[1]/'assets/production'


def load_frame(folder,record,scale):
    with Image.open(folder/record['png']) as im:
        small=im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.LANCZOS)
    pixels=np.array(small)
    alpha=pixels[:,:,3]/255
    gray=cv2.cvtColor(pixels[:,:,:3],cv2.COLOR_RGB2GRAY)
    gray=np.rint(gray*alpha+245*(1-alpha)).astype(np.uint8)
    x=round(record['source_rect']['x']*scale);y=round(record['source_rect']['y']*scale)
    canvas=np.full((round(3840*scale)+2,round(2160*scale)+2),245,np.uint8)
    canvas[y:y+gray.shape[0],x:x+gray.shape[1]]=gray
    mask=np.zeros_like(canvas);mask[y:y+gray.shape[0],x:x+gray.shape[1]]=pixels[:,:,3]
    return canvas,mask,small,(x,y)


def highest_tip(mask,around=None):
    if around is None:
        ys,xs=np.where(mask>150)
        top=ys.min();xs=xs[ys<top+3]
        return np.array([float(np.median(xs)),float(top+1)])
    x,y=around
    left=max(0,round(x-16));right=min(mask.shape[1],round(x+17))
    top=max(0,round(y-12));bottom=min(mask.shape[0],round(y+16))
    ys,xs=np.where(mask[top:bottom,left:right]>150)
    if not len(ys):return around
    minimum=ys.min();tipx=float(np.median(xs[ys<minimum+3]))+left
    return np.array([tipx,float(top+minimum+1)])


def track(folder):
    atlas=json.loads((folder/'atlas.json').read_text());scale=384/atlas['standing_height_source_px']
    keyframes_path=PRODUCTION/'connector-keyframes.json'
    keyframes=json.loads(keyframes_path.read_text()) if keyframes_path.exists() else {}
    if folder.name in keyframes:return track_keyframed(folder,atlas,keyframes[folder.name],scale)
    records=atlas['frames'];points=[None]*len(records)
    seed=0
    initial,mask,_,_=load_frame(folder,records[seed],scale)
    # The hanging pose's raised forearm occludes the tip as the pull-up starts.
    # Seed the visible plug at its reviewed source coordinate, then track its
    # rigid neck base through the occlusion instead of following the hand.
    start=np.array([1027,2232])*scale if folder.name=='07-climb' else highest_tip(mask)
    if folder.name=='15-climb-right':
        # Raised hands are higher than the socket. Seed the reviewed neck tip,
        # well left of those hands, then let optical flow follow the pull-up.
        start=highest_tip(mask,np.array([860,1880])*scale)
    for indices in [range(seed,len(records)),range(seed,-1,-1)]:
      previous=None;point=start.copy()
      for i in indices:
        current,mask,_,_=load_frame(folder,records[i],scale)
        if previous is not None:
            occluded=folder.name=='07-climb' and i<30
            offsets=[[0,12],[0,23],[-5,28],[5,28]] if occluded else [[0,0],[0,5],[-3,9],[3,9]]
            seeds=np.array([point+offset for offset in offsets],np.float32).reshape(-1,1,2)
            tracked,status,_=cv2.calcOpticalFlowPyrLK(previous,current,seeds,None,winSize=(25,25),maxLevel=3,criteria=(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,30,.01))
            good=status.ravel()==1
            if not np.any(good):raise RuntimeError(f'Lost connector at {folder.name}/{i}')
            point=tracked[0,0].astype(float) if good[0] and not occluded else point+np.median((tracked-seeds).reshape(-1,2)[good],axis=0)
        if folder.name=='07-climb' and 110<=i<=185:
            degrees=np.interp(i,[110,120,130,165,178,185],[-10,-30,-90,-90,-30,0])
        elif folder.name=='13-little-bow' and 45<=i<=105:degrees=25
        else:degrees=0
        if degrees:
            # The connector points sideways during a pull-up. Snap to the
            # outward silhouette along its axis, not to the torso's top edge.
            x,y=np.rint(point).astype(int);left=max(0,x-12);top=max(0,y-12)
            ys,xs=np.where(mask[top:y+13,left:x+13]>150)
            radians=np.deg2rad(degrees)
            score=xs*np.sin(radians)-ys*np.cos(radians)
            near=score>score.max()-1.2
            point=np.array([left+np.median(xs[near]),top+np.median(ys[near])])
        elif not(folder.name=='07-climb' and i<30):point=highest_tip(mask,point)
        points[i]={'x':round(float(point[0]/scale),3),'y':round(float(point[1]/scale),3)}
        previous=current
    return points


def track_keyframed(folder,atlas,annotation,scale):
    """Constrain short optical-flow tracks between reviewed plug locations.

    Raised hands and a folded torso can hide the highest plug silhouette.
    Forward/backward tracks anchored every half second prevent an occluding
    hand or shoulder wire from becoming the new attachment point.
    """
    frames=[load_frame(folder,r,scale)[:2] for r in atlas['frames']]
    factor=atlas['source_size']['w']/annotation['source_width']*scale
    anchors=[(i,np.array([x,y])*factor) for i,x,y in annotation['points']]
    assert anchors[0][0]==0 and anchors[-1][0]==len(frames)-1
    output=[None]*len(frames)
    for (start,a),(end,b) in zip(anchors,anchors[1:]):
        passes=[]
        for indices,initial in [(range(start,end+1),a),(range(end,start-1,-1),b)]:
            points={};point=initial.copy();previous=None
            for i in indices:
                current=frames[i][0]
                if previous is not None:
                    seeds=np.array([point+[0,0],point+[0,3],point+[-2,5],point+[2,5]],np.float32).reshape(-1,1,2)
                    tracked,status,_=cv2.calcOpticalFlowPyrLK(previous,current,seeds,None,winSize=(15,15),maxLevel=2)
                    good=status.ravel()==1
                    if good[0]:point=tracked[0,0].astype(float)
                    elif good.any():point+=np.median((tracked-seeds).reshape(-1,2)[good],axis=0)
                points[i]=point.copy();previous=current
            passes.append(points)
        for i in range(start,end+1):
            t=(i-start)/(end-start);guide=a*(1-t)+b*t
            if any(lo<=i<=hi for lo,hi in annotation.get('guide_only_ranges',[])):
                # The socket stays still while an arm passes in front of it.
                # Its reviewed location is valid even when its tip is hidden.
                output[i]={'x':round(float(guide[0]/scale),3),'y':round(float(guide[1]/scale),3)}
                continue
            point=passes[0][i]*(1-t)+passes[1][i]*t
            # A brief occlusion may attract flow to a moving hand. Keep that
            # estimate within the annotated neck trajectory, never the hand.
            delta=point-guide;distance=np.linalg.norm(delta)
            if distance>5:point=guide+delta*5/distance
            mask=frames[i][1];x,y=np.rint(point).astype(int)
            left=max(0,x-4);top=max(0,y-4)
            ys,xs=np.where(mask[top:y+5,left:x+5]>150)
            if len(xs):
                candidates=np.column_stack((xs+left,ys+top))
                point=candidates[np.argmin(np.sum((candidates-point)**2,axis=1))].astype(float)
            output[i]={'x':round(float(point[0]/scale),3),'y':round(float(point[1]/scale),3)}
    return output


def review(folder,points,destination):
    atlas=json.loads((folder/'atlas.json').read_text());scale=384/atlas['standing_height_source_px']
    indices=np.unique(np.linspace(0,len(points)-1,16).astype(int))
    sheet=Image.new('RGB',(1600,800),'#e8edf1');draw=ImageDraw.Draw(sheet)
    for n,i in enumerate(indices):
        _,_,im,offset=load_frame(folder,atlas['frames'][i],scale)
        x=points[i]['x']*scale-offset[0];y=points[i]['y']*scale-offset[1]
        detail=im.crop((round(x-42),round(y-36),round(x+42),round(y+54))).resize((168,180))
        ox=n%8*200+16;oy=n//8*400+30
        sheet.paste(detail,(ox,oy),detail)
        cx=ox+84;cy=oy+72
        draw.line((cx-7,cy,cx+7,cy),fill='#ee3333',width=2);draw.line((cx,cy-7,cx,cy+7),fill='#ee3333',width=2)
        body=im.copy();body.thumbnail((110,140));sheet.paste(body,(ox+25,oy+210),body)
        draw.text((ox,oy+185),f'{folder.name} / {i}',fill='black')
    sheet.save(destination)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('names',nargs='*');args=parser.parse_args()
    path=PRODUCTION/'connector-tracks.json'
    output=json.loads(path.read_text()) if path.exists() else {}
    folders=[PRODUCTION/'sprites'/n for n in args.names] if args.names else sorted((PRODUCTION/'sprites').glob('*'))
    review_dir=PRODUCTION/'review/connector-checks';review_dir.mkdir(parents=True,exist_ok=True)
    for folder in folders:
        if not (folder/'atlas.json').exists():continue
        points=track(folder);output[folder.name]=points
        path.write_text(json.dumps(output,separators=(',',':'))+'\n')
        review(folder,points,review_dir/(folder.name+'.png'))
        print(folder.name,len(points),flush=True)


if __name__=='__main__':main()
