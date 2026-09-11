#!/usr/bin/env python3
"""Build the local production index from files that actually exist."""
import html
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PRODUCTION=ROOT/'assets/production'


def main():
    plan=json.loads((PRODUCTION/'plan.json').read_text())
    clips=[];cards=[]
    for clip in plan['clips']:
        name=clip['name'];run=PRODUCTION/'runs'/name
        if not (run/'prediction.json').exists():continue
        prediction=json.loads((run/'prediction.json').read_text())
        review=json.loads((run/'review.json').read_text()) if (run/'review.json').exists() else {}
        atlas_path=PRODUCTION/'sprites'/name/'atlas.json'
        atlas=json.loads(atlas_path.read_text()) if atlas_path.exists() else None
        source=(run/'source.mp4').exists();upscaled=(run/'4k.mp4').exists()
        graded=(run/'graded.mp4').exists()
        video_file='graded.mp4' if graded else 'source.mp4'
        master_file='4k-graded.mp4' if graded else '4k.mp4'
        review_folder='review-frames-graded' if graded else 'review-frames'
        contact_file='contact-graded.png' if graded else 'contact.png'
        item={'name':name,'title':name[3:].replace('-',' ').title(),'generated_seconds':clip['seconds'],'source_available':source,'upscaled':upscaled,'review':review,'sprite_available':bool(atlas)}
        if atlas:item.update(sprite_frames=atlas['frame_count'],web_bytes=sum(p['bytes'] for p in atlas['web_pages']),master_pages=len(atlas['master_pages']),web_pages=len(atlas['web_pages']))
        clips.append(item)
        links=[]
        if source:links.append(f'<a href="../runs/{name}/{video_file}">720p video</a>')
        if upscaled:links.append(f'<a href="../runs/{name}/{master_file}">4K master</a>')
        if (run/'color-comparison.png').exists():links.append(f'<a href="../runs/{name}/color-comparison.png">Before / after color</a>')
        if (run/contact_file).exists():links.append(f'<a href="../runs/{name}/{contact_file}">Lossless contact sheet</a>')
        if (run/review_folder).exists():links.append(f'<a href="../runs/{name}/{review_folder}/frame-07.png">Native source still</a>')
        links.append(f'<a href="../{clip["brief"]}">Production brief</a>')
        if atlas:links.append(f'<a href="../sprites/player.html?clip={name}">Play 24 fps sprites</a>')
        poster=f' poster="../runs/{name}/{review_folder}/frame-00.png"' if (run/review_folder/'frame-00.png').exists() else ''
        media=f'<video controls playsinline preload="none"{poster} src="../runs/{name}/{video_file}"></video>' if source else '<p>Generating…</p>'
        status='4K master ready / 24 fps' if upscaled else 'Rejected / source retained' if review.get('decision')=='reject' else prediction['status']
        sprite_note=f'{atlas["frame_count"]} sprite frames · {item["web_bytes"]/1048576:.2f} MiB web pages · native PNG masters' if atlas else 'Not selected for gameplay' if review.get('decision')=='reject' else 'Sprite export pending'
        summary=html.escape(review.get('summary','Awaiting visual review.'))
        caveats=' '.join(review.get('caveats',[]))
        cards.append(f'<article id="{name}"><h2>{html.escape(item["title"])}</h2><p class="meta">{clip["seconds"]} seconds · {status}</p>{media}<p>{summary}</p><p class="meta">{sprite_note}</p><p class="links">'+ ' · '.join(links)+f'</p><details><summary>Extraction notes</summary><p>{html.escape(caveats)}</p></details></article>')
    requested=sum(json.loads(p.read_text())['seconds'] for p in (PRODUCTION/'runs').glob('*/submission.json'))
    cap=plan['generation_cap_seconds']
    data={'generated_seconds':requested,'cap_seconds':cap,'remaining_seconds':cap-requested,'clips':clips,'sprite_frames':sum(c.get('sprite_frames',0) for c in clips),'web_bytes':sum(c.get('web_bytes',0) for c in clips)}
    (PRODUCTION/'inventory.json').write_text(json.dumps(data,indent=2)+'\n')
    content='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Elwood · production library</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f5f0e6;color:#272922;font:16px/1.5 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:40px 24px}h1{font:500 44px/1.1 Georgia,serif;margin:0 0 18px}h2{font-size:23px;margin:0}.intro{max-width:860px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:24px;margin-top:32px}article{padding:20px;border:1px solid #cbc7bc;background:#faf7ef}video{display:block;width:100%;height:410px;background:#eee9df;object-fit:contain}.meta{font-size:13px;color:#586050}.links{font-size:14px;line-height:1.9}a{color:#284d45;text-underline-offset:3px}details{font-size:13px}summary{cursor:pointer}@media(max-width:600px){main{padding:24px 16px}h1{font-size:35px}}</style>
<main><h1>Elwood’s movement library</h1><div class="intro">'''
    content+='<p><a href="../../../index.html">Explore the interactive playground</a></p>'
    content+=f'<p>{len(clips)} focused takes · <strong>{requested} / {cap} generated seconds</strong> · 4K masters at native 24 fps.</p>'
    content+='<p>Cards play the 720p source videos; each has a link to its 4K master. Sprite masters retain selected consecutive frames at their original pixel dimensions. The separate browser sheets preserve 24 fps with a smaller fixed display scale. Each video plays only when requested; starting another pauses the previous one.</p><p><a href="../sprites/player.html?clip=02-walk-right">Open the sprite player</a> · <a href="../sprite-test/index.html">Direct-sheet experiment</a> · <a href="../README.md">Files and production notes</a></p></div><div class="grid">'+''.join(cards)+'</div></main>'
    content+='''<script>document.addEventListener('play',event=>{if(event.target.tagName==='VIDEO')document.querySelectorAll('video').forEach(video=>{if(video!==event.target)video.pause();});},true);document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(video=>video.pause());});</script></html>'''
    (PRODUCTION/'review').mkdir(exist_ok=True)
    (PRODUCTION/'review/index.html').write_text(content)
    print(json.dumps({'clips':len(clips),'upscaled':sum(c['upscaled'] for c in clips),'sprite_clips':sum(c['sprite_available'] for c in clips),'sprite_frames':data['sprite_frames'],'web_mib':round(data['web_bytes']/1048576,2)}))


if __name__=='__main__':main()
