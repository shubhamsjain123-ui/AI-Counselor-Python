"""
SABCQ AI Counselor - MuseTalk Cloud GPU Live Server v3.0 (Phase 1)

Phase 1:
  - WARM in-process MuseTalk 1.5 engine (models stay on GPU)
  - Subprocess fallback ONLY if warm load fails
  - NEVER pass --skip_save_images (that skipped writing MP4 → stale career clips!)
  - Mandatory Gemini WAV remux + duration checks + PCM hash cache
"""

import os
import sys
import json
import glob
import hashlib
import shutil
import tempfile
import subprocess
import time
import uuid
import base64
import wave
import numpy as np
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from typing import Optional, Dict, Tuple, Set
from pydantic import BaseModel

app = FastAPI(
    title="SABCQ AI Counselor - MuseTalk Live Engine",
    description="Warm MuseTalk 1.5 + mandatory Gemini-audio remux",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

AVATAR_VIDEO_PATH = (
    "data/video/priya_sharma_base.mp4"
    if os.path.exists("data/video/priya_sharma_base.mp4")
    else "/content/priya_sharma_base.mp4"
)

BBOX_SHIFT = int(os.environ.get("MUSETALK_BBOX_SHIFT", "0"))
BATCH_SIZE = int(os.environ.get("MUSETALK_BATCH_SIZE", "16"))
CACHE_DIR = os.environ.get("MUSETALK_CACHE_DIR", "results/sabcq_pcm_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

_INFERENCE_LOCK = None
_WARM_MODE = "unknown"  # warm | subprocess | failed


def _get_lock():
    global _INFERENCE_LOCK
    if _INFERENCE_LOCK is None:
        import threading

        _INFERENCE_LOCK = threading.Lock()
    return _INFERENCE_LOCK


class GeneratePcmRequest(BaseModel):
    pcm_base64: str
    sample_rate: int = 24000
    avatar_id: str = "avator_1"
    request_id: Optional[str] = None
    beat_id: Optional[int] = None


def _avatar_cached() -> bool:
    return (
        os.path.exists("results/v15/avatars/avator_1/coords.pkl")
        or os.path.exists("results/avatars/avator_1/coords.pkl")
        or os.path.exists("results/realtime/avator_1/coords.pkl")
    )


def _pcm_cache_key(pcm_bytes: bytes, sample_rate: int) -> str:
    h = hashlib.sha1()
    h.update(str(sample_rate).encode())
    h.update(b"|")
    h.update(pcm_bytes)
    h.update(f"|bbox={BBOX_SHIFT}|v30warm".encode())
    return h.hexdigest()


def _snapshot_mp4s() -> Dict[str, Tuple[int, float]]:
    snap: Dict[str, Tuple[int, float]] = {}
    for p in glob.glob("results/**/*.mp4", recursive=True):
        if os.path.abspath(CACHE_DIR) in os.path.abspath(p):
            continue
        try:
            st = os.stat(p)
            snap[os.path.abspath(p)] = (st.st_size, st.st_mtime)
        except OSError:
            pass
    return snap


def _wav_duration_sec(wav_path: str) -> float:
    with wave.open(wav_path, "rb") as wf:
        return wf.getnframes() / float(wf.getframerate() or 16000)


def _ffprobe_duration(path: str) -> Optional[float]:
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if res.returncode != 0:
            return None
        return float(res.stdout.strip())
    except Exception:
        return None


def remux_video_with_audio(video_path: str, wav_path: str, output_path: str) -> bool:
    tmp_out = output_path + ".remux.mp4"
    for cmd in (
        [
            "ffmpeg", "-y", "-i", video_path, "-i", wav_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", tmp_out,
        ],
        [
            "ffmpeg", "-y", "-i", video_path, "-i", wav_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", tmp_out,
        ],
    ):
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 1000:
            shutil.move(tmp_out, output_path)
            print(f"[Remux OK] {output_path}")
            return True
        print(f"[Remux try failed] {(res.stderr or '')[-300:]}")
    return False


def _pick_new_mp4(before: Dict[str, Tuple[int, float]], clip_key: str, start_time: float) -> Optional[str]:
    after = _snapshot_mp4s()
    changed: Set[str] = set()
    for p, meta in after.items():
        if p not in before or before[p] != meta:
            if meta[1] >= start_time - 1.0:
                changed.add(p)
    if not changed:
        changed = set(after.keys()) - set(before.keys())
    if not changed:
        return None
    preferred = [
        p for p in changed
        if clip_key in os.path.basename(p) or f"/{clip_key}." in p.replace("\\", "/")
    ]
    pool = [p for p in (preferred or list(changed)) if after.get(p, (0, 0))[0] > 5000]
    if not pool:
        return None
    return max(pool, key=lambda p: after[p][1])


def _ensure_warm_engine():
    global _WARM_MODE
    try:
        from musetalk_warm_engine import get_warm_engine

        eng = get_warm_engine(AVATAR_VIDEO_PATH, BBOX_SHIFT, BATCH_SIZE)
        if eng and eng.ready:
            _WARM_MODE = "warm"
            return eng
    except Exception as e:
        print(f"[WarmEngine] import/load failed: {e}")
    _WARM_MODE = "subprocess"
    return None


def run_musetalk_inference(input_audio_path: str, output_video_path: str, request_id: str) -> bool:
    abs_audio_src = os.path.abspath(input_audio_path)
    abs_video = os.path.abspath(AVATAR_VIDEO_PATH)
    clip_key = f"audio_{request_id}".replace("-", "_")[:48]
    has_cache = _avatar_cached()

    work_dir = tempfile.mkdtemp(prefix=f"mtjob_{clip_key}_")
    unique_wav = os.path.join(work_dir, f"{clip_key}.wav")
    shutil.copyfile(abs_audio_src, unique_wav)
    wav_dur = _wav_duration_sec(unique_wav)
    raw_out = os.path.join(work_dir, "raw.mp4")

    start_time = time.time()
    print(
        f"[Inference Start] id={request_id} clip={clip_key} wav_dur={wav_dur:.2f}s "
        f"bbox={BBOX_SHIFT} batch={BATCH_SIZE}"
    )

    # --- Prefer WARM in-process path ---
    eng = _ensure_warm_engine()
    success_raw = False
    latest_vid = None

    if eng is not None:
        print("[Inference] using WARM MuseTalk 1.5 engine")
        success_raw = eng.infer(unique_wav, raw_out, clip_key)
        if success_raw and os.path.exists(raw_out):
            latest_vid = raw_out
        else:
            print("[Inference] warm path failed — falling back to subprocess")
            success_raw = False

    # --- Subprocess fallback (loads models every time — slow) ---
    if not success_raw:
        global _WARM_MODE
        _WARM_MODE = "subprocess"
        if not has_cache:
            print("[Inference Notice] Avatar landmarks not cached yet. Running preparation...")

        cfg = {
            "avator_1": {
                "preparation": not has_cache,
                "bbox_shift": BBOX_SHIFT,
                "video_path": abs_video,
                "audio_clips": {clip_key: unique_wav},
            }
        }
        temp_cfg_path = os.path.join(work_dir, "infer.yaml")
        import yaml

        with open(temp_cfg_path, "w") as f:
            yaml.dump(cfg, f)

        # CRITICAL: do NOT pass --skip_save_images — that skips writing MP4 and caused stale clips
        cmd = [
            sys.executable,
            "-m",
            "scripts.realtime_inference",
            "--inference_config",
            temp_cfg_path,
            "--batch_size",
            str(BATCH_SIZE),
            "--version",
            "v15",
        ]
        env = os.environ.copy()
        env["MPLBACKEND"] = "Agg"
        # Avoid interactive y/n prompts during preparation
        env["MUSETALK_NONINTERACTIVE"] = "1"

        before = _snapshot_mp4s()
        # Feed 'n' to any accidental input() prompts
        res = subprocess.run(
            cmd,
            input="n\n" * 5,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        if res.returncode != 0:
            print(f"[Inference Error] code={res.returncode}")
            print(f"[Inference Stderr] {(res.stderr or '')[-1000:]}")
            shutil.rmtree(work_dir, ignore_errors=True)
            return False

        latest_vid = _pick_new_mp4(before, clip_key, start_time)
        if not latest_vid:
            for pattern in (
                f"results/v15/avatars/avator_1/vid_output/{clip_key}.mp4",
                f"results/avatars/avator_1/vid_output/{clip_key}.mp4",
            ):
                if os.path.exists(pattern) and os.path.getmtime(pattern) >= start_time - 1:
                    latest_vid = pattern
                    break
        if not latest_vid:
            print("[Inference Error] No request-specific MP4 (refusing stale glob)")
            shutil.rmtree(work_dir, ignore_errors=True)
            return False
        shutil.copyfile(latest_vid, raw_out)
        latest_vid = raw_out

    if not remux_video_with_audio(latest_vid, unique_wav, output_video_path):
        print("[Inference Error] Remux failed — refusing stale-audio video")
        shutil.rmtree(work_dir, ignore_errors=True)
        return False

    out_dur = _ffprobe_duration(output_video_path)
    if out_dur is None or abs(out_dur - wav_dur) > 0.75:
        print(f"[Inference Error] Duration mismatch wav={wav_dur:.2f}s out={out_dur}")
        try:
            os.remove(output_video_path)
        except OSError:
            pass
        shutil.rmtree(work_dir, ignore_errors=True)
        return False

    print(
        f"[Inference Success] mode={_WARM_MODE} → {output_video_path} "
        f"in {time.time() - start_time:.2f}s (dur={out_dur:.2f}s)"
    )
    shutil.rmtree(work_dir, ignore_errors=True)
    return True


def pcm_to_16k_wav(pcm_base64: str, sample_rate: int, wav_path: str) -> float:
    raw_bytes = base64.b64decode(pcm_base64)
    if len(raw_bytes) == 0:
        raise ValueError("Decoded audio data is empty")

    audio_data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    if sample_rate != 16000:
        try:
            import librosa

            resampled = librosa.resample(
                audio_data, orig_sr=sample_rate, target_sr=16000, res_type="kaiser_fast"
            )
        except Exception:
            orig_len = len(audio_data)
            target_len = int(orig_len * 16000 / sample_rate)
            resampled = np.interp(
                np.linspace(0, orig_len, target_len, endpoint=False),
                np.arange(orig_len),
                audio_data,
            )
    else:
        resampled = audio_data

    resampled_i16 = (resampled * 32767.0).clip(-32768, 32767).astype(np.int16)
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(resampled_i16.tobytes())
    return len(resampled_i16) / 16000.0


@app.on_event("startup")
def _startup_warm():
    """Preload MuseTalk into GPU when uvicorn starts (after Cell 3 cache exists)."""
    if not _avatar_cached():
        print("[Startup] Avatar cache missing — warm load deferred until /api/warmup")
        return
    print("[Startup] Preloading warm MuseTalk engine…")
    with _get_lock():
        eng = _ensure_warm_engine()
    print(f"[Startup] warm_mode={_WARM_MODE} ready={bool(eng)}")


@app.get("/")
def read_root():
    return {
        "service": "SABCQ AI Counselor MuseTalk Engine",
        "status": "online",
        "avatar": "Priya Sharma",
        "version": "3.1.0",
        "phase": "1.5-stabilize",
        "mode": _WARM_MODE,
        "bbox_shift": BBOX_SHIFT,
        "batch_size": BATCH_SIZE,
        "gpu_ready": True,
    }


@app.get("/health")
def health_check():
    gpu_name = "unknown"
    try:
        import torch

        cuda_ok = bool(torch.cuda.is_available())
        if cuda_ok:
            gpu_name = torch.cuda.get_device_name(0)
    except Exception:
        cuda_ok = False

    warm_ready = _WARM_MODE == "warm"
    return {
        "status": "healthy",
        "cuda_available": cuda_ok,
        "gpu_name": gpu_name,
        "avatar_cached": _avatar_cached(),
        "warm_mode": _WARM_MODE,
        "warm_ready": warm_ready,
        "bbox_shift": BBOX_SHIFT,
        "sharpen": os.environ.get("MUSETALK_SHARPEN", "1"),
        "version": "3.1.0",
        "phase": "1.5-stabilize",
    }


@app.post("/api/warmup")
def warmup():
    if not _avatar_cached():
        return JSONResponse(
            {
                "ok": False,
                "warm_mode": "failed",
                "warm_ready": False,
                "message": "Avatar coords.pkl missing — run Colab Cell 3 prep first",
            },
            status_code=503,
        )
    t0 = time.time()
    with _get_lock():
        eng = _ensure_warm_engine()
    gpu_name = "unknown"
    try:
        import torch

        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
    except Exception:
        pass
    warm_ready = bool(eng) and _WARM_MODE == "warm"
    return {
        "ok": warm_ready,
        "avatar_cached": True,
        "warm_mode": _WARM_MODE,
        "warm_ready": warm_ready,
        "load_sec": round(time.time() - t0, 2),
        "gpu_name": gpu_name,
        "bbox_shift": BBOX_SHIFT,
        "sharpen": os.environ.get("MUSETALK_SHARPEN", "1"),
        "version": "3.1.0",
        "phase": "1.5-stabilize",
    }


@app.post("/api/generate")
async def generate_avatar_video(audio_file: UploadFile = File(...)):
    request_id = uuid.uuid4().hex[:12]
    temp_dir = tempfile.mkdtemp(prefix=f"mt_{request_id}_")
    input_audio_path = os.path.join(temp_dir, "input_speech.wav")
    output_video_path = os.path.join(temp_dir, f"out_{request_id}.mp4")

    content = await audio_file.read()
    with open(input_audio_path, "wb") as f:
        f.write(content)

    with _get_lock():
        success = run_musetalk_inference(input_audio_path, output_video_path, request_id)

    if success and os.path.exists(output_video_path) and os.path.getsize(output_video_path) > 1000:
        return FileResponse(
            output_video_path,
            media_type="video/mp4",
            filename=f"priya_sharma_{request_id}.mp4",
        )
    raise HTTPException(status_code=500, detail="Failed to render avatar video")


@app.post("/api/generate_from_pcm")
async def generate_from_pcm(req: GeneratePcmRequest):
    if not req.pcm_base64:
        raise HTTPException(status_code=400, detail="Empty pcm_base64 data")

    request_id = (req.request_id or uuid.uuid4().hex)[:24].replace("/", "_").replace("-", "_")
    pcm_bytes = base64.b64decode(req.pcm_base64)
    cache_key = _pcm_cache_key(pcm_bytes, req.sample_rate)
    cached_mp4 = os.path.join(CACHE_DIR, f"{cache_key}.mp4")

    if os.path.exists(cached_mp4) and os.path.getsize(cached_mp4) > 1000:
        pcm_dur = (len(pcm_bytes) / 2) / float(req.sample_rate or 24000)
        out_dur = _ffprobe_duration(cached_mp4)
        if out_dur is not None and abs(out_dur - pcm_dur) <= 0.75:
            print(f"[Cache HIT] key={cache_key[:10]}… beat={req.beat_id} dur={out_dur:.2f}s")
            return FileResponse(
                cached_mp4,
                media_type="video/mp4",
                filename=f"priya_cached_{request_id}.mp4",
            )
        try:
            os.remove(cached_mp4)
        except OSError:
            pass

    temp_dir = tempfile.mkdtemp(prefix=f"mt_{request_id}_")
    input_wav = os.path.join(temp_dir, "turn_speech.wav")
    output_mp4 = os.path.join(temp_dir, f"turn_{request_id}.mp4")

    try:
        duration_sec = pcm_to_16k_wav(req.pcm_base64, req.sample_rate, input_wav)
        print(
            f"[PCM -> WAV] id={request_id} dur={duration_sec:.2f}s beat={req.beat_id} "
            f"key={cache_key[:10]}… mode={_WARM_MODE}"
        )

        with _get_lock():
            success = run_musetalk_inference(input_wav, output_mp4, request_id)

        if success and os.path.exists(output_mp4) and os.path.getsize(output_mp4) > 1000:
            try:
                shutil.copyfile(output_mp4, cached_mp4)
            except Exception as e:
                print(f"[Cache Warn] {e}")
            return FileResponse(
                output_mp4,
                media_type="video/mp4",
                filename=f"priya_sharma_turn_{request_id}.mp4",
            )

        raise HTTPException(status_code=500, detail="MuseTalk turn rendering failed")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Generate From PCM Error]: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.websocket("/ws/avatar_stream")
async def websocket_avatar_stream(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            event = data.get("event")
            if event == "ping":
                await websocket.send_text(json.dumps({"event": "pong", "time": time.time()}))
            elif event == "flush":
                await websocket.send_text(json.dumps({"event": "flushed"}))
            elif event == "audio_chunk":
                await websocket.send_text(
                    json.dumps(
                        {
                            "event": "stream_unsupported",
                            "message": "Phase1 uses /api/generate_from_pcm chunks; frame stream is Phase2",
                        }
                    )
                )
    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print(f"[WS Error]: {e}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
