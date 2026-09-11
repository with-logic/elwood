#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12"]
# ///
"""Check gameplay atlas geometry and connector attachment against real alpha."""
import json
from pathlib import Path
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
GAME=ROOT/'assets/game'


def main():
    manifest=json.loads((GAME/'manifest.json').read_text())
    pages={};count=0
    angles=manifest['rotation_angles']
    assert angles==sorted(angles) and angles[0]==-180 and angles[-1]==180
    assert max(np.diff(angles))<=8, 'Rotation coverage has a visible angular gap'
    for name,info in manifest['clips'].items():
        clip=json.loads((GAME/info['url']).read_text())
        assert len(clip['frames'])==info['frames']
        for page in clip['pages']:
            path=(GAME/name/page['file']).resolve()
            assert path.is_relative_to(GAME)
            if path in pages:continue
            with Image.open(path) as im:
                assert im.mode=='RGBA' and im.size==(page['width'],page['height'])
                assert max(im.size)<=2048
                pages[path]=np.array(im.getchannel('A'))
        for frame in clip['frames']:
            page=clip['pages'][frame['page']]
            assert frame['x']>=0 and frame['y']>=0
            assert frame['x']+frame['w']<=page['width']
            assert frame['y']+frame['h']<=page['height']
            # Atlas-local attachment coordinates must touch the actual robot,
            # with two pixels allowed for rounding and antialiasing at the tip.
            x=frame['x']+round(frame['anchor']['x']+frame['socket']['x'])
            y=frame['y']+round(frame['anchor']['y']+frame['socket']['y'])
            alpha=pages[(GAME/name/page['file']).resolve()]
            neighborhood=alpha[max(0,y-2):y+3,max(0,x-2):x+3]
            assert neighborhood.size and neighborhood.max()>=100, f'Detached connector: {name}/{frame.get("source_index")}'
            count+=1
    result={'gameplay_frames':count,'unique_pages':len(pages),'socket_alpha_failures':0,'rotation_coverage':[-180,180],'visual_review':'docs/reviews/connector-overview.png'}
    (ROOT/'assets/production/game-validation.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
