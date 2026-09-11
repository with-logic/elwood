#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "opencv-python-headless>=4.12", "pillow>=12"]
# ///
"""Measure the cartwheel's backward contact sweep for forward world travel.

Use only hands/feet that remain close to the reviewed source floor. Forward /
backward optical-flow agreement rejects new contacts and swinging limbs. The
stored trajectory is in source pixels; gameplay converts it to character scale.
"""
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

PRODUCTION = Path(__file__).resolve().parents[1] / 'assets/production'
NAME = '32-cartwheel'


def track():
    atlas = json.loads((PRODUCTION / 'sprites' / NAME / 'atlas.json').read_text())
    width = 720
    scale = width / atlas['source_size']['w']
    floor = atlas['neutral_anchor']['y'] * width / atlas['source_size']['w']
    top, bottom = round(floor - 35), round(floor + 14)
    offsets = [0.0]
    samples = [0]
    shifts = [0.0]

    def load(index):
        record = atlas['frames'][index]
        with Image.open(PRODUCTION / 'sprites' / NAME / record['png']) as image:
            rgba = np.array(image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS))
        alpha = rgba[:, :, 3:4] / 255
        gray = cv2.cvtColor(np.rint(rgba[:, :, :3] * alpha + 245 * (1 - alpha)).astype(np.uint8), cv2.COLOR_RGB2GRAY)
        canvas = np.full((round(atlas['source_size']['h'] * scale) + 2, width + 2), 245, np.uint8)
        mask = np.zeros_like(canvas)
        x, y = (round(record['source_rect'][axis] * scale) for axis in ['x', 'y'])
        canvas[y:y + gray.shape[0], x:x + gray.shape[1]] = gray
        mask[y:y + gray.shape[0], x:x + gray.shape[1]] = rgba[:, :, 3]
        mask[:top] = 0; mask[bottom:] = 0
        return canvas, mask

    # Track the actual upscaled cutouts. The upscaler slightly changes framing,
    # so applying a 720p contact band to the 4K origin would mix coordinate systems.
    a, mask = load(0)
    for index in range(1, atlas['frame_count']):
        b, next_mask = load(index)
        corners = cv2.goodFeaturesToTrack(a, 100, .01, 5, mask=mask)
        if corners is None:
            raise RuntimeError(f'No grounded contact features at {index}')
        tracked, status, _ = cv2.calcOpticalFlowPyrLK(a, b, corners, None, winSize=(21, 21), maxLevel=3)
        reverse, back_status, _ = cv2.calcOpticalFlowPyrLK(b, a, tracked, None, winSize=(21, 21), maxLevel=3)
        motion = (tracked - corners).reshape(-1, 2)
        end = tracked.reshape(-1, 2)
        valid = (status.ravel() == 1) & (back_status.ravel() == 1)
        valid &= np.linalg.norm((reverse - corners).reshape(-1, 2), axis=1) < 1
        valid &= (abs(motion[:, 1]) < 2) & (abs(motion[:, 0]) < 15)
        valid &= (end[:, 1] > top) & (end[:, 1] < bottom)
        if valid.sum() < 5:
            raise RuntimeError(f'Insufficient continuing ground contacts at {index}')
        dx = float(np.median(motion[valid, 0]))
        # The opening / closing stance has only subpixel codec jitter.
        if abs(dx) < .12:
            dx = 0.0
        shifts.append(round(dx, 4))
        offsets.append(round(offsets[-1] - dx, 4))
        samples.append(int(valid.sum()))
        a, mask = b, next_mask
    return {'source_width': width, 'source_floor_y': floor, 'contact_band_y': [top, bottom],
            'offset_x': offsets, 'contact_dx': shifts, 'matched_points': samples}


if __name__ == '__main__':
    result = track()
    path = PRODUCTION / 'ground-motion.json'
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        data = {}
    data[NAME] = result
    path.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'clip': NAME, 'frames': len(result['offset_x']),
                      'source_travel_px': result['offset_x'][-1],
                      'minimum_contact_matches': min(result['matched_points'][1:])}))
