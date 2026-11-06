"""
SABCQ MuseTalk 1.5 Warm Engine (Phase 1)

Loads VAE / UNet / Whisper / Avatar latents ONCE into GPU memory, then
serves many audio→video jobs without cold subprocess reloads.

Must run from /content/MuseTalk (or any MuseTalk repo root) so imports resolve.
"""

from __future__ import annotations

import copy
import glob
import json
import os
import pickle
import queue
import shutil
import subprocess
import sys
import threading
import time
from typing import Optional

import cv2
import numpy as np
import torch
from tqdm import tqdm
from transformers import WhisperModel


def _fast_check_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


class WarmMuseTalkEngine:
    """In-process MuseTalk 1.5 realtime avatar — warm models + cached Priya latents."""

    def __init__(
        self,
        avatar_id: str = "avator_1",
        video_path: str = "data/video/priya_sharma_base.mp4",
        bbox_shift: int = 0,
        batch_size: int = 16,
        version: str = "v15",
        fps: int = 25,
        gpu_id: int = 0,
        extra_margin: int = 10,
    ):
        self.avatar_id = avatar_id
        self.video_path = video_path
        self.bbox_shift = int(bbox_shift)
        self.batch_size = int(batch_size)
        self.version = version
        self.fps = int(fps)
        self.gpu_id = int(gpu_id)
        self.extra_margin = int(extra_margin)
        self.ready = False
        self._lock = threading.Lock()
        self._load_error: Optional[str] = None

        # populated by load()
        self.device = None
        self.vae = None
        self.unet = None
        self.pe = None
        self.timesteps = None
        self.whisper = None
        self.audio_processor = None
        self.weight_dtype = None
        self.fp = None
        self.input_latent_list_cycle = None
        self.coord_list_cycle = None
        self.frame_list_cycle = None
        self.mask_list_cycle = None
        self.mask_coords_list_cycle = None
        self.avatar_path = None
        self.video_out_path = None

    def load(self) -> bool:
        try:
            from musetalk.utils.face_parsing import FaceParsing
            from musetalk.utils.utils import load_all_model
            from musetalk.utils.audio_processor import AudioProcessor
            from musetalk.utils.preprocessing import read_imgs
        except Exception as e:
            self._load_error = f"MuseTalk imports failed: {e}"
            print(f"[WarmEngine] {self._load_error}")
            return False

        if not _fast_check_ffmpeg():
            self._load_error = "ffmpeg not found on PATH"
            print(f"[WarmEngine] {self._load_error}")
            return False

        # Paths for v1.5 weights
        if self.version == "v15":
            unet_model_path = "./models/musetalkV15/unet.pth"
            unet_config = "./models/musetalkV15/musetalk.json"
            if not os.path.exists(unet_model_path):
                # fallback names some clones use
                unet_model_path = "./models/musetalk/pytorch_model.bin"
                unet_config = "./models/musetalk/musetalk.json"
            self.avatar_path = f"./results/v15/avatars/{self.avatar_id}"
        else:
            unet_model_path = "./models/musetalk/pytorch_model.bin"
            unet_config = "./models/musetalk/musetalk.json"
            self.avatar_path = f"./results/avatars/{self.avatar_id}"

        coords_path = f"{self.avatar_path}/coords.pkl"
        latents_path = f"{self.avatar_path}/latents.pt"
        mask_coords_path = f"{self.avatar_path}/mask_coords.pkl"
        full_imgs_path = f"{self.avatar_path}/full_imgs"
        mask_out_path = f"{self.avatar_path}/mask"
        self.video_out_path = f"{self.avatar_path}/vid_output/"
        os.makedirs(self.video_out_path, exist_ok=True)

        if not os.path.exists(coords_path) or not os.path.exists(latents_path):
            self._load_error = (
                f"Avatar cache missing under {self.avatar_path}. "
                "Run Colab Cell 3 preparation first."
            )
            print(f"[WarmEngine] {self._load_error}")
            return False

        print("[WarmEngine] Loading MuseTalk 1.5 models onto GPU (one-time)…")
        t0 = time.time()
        self.device = torch.device(
            f"cuda:{self.gpu_id}" if torch.cuda.is_available() else "cpu"
        )

        self.vae, self.unet, self.pe = load_all_model(
            unet_model_path=unet_model_path,
            vae_type="sd-vae",
            unet_config=unet_config,
            device=self.device,
        )
        self.timesteps = torch.tensor([0], device=self.device)
        self.pe = self.pe.half().to(self.device)
        self.vae.vae = self.vae.vae.half().to(self.device)
        self.unet.model = self.unet.model.half().to(self.device)

        whisper_dir = "./models/whisper"
        self.audio_processor = AudioProcessor(feature_extractor_path=whisper_dir)
        self.weight_dtype = self.unet.model.dtype
        self.whisper = WhisperModel.from_pretrained(whisper_dir)
        self.whisper = self.whisper.to(device=self.device, dtype=self.weight_dtype).eval()
        self.whisper.requires_grad_(False)

        if self.version == "v15":
            self.fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
        else:
            self.fp = FaceParsing()

        print("[WarmEngine] Loading cached Priya Sharma latents / frames…")
        self.input_latent_list_cycle = torch.load(latents_path, map_location="cpu")
        with open(coords_path, "rb") as f:
            self.coord_list_cycle = pickle.load(f)
        with open(mask_coords_path, "rb") as f:
            self.mask_coords_list_cycle = pickle.load(f)

        input_img_list = sorted(
            glob.glob(os.path.join(full_imgs_path, "*.[jpJP][pnPN]*[gG]")),
            key=lambda x: int(os.path.splitext(os.path.basename(x))[0]),
        )
        self.frame_list_cycle = read_imgs(input_img_list)
        input_mask_list = sorted(
            glob.glob(os.path.join(mask_out_path, "*.[jpJP][pnPN]*[gG]")),
            key=lambda x: int(os.path.splitext(os.path.basename(x))[0]),
        )
        self.mask_list_cycle = read_imgs(input_mask_list)

        self.ready = True
        print(f"[WarmEngine] READY in {time.time() - t0:.1f}s on {self.device}")
        return True

    def _process_frames(self, res_frame_queue, video_len, tmp_dir, idx_box):
        from musetalk.utils.blending import get_image_blending

        while True:
            if idx_box[0] >= video_len - 1:
                break
            try:
                res_frame = res_frame_queue.get(block=True, timeout=1)
            except queue.Empty:
                continue

            i = idx_box[0]
            bbox = self.coord_list_cycle[i % len(self.coord_list_cycle)]
            ori_frame = copy.deepcopy(self.frame_list_cycle[i % len(self.frame_list_cycle)])
            x1, y1, x2, y2 = bbox
            try:
                res_frame = cv2.resize(res_frame.astype(np.uint8), (x2 - x1, y2 - y1))
            except Exception:
                idx_box[0] = i + 1
                continue
            mask = self.mask_list_cycle[i % len(self.mask_list_cycle)]
            mask_crop_box = self.mask_coords_list_cycle[i % len(self.mask_coords_list_cycle)]
            combine_frame = get_image_blending(ori_frame, res_frame, bbox, mask, mask_crop_box)
            # Phase 1.5: light unsharp (cheap) — GFPGAN later if still soft
            if os.environ.get("MUSETALK_SHARPEN", "1") not in ("0", "false", "False"):
                try:
                    blur = cv2.GaussianBlur(combine_frame, (0, 0), 1.0)
                    combine_frame = cv2.addWeighted(combine_frame, 1.35, blur, -0.35, 0)
                except Exception:
                    pass
            cv2.imwrite(f"{tmp_dir}/{str(i).zfill(8)}.png", combine_frame)
            idx_box[0] = i + 1

    @torch.no_grad()
    def infer(self, audio_path: str, output_mp4: str, clip_key: str) -> bool:
        """Run one lip-sync job using already-warm models. Writes raw MuseTalk MP4."""
        if not self.ready:
            print(f"[WarmEngine] not ready: {self._load_error}")
            return False

        from musetalk.utils.utils import datagen

        with self._lock:
            t0 = time.time()
            tmp_dir = os.path.join(self.avatar_path, f"tmp_{clip_key}")
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
            os.makedirs(tmp_dir, exist_ok=True)

            try:
                whisper_input_features, librosa_length = self.audio_processor.get_audio_feature(
                    audio_path, weight_dtype=self.weight_dtype
                )
                whisper_chunks = self.audio_processor.get_whisper_chunk(
                    whisper_input_features,
                    self.device,
                    self.weight_dtype,
                    self.whisper,
                    librosa_length,
                    fps=self.fps,
                    audio_padding_length_left=2,
                    audio_padding_length_right=2,
                )
                video_num = len(whisper_chunks)
                if video_num < 1:
                    print("[WarmEngine] no whisper chunks from audio")
                    return False

                res_frame_queue: queue.Queue = queue.Queue()
                idx_box = [0]
                process_thread = threading.Thread(
                    target=self._process_frames,
                    args=(res_frame_queue, video_num, tmp_dir, idx_box),
                )
                process_thread.start()

                gen = datagen(whisper_chunks, self.input_latent_list_cycle, self.batch_size)
                for whisper_batch, latent_batch in tqdm(
                    gen, total=int(np.ceil(float(video_num) / self.batch_size)), desc="WarmInfer"
                ):
                    audio_feature_batch = self.pe(whisper_batch.to(self.device))
                    latent_batch = latent_batch.to(device=self.device, dtype=self.unet.model.dtype)
                    pred_latents = self.unet.model(
                        latent_batch, self.timesteps, encoder_hidden_states=audio_feature_batch
                    ).sample
                    pred_latents = pred_latents.to(device=self.device, dtype=self.vae.vae.dtype)
                    recon = self.vae.decode_latents(pred_latents)
                    for res_frame in recon:
                        res_frame_queue.put(res_frame)

                process_thread.join()

                # Encode frames → silent video, then mux with input audio (server remuxes Gemini again)
                temp_vid = os.path.join(self.avatar_path, f"temp_{clip_key}.mp4")
                cmd_img2video = [
                    "ffmpeg",
                    "-y",
                    "-v",
                    "warning",
                    "-r",
                    str(self.fps),
                    "-f",
                    "image2",
                    "-i",
                    f"{tmp_dir}/%08d.png",
                    "-vcodec",
                    "libx264",
                    "-vf",
                    "format=yuv420p",
                    "-crf",
                    "18",
                    temp_vid,
                ]
                r1 = subprocess.run(cmd_img2video, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if r1.returncode != 0 or not os.path.exists(temp_vid):
                    print(f"[WarmEngine] img2video failed: {(r1.stderr or b'')[-400:]}")
                    return False

                os.makedirs(os.path.dirname(os.path.abspath(output_mp4)) or ".", exist_ok=True)
                cmd_mux = [
                    "ffmpeg",
                    "-y",
                    "-v",
                    "warning",
                    "-i",
                    audio_path,
                    "-i",
                    temp_vid,
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-shortest",
                    output_mp4,
                ]
                r2 = subprocess.run(cmd_mux, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    os.remove(temp_vid)
                except OSError:
                    pass
                if r2.returncode != 0 or not os.path.exists(output_mp4):
                    print(f"[WarmEngine] mux failed: {(r2.stderr or b'')[-400:]}")
                    return False

                # Also copy into MuseTalk vid_output for debugging
                try:
                    shutil.copyfile(
                        output_mp4, os.path.join(self.video_out_path, f"{clip_key}.mp4")
                    )
                except Exception:
                    pass

                print(
                    f"[WarmEngine] OK clip={clip_key} frames={video_num} "
                    f"in {time.time() - t0:.2f}s → {output_mp4}"
                )
                return True
            except Exception as e:
                print(f"[WarmEngine] infer error: {e}")
                return False
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)


_ENGINE: Optional[WarmMuseTalkEngine] = None
_ENGINE_LOCK = threading.Lock()


def get_warm_engine(
    video_path: str,
    bbox_shift: int = 0,
    batch_size: int = 16,
) -> Optional[WarmMuseTalkEngine]:
    global _ENGINE
    with _ENGINE_LOCK:
        if _ENGINE is not None and _ENGINE.ready:
            return _ENGINE
        eng = WarmMuseTalkEngine(
            video_path=video_path,
            bbox_shift=bbox_shift,
            batch_size=batch_size,
            version="v15",
        )
        if eng.load():
            _ENGINE = eng
            return _ENGINE
        return None
