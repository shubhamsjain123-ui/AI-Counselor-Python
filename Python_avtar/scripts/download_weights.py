import os
import sys
import requests
from tqdm import tqdm

CHECKPOINTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "checkpoints")

MODELS = {
    "wav2lip.pth": "https://huggingface.co/vinthony/SadTalker/resolve/main/wav2lip.pth",
    "wav2lip_gan.pth": "https://huggingface.co/Non-playing-Character/Wave2lip/resolve/main/wav2lip_gan.pth",
    "s3fd.pth": "https://huggingface.co/camenduru/Wav2Lip/resolve/main/face_detection/detection/sfd/s3fd.pth",
    "gfpgan_1.4.onnx": "https://huggingface.co/facefusion/models-3.0.0/resolve/main/gfpgan_1.4.onnx",
}

def download_file(url, destination_path):
    print(f"\n[Downloader] Target: {destination_path}")
    if os.path.exists(destination_path):
        size_mb = os.path.getsize(destination_path) / (1024 * 1024)
        print(f"[Downloader] File already exists ({size_mb:.2f} MB). Skipping download.")
        return

    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    temp_path = destination_path + ".tmp"

    print(f"[Downloader] Downloading from {url}...")
    try:
        response = requests.get(url, stream=True, timeout=30)
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 0))

        with open(temp_path, "wb") as f, tqdm(
            desc=os.path.basename(destination_path),
            total=total_size,
            unit='B',
            unit_scale=True,
            unit_divisor=1024,
        ) as bar:
            for chunk in response.iter_content(chunk_size=1024 * 64):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))

        os.rename(temp_path, destination_path)
        print(f"[Downloader] Successfully saved to {destination_path}")
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        print(f"[Downloader] Error downloading {url}: {e}")
        raise e

def main():
    print("=" * 60)
    print("AI Counsellor Avatar: Checkpoint Weights Downloader")
    print("=" * 60)

    # 1. Download Wav2Lip checkpoint
    wav2lip_target = os.path.join(CHECKPOINTS_DIR, "wav2lip.pth")
    download_file(MODELS["wav2lip.pth"], wav2lip_target)

    # 2. Download S3FD Face Detector checkpoint
    s3fd_target = os.path.join(CHECKPOINTS_DIR, "s3fd.pth")
    download_file(MODELS["s3fd.pth"], s3fd_target)

    print("\n[Downloader] All essential weights are ready in:", CHECKPOINTS_DIR)

if __name__ == "__main__":
    main()
