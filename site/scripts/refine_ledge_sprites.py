#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=12", "scipy>=1.15"]
# ///
"""Refine existing ledge mattes and repack; archive the previous export in /tmp."""
import json
from pathlib import Path
import tempfile
from PIL import Image
from build_sprite_masters import PRODUCTION, Pages, clean_ledge_outline


def refine(name):
    folder=PRODUCTION/'sprites'/name
    metadata=json.loads((folder/'atlas.json').read_text())
    if metadata.get('ledge_outline_refined'):
        print(name,'already refined',flush=True)
        return
    temporary=Path(tempfile.mkdtemp(prefix=name+'-',dir=folder.parent))
    (temporary/'frames').mkdir()
    settings=json.loads((PRODUCTION/'sprite-selections.json').read_text())
    master=Pages(temporary/'master',settings['master_max_page_size'],'master')
    web=Pages(temporary/'web',settings['web_max_page_size'],'web')
    scale=metadata['web_scale']
    for record in metadata['frames']:
        with Image.open(folder/record['png']) as original:
            image=clean_ledge_outline(original)
        box=image.getchannel('A').getbbox()
        if not box:raise RuntimeError('Empty refined sprite')
        x0,y0,x1,y1=box
        box=(max(0,x0-4),max(0,y0-4),min(image.width,x1+4),min(image.height,y1+4))
        image=image.crop(box)
        image.save(temporary/record['png'],compress_level=3)
        rect=record['source_rect']
        record['source_rect']={'x':rect['x']+box[0],'y':rect['y']+box[1],'w':image.width,'h':image.height}
        record['master']=master.add(image)
        smaller=image.resize((round(image.width*scale),round(image.height*scale)),Image.Resampling.LANCZOS)
        record['web']=web.add(smaller)
        if record['index']%48==0:print(name,record['index'],flush=True)
    master.finish();web.finish()
    metadata['master_pages']=master.pages;metadata['web_pages']=web.pages
    metadata['ledge_outline_refined']=True
    metadata['notes'].append('Thin blue-prop outline removed using foreground-core proximity; native body pixels and timing retained.')
    (temporary/'atlas.json').write_text(json.dumps(metadata,indent=2)+'\n')
    archive=Path(tempfile.mkdtemp(prefix='elwood-before-ledge-refinement-'))/name
    folder.rename(archive)
    temporary.rename(folder)
    print(json.dumps({'clip':name,'web_pages':len(web.pages),'web_bytes':sum(p['bytes'] for p in web.pages),'previous_export':str(archive)}),flush=True)


if __name__=='__main__':
    for name in ['06-grab-hang','07-climb','08-step-down']:refine(name)
