"""
SABCQ AI Counselor - Colab MuseTalk Client Test Script
Use this script to verify your Google Colab Cloud GPU endpoint from your local machine.

Usage:
  python Python_avtar/scripts/test_colab_musetalk.py --url https://xxxx.trycloudflare.com
"""

import os
import sys
import time
import argparse
import requests

def test_endpoint(api_url: str, audio_path: str, output_path: str):
    api_url = api_url.rstrip("/")
    print("=" * 60)
    print(f"🧪 Testing SABCQ MuseTalk Cloud Server at: {api_url}")
    print("=" * 60)

    # 1. Health Check
    try:
        print("[1/3] Pinging Health Endpoint...")
        start = time.time()
        res = requests.get(f"{api_url}/health", timeout=10)
        elapsed = (time.time() - start) * 1000
        if res.status_code == 200:
            data = res.json()
            print(f"✅ Server Healthy! Latency: {elapsed:.1f}ms")
            print(f"   - GPU Device: {data.get('gpu_name', 'Unknown')}")
            print(f"   - Model Ready: {data.get('status')}")
            print(f"   - Avatar Cached: {data.get('avatar_cached')}")
        else:
            print(f"❌ Server returned status {res.status_code}: {res.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Connection Failed: {e}")
        print("💡 Make sure your Google Colab notebook is running and the tunnel URL is active.")
        return False

    # 2. Check Input Audio
    if not os.path.exists(audio_path):
        print(f"⚠️ Audio file not found at '{audio_path}'. Creating dummy 1-second sine wave...")
        import numpy as np
        import soundfile as sf
        sample_rate = 16000
        t = np.linspace(0, 1.0, sample_rate, False)
        tone = np.sin(440 * t * 2 * np.pi) * 0.5
        os.makedirs(os.path.dirname(audio_path) or ".", exist_ok=True)
        sf.write(audio_path, tone, sample_rate)

    # 3. Test Avatar Video Generation
    print(f"[2/3] Uploading audio '{audio_path}' for Lip-Sync generation...")
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    try:
        start_gen = time.time()
        with open(audio_path, "rb") as f:
            files = {"audio_file": ("test_speech.wav", f, "audio/wav")}
            res = requests.post(f"{api_url}/api/generate", files=files, timeout=60)

        gen_elapsed = time.time() - start_gen

        if res.status_code == 200:
            with open(output_path, "wb") as out:
                out.write(res.content)
            file_size_kb = os.path.getsize(output_path) / 1024
            print(f"🎉 Success! Video generated in {gen_elapsed:.2f}s")
            print(f"   - Output saved to: {output_path} ({file_size_kb:.1f} KB)")
            print(f"   - Average Speed: High-Speed Cloud GPU Render")
            return True
        else:
            print(f"❌ Generation failed ({res.status_code}): {res.text}")
            return False

    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed during video generation: {e}")
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test Colab MuseTalk Cloud Endpoint")
    parser.add_argument("--url", type=str, default="http://localhost:8000",
                        help="Public Cloudflare Tunnel URL or Local URL")
    parser.add_argument("--audio", type=str, default="Python_avtar/assets/sample_audio.wav",
                        help="Input speech audio file (.wav)")
    parser.add_argument("--output", type=str, default="Python_avtar/output/colab_test_result.mp4",
                        help="Output generated video path (.mp4)")
    args = parser.parse_args()

    test_endpoint(args.url, args.audio, args.output)
