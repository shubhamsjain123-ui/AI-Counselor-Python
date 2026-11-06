# 🚀 SABCQ MuseTalk Google Colab Setup Guide

A complete, 100% free guide to run **MuseTalk on Cloud GPU (NVIDIA T4 15GB)**.

**v3.1 Phase 1.5 Stabilize (re-upload notebook / Run all):**
- Warm confirm: `/health` → `warm_ready: true`, console `[Avatar Status] warm_mode=warm`
- Beat 3 = **5 short chunks** + **per-chunk disk cache** + 1 retry (anti HTTP 574)
- 2nd session: cached chunk MP4s → near-instant Beat 3
- Light unsharp sharpen (`MUSETALK_SHARPEN=1`, default on). GFPGAN later if needed
- `MUSETALK_BBOX_SHIFT` — change only if you re-run Cell 3 avatar prep
- Mandatory Gemini-audio remux

---

### Step 1: Open Google Colab
1. Browser me open karein: [https://colab.research.google.com](https://colab.research.google.com)
2. **File** -> **Upload notebook** par click karein aur choose karein:
    `Python_avtar/colab/sabcq_musetalk_colab.ipynb`  
    (ya Cell 4 dubara chalao so latest `musetalk_server.py` write ho jaye)

---

### Step 2: Select Free T4 GPU Runtime
1. Top Menu me **Runtime** -> **Change runtime type** click karein.
2. **Hardware accelerator** me **T4 GPU** select karein.
3. **Save** par click karein.

---

### Step 3: Run the Notebook
1. Press `Ctrl + F9` ya **Runtime** -> **Run all**.
2. Ye automatically saare MuseTalk weights download karega aur FastAPI server start karega.
3. Last cell me aapko Cloudflare ka public link dikhega:
   ```
   🎉 SABCQ AI COUNSELOR MUSETALK SERVER IS LIVE!
   👉 PUBLIC CLOUD API URL: https://xxxx-xxxx.trycloudflare.com
   ```

---

### Step 4: Verify from your Laptop
Apne laptop terminal me ye run karke check karein:
```bash
python Python_avtar/scripts/test_colab_musetalk.py --url https://xxxx-xxxx.trycloudflare.com
```

---

### Step 5: Connect to Backend
Apne backend `.env` file (`aiqtest_backend/.env`) me URL daal dein:
```env
AVATAR_SERVICE_URL=https://xxxx-xxxx.trycloudflare.com
```
