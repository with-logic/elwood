#!/usr/bin/env python3
"""Check delivered video timing, atlas geometry, and sampled native pixels."""
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageChops

ROOT=Path(__file__).resolve().parents[1]
PRODUCTION=ROOT/'assets/production'


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_frames','-of','json',str(path)]))['streams'][0]


def validate():
    selections=json.loads((PRODUCTION/'sprite-selections.json').read_text())
    results=[]
    for spec in selections['selections']:
        name=spec['name'];run=PRODUCTION/'runs'/name;folder=PRODUCTION/'sprites'/name
        source=probe(run/'source.mp4');upscale=probe(run/'4k.mp4')
        assert (upscale['width'],upscale['height'])==(2160,3840),name
        assert source['r_frame_rate']==upscale['r_frame_rate']=='24/1',name
        assert source['nb_frames']==upscale['nb_frames'],name
        (run/'4k-metadata.json').write_text(json.dumps(upscale,indent=2)+'\n')
        atlas=json.loads((folder/'atlas.json').read_text())
        count=round((spec['end']-spec['start'])*24)
        assert len(atlas['frames'])==atlas['frame_count']==count,name
        assert len(list((folder/'frames').glob('*.png')))==count,name
        assert atlas['fps']==24,name
        for kind in ['master','web']:
            for page in atlas[kind+'_pages']:
                path=folder/kind/page['file']
                with Image.open(path) as image:
                    assert image.size==(page['width'],page['height']),(name,path)
                    assert image.mode=='RGBA',(name,path)
                assert path.stat().st_size==page['bytes'],(name,path)
            for page_index in range(len(atlas[kind+'_pages'])):
                rectangles=[record[kind] for record in atlas['frames'] if record[kind]['page']==page_index]
                for index,a in enumerate(rectangles):
                    for b in rectangles[index+1:]:
                        assert a['x']+a['w']<=b['x'] or b['x']+b['w']<=a['x'] or a['y']+a['h']<=b['y'] or b['y']+b['h']<=a['y'],(name,kind,'overlap')
        first=round(spec['start']*24)
        for index,record in enumerate(atlas['frames']):
            assert record['index']==index and record['source_frame']==first+index,name
            assert abs(record['source_time_seconds']-(first+index)/24)<1e-9,name
            assert abs(record['duration_ms']-1000/24)<1e-9,name
            assert record['source_frame']<int(source['nb_frames']),name
            rect=record['source_rect']
            assert rect['x']>=0 and rect['y']>=0 and rect['x']+rect['w']<=2160 and rect['y']+rect['h']<=3840,name
            with Image.open(folder/record['png']) as image:
                assert image.size==(rect['w'],rect['h']) and image.mode=='RGBA',name
            for kind in ['master','web']:
                position=record[kind];page=atlas[kind+'_pages'][position['page']]
                assert position['x']>=0 and position['y']>=0 and position['x']+position['w']<=page['width'] and position['y']+position['h']<=page['height'],(name,index,kind)
        # First, midpoint and final master atlas cells must exactly match their
        # standalone lossless PNGs, including alpha. This catches packing damage.
        for index in sorted({0,count//2,count-1}):
            record=atlas['frames'][index];p=record['master']
            with Image.open(folder/'master'/atlas['master_pages'][p['page']]['file']) as page:
                cell=page.crop((p['x'],p['y'],p['x']+p['w'],p['y']+p['h']))
            with Image.open(folder/record['png']) as frame:
                difference=ImageChops.difference(cell,frame)
                assert all(channel.getbbox() is None for channel in difference.split()),(name,index,'pixel mismatch')
                assert frame.getchannel('A').getextrema()==(0,255),(name,index,'missing transparency')
        item={'clip':name,'frames':count,'source_and_4k_frames':int(source['nb_frames']),'master_pixel_samples':3,'web_bytes':sum(p['bytes'] for p in atlas['web_pages'])}
        results.append(item);print(json.dumps(item),flush=True)
    seconds=sum(json.loads(p.read_text())['seconds'] for p in (PRODUCTION/'runs').glob('*/submission.json'))
    assert seconds<=json.loads((PRODUCTION/'plan.json').read_text())['generation_cap_seconds']
    report={'status':'passed','generated_seconds':seconds,'clips':results,'sprite_frames':sum(x['frames'] for x in results),'web_bytes':sum(x['web_bytes'] for x in results),'browser_playback':'Not automatically exercised: the in-app browser reported no available browser targets.'}
    (PRODUCTION/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':'passed','clips':len(results),'sprite_frames':report['sprite_frames'],'generated_seconds':seconds}),flush=True)


if __name__=='__main__':validate()
