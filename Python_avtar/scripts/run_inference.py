import os
import sys
import time
import argparse
import subprocess
import cv2
import numpy as np
import torch
from tqdm import tqdm

# Add parent directory to sys.path so models can be imported
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.wav2lip import Wav2Lip
from models.face_detection import FaceDetector
from models.face_enhancer import FaceEnhancer
from models import audio

def get_args():
    parser = argparse.ArgumentParser(description="AI Counsellor: Real-Time Lip-Sync Inference Engine (Phase 1)")
    parser.add_argument("--face", type=str, default="assets/counselor_sample.jpg",
                        help="Path to avatar image or video")
    parser.add_argument("--audio", type=str, default="assets/sample_audio.wav",
                        help="Path to speech audio file")
    parser.add_argument("--outfile", type=str, default="output/result_counselor_lipsync.mp4",
                        help="Path to output synced video")
    parser.add_argument("--checkpoint_path", type=str, default="checkpoints/wav2lip.pth",
                        help="Path to Wav2Lip weights (.pth)")
    parser.add_argument("--face_det_checkpoint", type=str, default="checkpoints/s3fd.pth",
                        help="Path to S3FD Face detector weights (.pth)")
    parser.add_argument("--gfpgan_checkpoint", type=str, default="checkpoints/gfpgan_1.4.onnx",
                        help="Path to GFPGAN ONNX model weights")
    parser.add_argument("--enhance", action="store_true", default=False,
                        help="Enable GFPGAN Face Super-Resolution to eliminate blurriness and restore sharp HD lips & teeth")
    parser.add_argument("--box", nargs='+', type=int, default=[-1, -1, -1, -1],
                        help="Specify constant face crop bounding box: [y1, y2, x1, x2]")
    parser.add_argument("--pads", nargs='+', type=int, default=[0, 10, 0, 0],
                        help="Padding: [top, bottom, left, right]")
    parser.add_argument("--fps", type=float, default=25.0,
                        help="Output video frames per second")
    parser.add_argument("--wav2lip_batch_size", type=int, default=32,
                        help="Batch size for model inference")
    parser.add_argument("--resize_factor", type=int, default=1,
                        help="Scale down image if too large (1, 2, etc.)")
    parser.add_argument("--device", type=str, default=None,
                        help="Computation device ('cuda' or 'cpu')")
    return parser.parse_args()

def load_model(checkpoint_path, device):
    print(f"[ModelLoader] Loading Wav2Lip model from: {checkpoint_path}")
    if not os.path.exists(checkpoint_path):
        raise FileNotFoundError(
            f"Checkpoint not found at '{checkpoint_path}'. "
            "Please run 'python scripts/download_weights.py' first!"
        )

    model = Wav2Lip()
    checkpoint = torch.load(checkpoint_path, map_location=device)
    
    # State dict handling (sometimes saved inside checkpoint['state_dict'])
    s = checkpoint.get("state_dict", checkpoint)
    new_s = {}
    for k, v in s.items():
        new_s[k.replace('module.', '')] = v
    model.load_state_dict(new_s)
    model = model.to(device)
    model.eval()
    print("[ModelLoader] Model loaded successfully.")
    return model

def prepare_audio_chunks(audio_path, fps):
    print(f"[AudioPipeline] Processing audio: {audio_path}")
    wav = audio.load_wav(audio_path)
    mel = audio.melspectrogram(wav)
    print(f"[AudioPipeline] Mel-spectrogram shape: {mel.shape} (80 mel filterbanks x frames)")

    if np.isnan(mel.reshape(-1)).sum() > 0:
        raise ValueError("Audio mel spectrogram contains NaN values.")

    mel_chunks = []
    mel_idx_multiplier = 80.0 / fps
    i = 0
    while True:
        start_idx = int(i * mel_idx_multiplier)
        if start_idx + 16 > mel.shape[1]:
            # pad last window if needed
            pad_len = (start_idx + 16) - mel.shape[1]
            if start_idx < mel.shape[1]:
                chunk = mel[:, start_idx:]
                chunk = np.pad(chunk, ((0, 0), (0, pad_len)), mode='constant')
                mel_chunks.append(chunk)
            break
        mel_chunks.append(mel[:, start_idx : start_idx + 16])
        i += 1

    print(f"[AudioPipeline] Generated {len(mel_chunks)} audio feature windows (matching {len(mel_chunks)} video frames).")
    return mel_chunks

def get_face_crops(image_bgr, detector, pads, custom_box=None):
    if custom_box is not None and custom_box[0] != -1:
        y1, y2, x1, x2 = custom_box
        face_crop = image_bgr[y1:y2, x1:x2]
        return face_crop, (x1, y1, x2, y2)

    boxes = detector.detect_faces(image_bgr)
    if len(boxes) == 0:
        raise ValueError("Could not detect any face in the input image!")
    
    # Select primary face
    box = boxes[0]
    x1, y1, x2, y2 = box
    pad_t, pad_b, pad_l, pad_r = pads

    h, w = image_bgr.shape[:2]
    # Center face on the features (eyes to chin) for Wav2Lip 96x96 distribution
    box_h = y2 - y1
    if y1 + int(box_h * 0.3) < y2:
        y1 = y1 + int(box_h * 0.3)

    y1 = max(0, y1 - pad_t)
    y2 = min(h, y2 + pad_b)
    x1 = max(0, x1 - pad_l)
    x2 = min(w, x2 + pad_r)

    # Ensure crop is roughly square for 96x96 normalization
    cw = x2 - x1
    ch = y2 - y1
    if ch > cw:
        diff = ch - cw
        x1 = max(0, x1 - diff // 2)
        x2 = min(w, x2 + (diff - diff // 2))
    elif cw > ch:
        diff = cw - ch
        y1 = max(0, y1 - diff // 2)
        y2 = min(h, y2 + (diff - diff // 2))

    face_crop = image_bgr[y1:y2, x1:x2]
    return face_crop, (x1, y1, x2, y2)

def main():
    args = get_args()

    # Base directory paths
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    face_path = os.path.join(base_dir, args.face) if not os.path.isabs(args.face) else args.face
    audio_path = os.path.join(base_dir, args.audio) if not os.path.isabs(args.audio) else args.audio
    out_path = os.path.join(base_dir, args.outfile) if not os.path.isabs(args.outfile) else args.outfile
    ckpt_path = os.path.join(base_dir, args.checkpoint_path) if not os.path.isabs(args.checkpoint_path) else args.checkpoint_path
    face_det_ckpt = os.path.join(base_dir, args.face_det_checkpoint) if not os.path.isabs(args.face_det_checkpoint) else args.face_det_checkpoint

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Determine Device
    if args.device:
        device = args.device
    else:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[Engine] Running on compute device: {device.upper()}")

    # 1. Load Audio
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    mel_chunks = prepare_audio_chunks(audio_path, args.fps)
    num_frames = len(mel_chunks)

    # 2. Load Face Image / Video
    if not os.path.exists(face_path):
        raise FileNotFoundError(f"Face image not found: {face_path}")
    
    full_frame = cv2.imread(face_path)
    if full_frame is None:
        raise ValueError(f"Could not read image file at {face_path}")

    # 3. Detect Face on original high-quality frame for maximum precision
    detector = FaceDetector(device=device, weights_path=face_det_ckpt)
    face_crop, (x1, y1, x2, y2) = get_face_crops(full_frame, detector, args.pads, args.box)

    if args.resize_factor > 1:
        full_frame = cv2.resize(
            full_frame,
            (full_frame.shape[1] // args.resize_factor, full_frame.shape[0] // args.resize_factor)
        )
        x1 //= args.resize_factor
        y1 //= args.resize_factor
        x2 //= args.resize_factor
        y2 //= args.resize_factor
        face_crop = full_frame[y1:y2, x1:x2]

    crop_h, crop_w = face_crop.shape[:2]
    print(f"[FacePipeline] Primary Face detected at: x=[{x1}, {x2}], y=[{y1}, {y2}] ({crop_w}x{crop_h} px)")

    # 4. Prepare Face Tensor (96x96 with lower half masked in RGB)
    face_crop_rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
    resized_face = cv2.resize(face_crop_rgb, (96, 96))
    masked_face = resized_face.copy()
    masked_face[48:, :] = 0  # Mask lower half (mouth & jaw)

    # Concatenate 3-channel masked face + 3-channel original face => 6-channel input
    face_tensor = np.concatenate((masked_face, resized_face), axis=2) / 255.0
    face_tensor = face_tensor.transpose((2, 0, 1)) # (6, 96, 96)
    face_tensor = torch.FloatTensor(face_tensor).to(device)

    # 5. Load Model
    model = load_model(ckpt_path, device)

    # 6. Run Batch Inference
    print(f"\n[Inference] Synthesizing {num_frames} frames (Lip-Sync Generation)...")
    batch_size = args.wav2lip_batch_size
    generated_faces = []

    start_time = time.time()
    for idx in tqdm(range(0, num_frames, batch_size), desc="Rendering Lip-Sync"):
        batch_mel = mel_chunks[idx : idx + batch_size]
        current_bs = len(batch_mel)

        # Audio tensor: (B, 1, 80, 16)
        audio_tensor = np.array(batch_mel)
        audio_tensor = torch.FloatTensor(audio_tensor).unsqueeze(1).to(device)

        # Face tensor repeated for batch: (B, 6, 96, 96)
        batch_face_tensor = face_tensor.unsqueeze(0).repeat(current_bs, 1, 1, 1)

        with torch.no_grad():
            pred = model(audio_tensor, batch_face_tensor)

        # Output shape: (B, 3, 96, 96) in [0, 1] RGB
        pred = pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.0
        for p in pred:
            p_bgr = cv2.cvtColor(p.astype(np.uint8), cv2.COLOR_RGB2BGR)
            generated_faces.append(p_bgr)

    elapsed = time.time() - start_time
    fps_achieved = num_frames / elapsed if elapsed > 0 else 0
    print(f"[Benchmark] Completed {num_frames} frames in {elapsed:.2f}s ({fps_achieved:.1f} FPS)")

    # 7. Blend Generated Lips onto Original Frame and Write Video
    temp_avi = os.path.join(base_dir, "output", "temp_synth.avi")
    fourcc = cv2.VideoWriter_fourcc(*'XVID')
    out_video = cv2.VideoWriter(temp_avi, fourcc, args.fps, (full_frame.shape[1], full_frame.shape[0]))

    # Initialize GFPGAN Face Super-Resolution if requested
    enhancer = None
    if args.enhance:
        gfpgan_path = os.path.join(base_dir, args.gfpgan_checkpoint) if not os.path.isabs(args.gfpgan_checkpoint) else args.gfpgan_checkpoint
        enhancer = FaceEnhancer(gfpgan_path)
        if not enhancer.is_available():
            print("[Warning] FaceEnhancer could not be loaded. Falling back to standard rendering.")

    # Create smooth blending alpha mask for seamless mouth replacement
    blend_mask = np.zeros((crop_h, crop_w, 3), dtype=np.float32)
    half_h = int(crop_h * 0.50)
    blend_mask[half_h:, :, :] = 1.0
    # Gaussian blur the transition seam
    ksize = max(5, int(crop_h * 0.08) | 1)
    blend_mask = cv2.GaussianBlur(blend_mask, (ksize, ksize), 0)

    print(f"[VideoPipeline] Rendering {'and GFPGAN Enhancing ' if enhancer and enhancer.is_available() else ''}final video frames...")
    for gen_face in tqdm(generated_faces, desc="Rendering Frames"):
        frame_copy = full_frame.copy()
        gen_mouth_resized = cv2.resize(gen_face, (crop_w, crop_h))

        # Apply GFPGAN super-resolution restoration
        if enhancer is not None and enhancer.is_available():
            gen_mouth_resized = enhancer.enhance(gen_mouth_resized)

        face_crop_orig = frame_copy[y1:y2, x1:x2].astype(np.float32)
        gen_mouth_f = gen_mouth_resized.astype(np.float32)

        # Seamless alpha blend
        blended_crop = (face_crop_orig * (1.0 - blend_mask) + gen_mouth_f * blend_mask).astype(np.uint8)
        frame_copy[y1:y2, x1:x2] = blended_crop

        out_video.write(frame_copy)

    out_video.release()

    # 8. Mux Video + Audio with FFmpeg
    print(f"[FFmpeg] Muxing video and synchronized audio into {out_path}...")
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-i", temp_avi,
        "-i", audio_path,
        "-c:v", "libx264",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        out_path
    ]
    subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    if os.path.exists(temp_avi):
        os.remove(temp_avi)

    print(f"\n✅ SUCCESS! Lip-synced video created at: {out_path}")
    print(f"Session stats: Duration={num_frames / args.fps:.2f}s, Total Frames={num_frames}, FPS={fps_achieved:.1f}")

if __name__ == "__main__":
    main()
