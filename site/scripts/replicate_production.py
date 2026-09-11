#!/usr/bin/env python3
"""Small, resumable Replicate production runner. Paid submissions are never retried.

Credentials stay in the environment and are passed to curl through stdin, never
through process arguments, saved requests, or printed output. Each submission
reserves duration before contacting Replicate; ambiguous failures remain reserved.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
PRODUCTION = ROOT / "assets/production"
RUNS = PRODUCTION / "runs"
API = "https://api.replicate.com/v1"
MAX_SECONDS = 600


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def read(path):
    return json.loads(path.read_text())


def curl_config(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'


def api(method, path, payload=None, upload=None):
    key = os.environ.get("REPLICATE_API_KEY") or os.environ.get("REPLICATE_API_TOKEN")
    if not key:
        raise RuntimeError("Set REPLICATE_API_KEY or REPLICATE_API_TOKEN in the environment.")
    config = "url = " + curl_config(API + path) + "\nheader = " + curl_config("Authorization: Bearer " + key) + "\n"
    args = ["curl", "-sS", "--max-time", "55", "--request", method, "--config", "-", "--write-out", "\n%{http_code}"]
    with tempfile.TemporaryDirectory(prefix="elwood-request-") as directory:
        if payload is not None:
            body = Path(directory) / "body.json"
            body.write_text(json.dumps(payload))
            args += ["--header", "Content-Type: application/json", "--data-binary", "@" + str(body)]
        if upload:
            args += ["--form", "content=@" + str(upload)]
        result = subprocess.run(args, input=config, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Network request did not complete. Do not repeat a POST without checking Replicate. " + result.stderr.replace(key, "[redacted]")[:300])
    body, status = result.stdout.rsplit("\n", 1)
    if not 200 <= int(status) < 300:
        raise RuntimeError("Replicate HTTP " + status + ": " + body.replace(key, "[redacted]")[:1200])
    return json.loads(body)


def output_url(prediction):
    output = prediction.get("output")
    if isinstance(output, str) and output.startswith("https://"):
        return output
    if isinstance(output, list):
        return next((item for item in output if isinstance(item, str) and item.startswith("https://")), None)
    if isinstance(output, dict):
        return next((item for item in output.values() if isinstance(item, str) and item.startswith("https://") and ".mp4" in item), None)
    return None


def download(prediction, destination):
    url = output_url(prediction)
    if not url:
        raise RuntimeError("Succeeded prediction has no recognized video output; inspect saved prediction.")
    if destination.exists():
        return
    temporary = destination.with_suffix(".part.mp4")
    subprocess.run(["curl", "--fail", "-sS", "-L", "--max-time", "300", "--retry", "2", "--output", str(temporary), url], check=True)
    subprocess.run(["ffprobe", "-v", "error", str(temporary)], check=True, capture_output=True)
    temporary.replace(destination)


def budget():
    return sum(read(p)["seconds"] for p in RUNS.glob("*/submission.json"))


def submit(name):
    plan = read(PRODUCTION / "plan.json")
    clip = next(item for item in plan["clips"] if item["name"] == name)
    folder = RUNS / name
    folder.mkdir(parents=True, exist_ok=True)
    with (RUNS / ".submission.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        marker = folder / "submission.json"
        if marker.exists():
            raise RuntimeError("Already reserved/submitted: " + name + ". Inspect this run; never submit it twice.")
        spent = budget()
        if spent + clip["seconds"] > MAX_SECONDS:
            raise RuntimeError(f"{MAX_SECONDS}-second generation cap would be exceeded.")
        upload = read(PRODUCTION / clip.get("reference_upload", "reference/upload.json"))
        image = upload["urls"]["get"]
        prompt = (PRODUCTION / "briefs/common.txt").read_text() + "\n\n" + (PRODUCTION / clip["brief"]).read_text()
        inputs = {"prompt": prompt, "duration": clip["seconds"], "seed": clip["seed"], "watermark": False, "resolution": "720p", "output_format": "mp4", "generate_audio": False}
        if clip.get("reference_mode") == "reference":
            inputs.update(reference_images=[image], aspect_ratio="9:16")
        else:
            inputs.update(image=image, aspect_ratio="adaptive")
            if clip.get("end_at_start"):
                inputs["last_frame_image"] = image
            elif clip.get("last_reference_upload"):
                inputs["last_frame_image"] = read(PRODUCTION / clip["last_reference_upload"])["urls"]["get"]
        save(folder / "request.json", {"input": inputs})
        save(marker, {"seconds": clip["seconds"], "reserved_at": datetime.now(timezone.utc).isoformat(), "model": "bytedance/seedance-2.5"})
        prediction = api("POST", "/models/bytedance/seedance-2.5/predictions", {"input": inputs})
        save(folder / "prediction.json", prediction)
    print(json.dumps({"name": name, "id": prediction["id"], "status": prediction["status"], "seconds_reserved": budget(), "cap": MAX_SECONDS}), flush=True)


def poll():
    for folder in sorted(RUNS.iterdir()):
        if not folder.is_dir():
            continue
        for stage in ["prediction", "upscale"]:
            path = folder / (stage + ".json")
            if not path.exists():
                continue
            prediction = read(path)
            if prediction["status"] not in ["succeeded", "failed", "canceled"]:
                prediction = api("GET", "/predictions/" + prediction["id"])
                save(path, prediction)
            destination = folder / ("source.mp4" if stage == "prediction" else "4k.mp4")
            if prediction["status"] == "succeeded":
                download(prediction, destination)
            print(json.dumps({"name": folder.name, "stage": stage, "status": prediction["status"], "error": prediction.get("error"), "local_file": str(destination.relative_to(ROOT)) if destination.exists() else None}), flush=True)


def upscale(name):
    folder = RUNS / name
    review = read(folder / "review.json")
    if review.get("decision") != "accept":
        raise RuntimeError("Upscaling requires an explicit accepted visual review.")
    with (RUNS / ".submission.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        marker = folder / "upscale-request.json"
        if marker.exists():
            raise RuntimeError("Upscale already reserved/submitted; inspect this run.")
        prediction = read(folder / "prediction.json")
        if prediction["status"] != "succeeded":
            raise RuntimeError("Source generation has not succeeded.")
        inputs = {"scene": "aigc", "video": output_url(prediction), "processing_type": "standard", "target_resolution": "4k", "target_fps": 24}
        if not inputs["video"]:
            raise RuntimeError("Source video URL is missing.")
        save(marker, {"input": inputs})
        result = api("POST", "/models/bytedance/video-upscaler/predictions", {"input": inputs})
        save(folder / "upscale.json", result)
    print(json.dumps({"name": name, "upscale_id": result["id"], "status": result["status"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    upload_parser = commands.add_parser("upload")
    upload_parser.add_argument("file", type=Path)
    upload_parser.add_argument("--record", type=Path, default=PRODUCTION / "reference/upload.json")
    for command in ["submit", "upscale"]:
        commands.add_parser(command).add_argument("name")
    commands.add_parser("poll")
    commands.add_parser("budget")
    args = parser.parse_args()
    if args.command == "upload":
        if args.record.exists():
            raise RuntimeError("Upload record already exists; reuse it.")
        result = api("POST", "/files", upload=args.file.resolve())
        save(args.record, result)
        print(json.dumps({"uploaded": args.file.name, "bytes": result["size"], "record": str(args.record)}))
    elif args.command == "submit":
        submit(args.name)
    elif args.command == "poll":
        poll()
    elif args.command == "upscale":
        upscale(args.name)
    elif args.command == "budget":
        print(json.dumps({"seconds_reserved": budget(), "seconds_remaining": MAX_SECONDS - budget(), "cap": MAX_SECONDS}))


if __name__ == "__main__":
    main()
