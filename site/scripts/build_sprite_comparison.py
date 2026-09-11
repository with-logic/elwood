#!/usr/bin/env python3
"""Slice the direct-sheet experiment and a video gait into comparable loop assets.

Requires Pillow and ffmpeg. This is deterministic extraction/registration, not
new artwork. Original images/videos are retained. The direct sheet's incorrect
leg ordering is intentionally preserved for review.
"""
import json
import statistics
import subprocess
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/production/sprite-test"
SIZE = 384
BASELINE = 350


def key_magenta(image):
    rgb = image.convert("RGB")
    r, g, b = rgb.split()
    excess = ImageChops.darker(ImageChops.subtract(r, g), ImageChops.subtract(b, g))
    alpha = ImageChops.invert(excess).point(lambda value: 0 if value < 24 else value)
    # Remove magenta contamination at semitransparent antialiased edges.
    pixels = bytearray()
    for (red, green, blue), a in zip(rgb.getdata(), alpha.getdata()):
        if not a:
            pixels.extend((0, 0, 0, 0))
        elif a < 255:
            opacity = a / 255
            pixels.extend((max(0, min(255, round((red - 255 * (1-opacity)) / opacity))),
                           max(0, min(255, round(green / opacity))),
                           max(0, min(255, round((blue - 255 * (1-opacity)) / opacity))), a))
        else:
            pixels.extend((red, green, blue, 255))
    return Image.frombytes("RGBA", rgb.size, bytes(pixels))


def solid_bounds(image):
    return image.getchannel("A").point(lambda value: 255 if value >= 150 else 0).getbbox()


def register(frames):
    boxes = [solid_bounds(frame) for frame in frames]
    scale = 300 / statistics.median(box[3]-box[1] for box in boxes)
    result = []
    for frame, box in zip(frames, boxes):
        x0,y0,x1,y1 = box
        top = frame.crop((x0,y0,x1,min(y1,y0+18)))
        socket = solid_bounds(top)
        anchor_x = x0 + (socket[0]+socket[2])/2
        # A fixed scale within each take preserves limb size and the gait bob.
        resized = frame.resize((round(frame.width*scale), round(frame.height*scale)), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (SIZE,SIZE))
        canvas.alpha_composite(resized, (round(SIZE/2-anchor_x*scale), round(BASELINE-y1*scale)))
        result.append(canvas)
    return result


def export(name, frames, metadata):
    folder = OUT / name
    folder.mkdir(exist_ok=True)
    atlas = Image.new("RGBA", (SIZE*8,SIZE*((len(frames)+7)//8)))
    gif_frames=[]
    for i,frame in enumerate(frames):
        frame.save(folder/f"{i:02d}.png")
        atlas.alpha_composite(frame, ((i%8)*SIZE,(i//8)*SIZE))
        cream=Image.new("RGB",frame.size,"#f5f0e6")
        cream.paste(frame,mask=frame.getchannel("A"))
        gif_frames.append(cream)
    atlas.save(OUT/f"{name}.png")
    gif_frames[0].save(OUT/f"{name}.gif",save_all=True,append_images=gif_frames[1:],duration=round(1400/len(frames)),loop=0,disposal=2)
    metadata.update(count=len(frames),cell=SIZE,columns=8,atlas=f"{name}.png",baseline=BASELINE,preview_cycle_seconds=1.4)
    return metadata


def main():
    sheet=Image.open(OUT/"generated-walk-sheet.png")
    # Equal-grid slicing would clip the first foot: the generated spacing drifts.
    # These boundaries are in the empty gaps observed in the actual output.
    xs=[0,430,760,1100,1536]
    direct=[key_magenta(sheet.crop((xs[col],row*512,xs[col+1],(row+1)*512))) for row in range(2) for col in range(4)]
    direct=register(direct)
    direct_meta=export("direct-sheet",direct,{"decision":"reject for locomotion","reason":"Repeated leading leg; requested contact/passing phases missing. Uneven spacing required custom slices."})

    raw=OUT/"video-raw"
    raw.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-ss","3","-i",str(ROOT/"assets/production/runs/02-walk-right/source.mp4"),"-t","4.8","-vf","fps=12,scale=360:-1",str(raw/"%03d.png")],check=True)
    video=register([key_magenta(Image.open(path)) for path in sorted(raw.glob("*.png"))])
    small=[frame.convert("RGB").crop((0,170,SIZE,SIZE)).resize((96,54)) for frame in video]
    candidates=[]
    # Find similar lower-body endpoints about one complete gait apart. This only
    # proposes a loop; final sprite assembly still needs precise gait review.
    for start in range(len(video)-22):
        for length in range(14,23):
            end=start+length
            if end >= len(video):continue
            error=sum(ImageStat.Stat(ImageChops.difference(small[start],small[end])).mean)
            candidates.append((error,start,length))
    error,start,length=min(candidates)
    video_meta=export("video-cycle",video[start:start+length],{"decision":"candidate loop","source":"../runs/02-walk-right/source.mp4","start_seconds":3+start/12,"end_seconds":3+(start+length)/12,"sampling_fps":12,"endpoint_difference_score":error,"note":"Automatically proposed by repeated lower-body pose; alignment and loop seam need final production review."})
    (OUT/"comparison.json").write_text(json.dumps({"direct":direct_meta,"video":video_meta},indent=2)+"\n")
    print(json.dumps({"direct_frames":len(direct),"video_frames":length,"video_start":video_meta['start_seconds'],"video_end":video_meta['end_seconds']}))


if __name__ == "__main__":
    main()
