# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless>=4.12", "numpy>=2"]
# ///
"""Rank running loop candidates and measure low-foot backward optical flow. Review before using."""
import cv2,numpy as np,json
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'assets/production/runs/43-run-right'
def mask(frame):
 b,g,r=cv2.split(frame.astype(np.int16));return ((np.minimum(r-g,b-g)<65)&(g<245)).astype(np.uint8)*255
cap=cv2.VideoCapture(str(p/'source.mp4'));fps=cap.get(cv2.CAP_PROP_FPS)
vectors=[];shifts=[];previous=None;previous_gray=None
try:
 while True:
  ok,frame=cap.read()
  if not ok:break
  gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
  vectors.append(cv2.resize(gray,(144,256)).astype(float)/255)
  if previous is None:
   ys,xs=np.where(mask(frame)>0);height=int(ys.max()-ys.min());floor=int(ys.max())
  i=len(vectors)-2
  if i>=35:
   a=previous_gray;b=gray
   m=mask(previous);m[:floor-80]=0;m[floor+25:]=0
   corners=cv2.goodFeaturesToTrack(a,80,.02,5,mask=m)
   if corners is not None:
    tracked,status,_=cv2.calcOpticalFlowPyrLK(a,b,corners,None,winSize=(21,21),maxLevel=3)
    reverse,rs,_=cv2.calcOpticalFlowPyrLK(b,a,tracked,None,winSize=(21,21),maxLevel=3)
    d=(tracked-corners).reshape(-1,2);xy=tracked.reshape(-1,2)
    valid=(status.ravel()==1)&(rs.ravel()==1)&(np.linalg.norm((reverse-corners).reshape(-1,2),axis=1)<1)&(abs(d[:,1])<8)&(d[:,0]<-1)&(d[:,0]>-80)&(xy[:,1]>floor-80)&(xy[:,1]<floor+25)
    if valid.sum()>=3:shifts.append({'frame':i,'dx':float(np.median(d[valid,0])),'n':int(valid.sum())})
  previous=frame;previous_gray=gray
finally:
 cap.release()
results=[]
for start in range(30,len(vectors)-20):
 for end in range(start+16,min(len(vectors)-1,start+50)):
  error=np.mean((vectors[start]-vectors[end])**2)+.3*np.mean(((vectors[start+1]-vectors[start])-(vectors[end+1]-vectors[end]))**2)
  results.append((error,start,end))
results.sort()
if not shifts:raise RuntimeError('No validated running contacts; inspect footage before calibrating.')
result={'fps':fps,'standing_height':height,'floor':floor,'loop_candidates':[{'error':e,'start':s,'end_exclusive':end} for e,s,end in results[:30]],'contacts':shifts,'estimated_world_speed':float(-np.median([s['dx'] for s in shifts])*fps*136/height)}
(p/'run-analysis.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='contacts'},indent=2))
