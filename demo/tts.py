#!/usr/bin/env python3
"""Synthesise the demo narration offline with Piper (fallback: espeak-ng).

For every scene in demo/script.yaml each sentence is synthesised separately so subtitle timing is
exact. Output:
  demo/build/audio/scene_XX.wav     narration for the scene (lead silence + sentences + gaps)
  demo/build/narration.json         per-scene durations and per-sentence [start, end] offsets
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
import yaml

DEMO = Path(__file__).resolve().parent
RATE = 22050


def load_script(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def _read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        sr, ch, sw = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16 if sw == 2 else np.uint8)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype(np.int16)
    if sr != RATE:  # simple linear resample (only used by the espeak fallback)
        x = np.linspace(0, len(data) - 1, int(len(data) * RATE / sr))
        data = np.interp(x, np.arange(len(data)), data).astype(np.int16)
    return data.astype(np.int16)


def write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(RATE)
        wf.writeframes(samples.astype(np.int16).tobytes())


class Synth:
    def __init__(self, voice: str, length_scale: float) -> None:
        self.length_scale = length_scale
        self.engine = "piper"
        model = DEMO / "voices" / f"{voice}.onnx"
        try:
            from piper import PiperVoice, SynthesisConfig

            if not model.exists():
                raise FileNotFoundError(f"{model} missing - run scripts/download_voices.sh")
            self.voice = PiperVoice.load(str(model))
            self.cfg = SynthesisConfig(length_scale=length_scale)
            global RATE
            RATE = self.voice.config.sample_rate
        except Exception as exc:  # noqa: BLE001
            if not shutil.which("espeak-ng"):
                raise SystemExit(f"Piper unavailable ({exc}) and espeak-ng not installed") from exc
            print(f"[tts] Piper unavailable ({exc}); falling back to espeak-ng", file=sys.stderr)
            self.engine = "espeak-ng"

    def say(self, text: str) -> np.ndarray:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "s.wav"
            if self.engine == "piper":
                with wave.open(str(out), "wb") as wf:
                    self.voice.synthesize_wav(text, wf, syn_config=self.cfg)
            else:
                wpm = int(165 / self.length_scale)
                subprocess.run(["espeak-ng", "-v", "en-us", "-s", str(wpm), "-w", str(out), text],
                               check=True)
            return _read_wav(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", default=str(DEMO / "script.yaml"))
    ap.add_argument("--out", default=str(DEMO / "build"))
    args = ap.parse_args()

    script = load_script(Path(args.script))
    meta = script.get("meta", {})
    out = Path(args.out)
    synth = Synth(meta.get("voice", "en_US-lessac-high"), float(meta.get("length_scale", 1.0)))
    gap = np.zeros(int(RATE * float(meta.get("sentence_gap_s", 0.28))), dtype=np.int16)
    lead = np.zeros(int(RATE * float(meta.get("scene_lead_s", 0.35))), dtype=np.int16)

    result: dict = {"engine": synth.engine, "rate": RATE, "scenes": []}
    total = 0.0
    for scene in script["scenes"]:
        parts = [lead]
        cursor = len(lead)
        sentences = []
        for item in scene.get("narration", []):
            item = {"text": item} if isinstance(item, str) else item
            audio = synth.say(item.get("say") or item["text"])
            # trim leading/trailing near-silence so gaps are consistent
            nz = np.nonzero(np.abs(audio) > 200)[0]
            if len(nz):
                audio = audio[max(0, nz[0] - 400): nz[-1] + 1200]
            start = cursor / RATE
            parts.append(audio)
            cursor += len(audio)
            sentences.append({"text": item["text"], "start": round(start, 3),
                              "end": round(cursor / RATE, 3)})
            parts.append(gap)
            cursor += len(gap)
        samples = np.concatenate(parts)
        wav = out / "audio" / f"scene_{int(scene['id']):02d}.wav"
        write_wav(wav, samples)
        dur = len(samples) / RATE
        total += dur
        result["scenes"].append({"id": scene["id"], "title": scene.get("title", ""),
                                 "wav": str(wav), "duration": round(dur, 3),
                                 "sentences": sentences})
        print(f"[tts] scene {scene['id']:>2}: {dur:6.2f}s  {scene.get('title', '')}")
    result["total_narration_s"] = round(total, 2)
    (out / "narration.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"[tts] total narration {total:.1f}s ({synth.engine}) -> {out / 'narration.json'}")


if __name__ == "__main__":
    main()
