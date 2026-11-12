#!/usr/bin/env python3
"""Make a fake recording (ffmpeg test pattern + scenes.json) to test render.py without the app.

Usage: python demo/make_dummy_recording.py && python demo/render.py --rec demo/build/rec_dummy \
           --out demo/build/dummy_demo.mp4
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

DEMO = Path(__file__).resolve().parent
OUT = DEMO / "build" / "rec_dummy"


def main() -> None:
    script = yaml.safe_load((DEMO / "script.yaml").read_text())
    narr = {s["id"]: s for s in json.loads((DEMO / "build" / "narration.json").read_text())["scenes"]}
    tail = float(script["meta"].get("scene_tail_s", 0.6))
    t = 2.0
    scenes = []
    for sc in script["scenes"]:
        if sc.get("card"):
            scenes.append({"id": sc["id"], "title": sc["title"], "card": sc["card"]})
            continue
        dur = narr[sc["id"]]["duration"] + tail + (25.0 if sc["id"] in (5, 8) else 1.0)  # long waits
        scenes.append({"id": sc["id"], "title": sc["title"], "start": t, "end": t + dur, "warnings": []})
        t += dur
    OUT.mkdir(parents=True, exist_ok=True)
    video = OUT / "video.webm"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"testsrc2=size=1920x1080:rate=25:duration={t + 1:.1f}",
                    "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8",
                    str(video)], check=True)
    (OUT / "scenes.json").write_text(json.dumps({"video": str(video), "run_id": "dummy",
                                                 "scenes": scenes}, indent=2))
    print(f"dummy recording {t:.1f}s -> {OUT}")


if __name__ == "__main__":
    main()
