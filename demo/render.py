#!/usr/bin/env python3
"""Assemble the submission video from title cards, the dashboard recording and the narration.

Inputs : demo/build/narration.json (tts.py), demo/build/cards/*.png (titlecards.mjs),
         <rec>/scenes.json + <rec>/video.webm (record.mjs), demo/script.yaml
Outputs: submission/sitemind_demo.mp4 (H.264/AAC, 1920x1080, <= meta.max_total_s),
         submission/sitemind_demo.srt, submission/frames/scene_XX.png + contact_sheet.png,
         demo/build/render_report.json
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import yaml

DEMO = Path(__file__).resolve().parent
ROOT = DEMO.parent
BUILD = DEMO / "build"
FPS = 30
W, H = 1920, 1080
FONT_BOLD = next((p for p in ["/usr/share/fonts/opentype/inter/Inter-Bold.otf",
                              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
                  if Path(p).exists()), "")


def run(cmd: list[str]) -> None:
    print("[render] $", " ".join(c if len(c) < 120 else c[:117] + "..." for c in cmd))
    subprocess.run(cmd, check=True)


def ffprobe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                          "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def enc(crf: int = 16) -> list[str]:
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-r", str(FPS)]


# ------------------------------------------------------------------ planning
def plan_segments(script: dict, narr: dict, rec: dict | None) -> list[dict]:
    meta = script.get("meta", {})
    tail = float(meta.get("scene_tail_s", 0.6))
    max_speed = float(meta.get("max_speedup", 6.0))
    nmap = {s["id"]: s for s in narr["scenes"]}
    rmap = {s["id"]: s for s in (rec or {}).get("scenes", [])}
    segs = []
    for sc in script["scenes"]:
        n = nmap[sc["id"]]
        target = n["duration"] + tail
        seg = {"id": sc["id"], "title": sc.get("title", ""), "narr": n, "target": target}
        if sc.get("card"):
            seg.update(kind="card", card=sc["card"], out_dur=target + 0.4)
        else:
            r = rmap.get(sc["id"])
            if not r or "start" not in r:
                raise SystemExit(f"scene {sc['id']} missing from recording scenes.json")
            dur = r["end"] - r["start"]
            factor = min(1.0, max(target / dur, 1.0 / max_speed))
            seg.update(kind="rec", start=r["start"], end=r["end"], src_dur=dur, factor=factor,
                       out_dur=dur * factor, speed=1.0 / factor)
        segs.append(seg)
    total = sum(s["out_dur"] for s in segs)
    cap = float(meta.get("max_total_s", 178))
    if total > cap:
        # squeeze recorded scenes further (never below their narration)
        excess = total - cap
        for s in sorted((s for s in segs if s["kind"] == "rec"), key=lambda s: -s["out_dur"]):
            room = s["out_dur"] - (s["narr"]["duration"] + 0.2)
            cut = min(room, excess)
            if cut > 0:
                s["out_dur"] -= cut
                s["factor"] = s["out_dur"] / s["src_dur"]
                s["speed"] = 1.0 / s["factor"]
                excess -= cut
            if excess <= 0:
                break
        if excess > 0:
            print(f"[render] WARNING: video exceeds cap by {excess:.1f}s")
    t = 0.0
    for s in segs:
        s["offset"] = t
        t += s["out_dur"]
    return segs


# ------------------------------------------------------------------ video
def render_segment(seg: dict, video: Path | None, out: Path) -> None:
    d = seg["out_dur"]
    if seg["kind"] == "card":
        png = BUILD / "cards" / f"{seg['card']}.png"
        vf = f"scale={W}:{H},format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st={d - 0.5:.3f}:d=0.5"
        run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-framerate", str(FPS), "-i", str(png),
             "-t", f"{d:.3f}", "-vf", vf, *enc(), "-an", str(out)])
        return
    assert video is not None
    f = seg["factor"]
    vf = [f"setpts={f:.5f}*(PTS-STARTPTS)", f"fps={FPS}", f"scale={W}:{H}:flags=lanczos"]
    if seg["speed"] > 1.15 and FONT_BOLD:
        label = f"TIME-LAPSE  {seg['speed']:.1f}x"
        vf.append(
            f"drawtext=fontfile={FONT_BOLD}:text='{label}':fontsize=26:fontcolor=0x06080C:"
            "x=w-tw-48:y=40:box=1:boxcolor=0xFFB224@0.92:boxborderw=14")
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{seg['start']:.3f}", "-t",
         f"{seg['src_dur']:.3f}", "-i", str(video), "-vf", ",".join(vf), "-t", f"{d:.3f}",
         *enc(), "-an", str(out)])


# ------------------------------------------------------------------ audio
def mix_audio(segs: list[dict], total: float, out: Path) -> None:
    rate = None
    track = None
    for s in segs:
        with wave.open(s["narr"]["wav"], "rb") as wf:
            rate = rate or wf.getframerate()
            if track is None:
                track = np.zeros(int((total + 1) * rate), dtype=np.int32)
            a = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.int32)
        i = int(s["offset"] * rate)
        track[i: i + len(a)] += a[: max(0, len(track) - i)]
    assert track is not None and rate is not None
    track = np.clip(track[: int(total * rate)], -32768, 32767).astype(np.int16)
    with wave.open(str(out), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(track.tobytes())


# ------------------------------------------------------------------ subtitles
def ts_ass(t: float) -> str:
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ts_srt(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def wrap(text: str, width: int = 74) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    if len(lines) == 2 and len(lines[1]) < 12:  # avoid a lonely word on line 2
        return [text] if len(text) <= width + 10 else lines
    return lines


def build_subs(segs: list[dict], ass_path: Path, srt_path: Path) -> None:
    cues = []
    for s in segs:
        sents = s["narr"]["sentences"]
        for k, sen in enumerate(sents):
            start = s["offset"] + sen["start"]
            nxt = (s["offset"] + sents[k + 1]["start"]) if k + 1 < len(sents) else s["offset"] + s["out_dur"]
            end = min(s["offset"] + sen["end"] + 0.25, nxt - 0.02)
            cues.append((start, end, sen["text"]))
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Inter,44,&H00F9F5F2,&H00FFFFFF,&H280C0806,&H00000000,0,0,0,0,100,100,0,0,3,14,0,2,160,160,46,1
Style: Chapter,Inter,26,&H0024B2FF,&H00FFFFFF,&H280C0806,&H00000000,1,0,0,0,100,100,1,0,3,10,0,1,48,48,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    for a, b, text in cues:
        body = "\\N".join(wrap(text))
        ev.append(f"Dialogue: 0,{ts_ass(a)},{ts_ass(b)},Sub,,0,0,0,,{body}")
    for s in segs:
        if s["kind"] == "rec":
            label = f"{int(s['id']):02d}  ·  {s['title'].upper()}"
            ev.append(f"Dialogue: 1,{ts_ass(s['offset'] + 0.1)},{ts_ass(s['offset'] + min(4.5, s['out_dur'] - 0.2))},"
                      f"Chapter,,0,0,0,,{{\\fad(250,300)}}{label}")
    ass_path.write_text(header + "\n".join(ev) + "\n", encoding="utf-8")
    srt = []
    for i, (a, b, text) in enumerate(cues, 1):
        srt.append(f"{i}\n{ts_srt(a)} --> {ts_srt(b)}\n{chr(10).join(wrap(text))}\n")
    srt_path.write_text("\n".join(srt), encoding="utf-8")


# ------------------------------------------------------------------ frames
def extract_frames(final: Path, segs: list[dict], frames_dir: Path) -> list[Path]:
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    paths = []
    for s in segs:
        t = s["offset"] + s["out_dur"] * 0.7
        p = frames_dir / f"scene_{int(s['id']):02d}.png"
        run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(final), "-frames:v", "1", str(p)])
        paths.append(p)
    try:
        from PIL import Image, ImageDraw, ImageFont

        tw, th, cols = 480, 270, 5
        rows = (len(paths) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tw + (cols + 1) * 12, rows * (th + 40) + 12), (6, 8, 12))
        try:
            font = ImageFont.truetype(FONT_BOLD, 20)
        except Exception:  # noqa: BLE001
            font = ImageFont.load_default()
        d = ImageDraw.Draw(sheet)
        for i, (p, s) in enumerate(zip(paths, segs, strict=True)):
            x = 12 + (i % cols) * (tw + 12)
            y = 12 + (i // cols) * (th + 40)
            sheet.paste(Image.open(p).convert("RGB").resize((tw, th)), (x, y))
            d.text((x, y + th + 8), f"{int(s['id']):02d} {s['title']}", fill=(255, 178, 36), font=font)
        sheet.save(frames_dir / "contact_sheet.png")
    except ImportError:
        pass
    return paths


# ------------------------------------------------------------------ main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rec", default=str(BUILD / "rec"), help="dir with scenes.json + video.webm")
    ap.add_argument("--out", default=str(ROOT / "submission" / "sitemind_demo.mp4"))
    ap.add_argument("--script", default=str(DEMO / "script.yaml"))
    args = ap.parse_args()

    script = yaml.safe_load(Path(args.script).read_text())
    narr = json.loads((BUILD / "narration.json").read_text())
    rec_dir = Path(args.rec)
    rec = json.loads((rec_dir / "scenes.json").read_text())
    video = Path(rec.get("video") or rec_dir / "video.webm")
    if not video.exists():
        video = rec_dir / "video.webm"
    segs = plan_segments(script, narr, rec)
    total = sum(s["out_dur"] for s in segs)
    for s in segs:
        extra = f" src {s['src_dur']:.1f}s x{s['speed']:.2f}" if s["kind"] == "rec" else ""
        print(f"[render] scene {s['id']:>2} @ {s['offset']:6.1f}s  {s['out_dur']:5.1f}s  narr {s['narr']['duration']:5.1f}s{extra}  {s['title']}")
    print(f"[render] planned total {total:.1f}s")

    seg_dir = BUILD / "seg"
    shutil.rmtree(seg_dir, ignore_errors=True)
    seg_dir.mkdir(parents=True)
    files = []
    for s in segs:
        f = seg_dir / f"seg_{int(s['id']):02d}.mp4"
        render_segment(s, video, f)
        s["out_dur"] = ffprobe_duration(f)  # exact, after frame rounding
        files.append(f)
    t = 0.0
    for s in segs:
        s["offset"] = t
        t += s["out_dur"]
    total = t
    lst = seg_dir / "list.txt"
    lst.write_text("".join(f"file '{f.name}'\n" for f in files))
    silent = BUILD / "video_noaudio.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(silent)])

    mix = BUILD / "narration_mix.wav"
    mix_audio(segs, total, mix)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    ass = BUILD / "subs.ass"
    build_subs(segs, ass, out.with_suffix(".srt"))
    run(["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-i", str(mix),
         "-vf", f"ass={ass}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
         "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    dur = ffprobe_duration(out)
    frames = extract_frames(out, segs, out.parent / "frames")
    report = {
        "output": str(out), "duration_s": round(dur, 2), "within_3_min": dur <= 180.0,
        "segments": [{k: v for k, v in s.items() if k != "narr"} | {"narration_s": s["narr"]["duration"]}
                     for s in segs],
        "frames": [str(p) for p in frames], "run_id": rec.get("run_id"),
        "recording_warnings": {str(s["id"]): s.get("warnings") for s in rec.get("scenes", []) if s.get("warnings")},
    }
    (BUILD / "render_report.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"[render] {out} duration {dur:.2f}s ({'OK' if dur <= 180 else 'OVER 3:00!'})")


if __name__ == "__main__":
    main()
