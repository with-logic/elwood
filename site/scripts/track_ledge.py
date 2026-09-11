#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "opencv-python-headless>=4.12"]
# ///
"""Measure the keying prop's corner so small source drift cannot move the ledge."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

PRODUCTION=Path(__file__).resolve().parents[1]/'assets/production'


def track(name):
    capture=cv2.VideoCapture(str(PRODUCTION/'runs'/name/'source.mp4'))
    points=[]
    while True:
        ok,frame=capture.read()
        if not ok:break
        height,width=frame.shape[:2]
        def blue(pixels):
            b,g,r=pixels.astype(np.int16).T
            return (b-np.maximum(r,g)>70)&(g>40)
        # Read far from the robot, where the rectangle reaches the frame edges.
        xs=np.flatnonzero(blue(frame[-24]));ys=np.flatnonzero(blue(frame[:,-24]))
        if not len(xs) or not len(ys):raise RuntimeError(f'Missing blue prop: {name}/{len(points)}')
        points.append({'x':round(float(xs[0]*2160/width),3),'y':round(float(ys[0]*3840/height),3)})
    capture.release()
    if not points:raise RuntimeError(f'No video frames: {name}')
    return points


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('names',nargs='+');args=parser.parse_args()
    path=PRODUCTION/'ledge-tracks.json'
    data=json.loads(path.read_text()) if path.exists() else {}
    for name in args.names:
        data[name]=track(name)
        print(name,len(data[name]),'tracked prop corners')
    path.write_text(json.dumps(data,separators=(',',':'))+'\n')
