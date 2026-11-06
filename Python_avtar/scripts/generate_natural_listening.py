import os
import cv2
import numpy as np
import subprocess
import shutil

print("--- Step 1: Loading Base Frame ---")
base_img_path = '/tmp/video_check/seq_238.jpg'
base_img = cv2.imread(base_img_path)
if base_img is None:
    raise FileNotFoundError(f"Could not load {base_img_path}")
h, w, c = base_img.shape
print(f"Base image shape: {w}x{h}, {c} channels")

# Clean output frames directory
frames_dir = '/tmp/listening_frames_v2'
if os.path.exists(frames_dir):
    shutil.rmtree(frames_dir)
os.makedirs(frames_dir, exist_ok=True)

print("--- Step 2: Creating Coherent Silhouette Influence Mask ---")
# Mask covers Priya: head, hair, ears, headset, neck, blazer/torso down to desk
mask = np.zeros((h, w), dtype=np.float32)

# Head & hair
cv2.ellipse(mask, (575, 230), (140, 145), 0, 0, 360, 1.0, -1)
cv2.ellipse(mask, (575, 175), (150, 100), 0, 0, 360, 1.0, -1)

# Neck & Torso down to desk level
pts_torso = np.array([
    [470, 270], [680, 270],
    [765, 430], [775, 535],
    [375, 535], [385, 430]
], dtype=np.int32)
cv2.fillPoly(mask, [pts_torso], 1.0)

# Soft blur to blend naturally with background
mask = cv2.GaussianBlur(mask, (27, 27), 10.0)

# Desk fade out: Smoothstep anchor between y=515 and y=538
# Below y=538 is the desk, laptop, notebook, hands, coffee mug (100% stationary)
grid_y, grid_x = np.mgrid[0:h, 0:w].astype(np.float32)
desk_t = np.clip((538.0 - grid_y) / 23.0, 0.0, 1.0)
smooth_desk_feather = desk_t * desk_t * (3.0 - 2.0 * desk_t) # smoothstep
mask *= smooth_desk_feather

# Relative vertical profile for natural 3D head nod:
# Chin (y=340) drops by 100% of dy
# Hair top (y=120) drops by ~78% of dy
# Shoulders (y=460) drop by ~85% of dy
# This creates a genuine subtle 3D pitch nod with ZERO neck strain/pinching!
pitch_weight = np.ones((h, w), dtype=np.float32)
for y in range(h):
    if y < 120:
        pw = 0.78
    elif y <= 340:
        alpha = (y - 120.0) / (340.0 - 120.0)
        pw = 0.78 + 0.22 * alpha
    elif y <= 460:
        alpha = (y - 340.0) / (460.0 - 340.0)
        pw = 1.00 - 0.15 * alpha
    else:
        pw = 0.85
    pitch_weight[y, :] = pw

print("--- Step 3: Natural Eye Blink Rendering ---")
eyes = [
    {'cx': 541, 'cy': 212, 'rx': 15, 'ry': 7},
    {'cx': 603, 'cy': 211, 'rx': 15, 'ry': 7}
]

def render_blink(frame, blink_factor):
    """
    Renders photorealistic eyelid descent with natural skin crease and lash line.
    blink_factor: 0.0 (open) to 1.0 (fully closed)
    """
    if blink_factor <= 0.01:
        return frame

    out = frame.copy()
    for eye in eyes:
        cx, cy, rx, ry = eye['cx'], eye['cy'], eye['rx'], eye['ry']
        y1, y2 = cy - ry - 4, cy + ry + 4
        x1, x2 = cx - rx - 3, cx + rx + 3

        patch = out[y1:y2, x1:x2].copy()
        ph, pw = patch.shape[:2]

        local_cy = cy - y1
        local_cx = cx - x1

        yy, xx = np.mgrid[0:ph, 0:pw]
        dist_sq = ((xx - local_cx) / float(rx))**2 + ((yy - local_cy) / float(ry))**2
        eye_mask = np.clip(1.0 - dist_sq, 0.0, 1.0)
        eye_mask = cv2.GaussianBlur(eye_mask, (5, 5), 1.0)

        # Upper eyelid fold skin strip
        skin_strip = patch[0:4, :]
        skin_fill = cv2.resize(skin_strip, (pw, ph), interpolation=cv2.INTER_LINEAR)

        eye_top = local_cy - ry
        eye_bottom = local_cy + ry
        lid_y = eye_top + blink_factor * (eye_bottom - eye_top)

        lid_coverage = np.clip((lid_y - yy) / 1.5, 0.0, 1.0)
        lash_line = np.exp(-((yy - lid_y) ** 2) / 1.2) * 0.45 * blink_factor

        total_lid_mask = (eye_mask * lid_coverage)[:, :, None]
        skin_with_lash = skin_fill.astype(float) * (1.0 - lash_line[:, :, None])

        blended = patch.astype(float) * (1.0 - total_lid_mask) + skin_with_lash * total_lid_mask
        out[y1:y2, x1:x2] = np.clip(blended, 0, 255).astype(np.uint8)

    return out

print("--- Step 4: Computing 10-Second Listening Trajectory ---")
fps = 25.0
duration = 10.0
total_frames = int(fps * duration) # 250 frames
t = np.linspace(0, duration, total_frames, endpoint=False)

def bell(t_arr, center, width):
    x = (t_arr - center) / (width / 2.0)
    return np.where(np.abs(x) < 1.0, 0.5 * (1.0 + np.cos(np.pi * x)), 0.0)

dy_arr = np.zeros_like(t)
blink_arr = np.zeros_like(t)

# 1. Subtle, peaceful breathing rhythm (cycle ~3.8 seconds, amplitude ~0.6 px)
dy_arr += 0.6 * (1.0 - np.cos(2 * np.pi * t / 3.8)) * 0.5

# 2. First Listening Nod: Attentive double nod acknowledging the speaker (1.6s - 3.2s)
# First nod dip: 2.8 px at 2.0s
dy_arr += 2.8 * bell(t, 2.05, 0.65)
# Second follow-up nod dip: 1.8 px at 2.65s
dy_arr += 1.8 * bell(t, 2.70, 0.55)

# 3. First natural blink at 3.65s (duration ~0.26s = ~6 frames)
blink_arr += 0.95 * bell(t, 3.65, 0.26)

# 4. Second Listening Nod: Empathetic, thoughtful nod (5.2s - 6.4s)
# Gentle, slower understanding nod: 2.5 px at 5.75s
dy_arr += 2.5 * bell(t, 5.75, 0.85)

# 5. Second natural blink at 6.65s
blink_arr += 0.95 * bell(t, 6.65, 0.26)

# 6. Third Listening Nod: Affirmative nod encouraging the student to continue (7.6s - 8.9s)
# Primary nod: 2.9 px at 8.05s
dy_arr += 2.9 * bell(t, 8.05, 0.65)
# Follow-up micro-nod: 1.4 px at 8.60s
dy_arr += 1.4 * bell(t, 8.60, 0.50)

# 7. Third natural blink at 9.15s
blink_arr += 0.95 * bell(t, 9.15, 0.26)

# Seamless loop blend: return perfectly to baseline between 9.6s and 10.0s
loop_fade = np.where(t > 9.6, 0.5 * (1.0 + np.cos(np.pi * (t - 9.6) / 0.4)), 1.0)
loop_start = np.where(t < 0.4, 0.5 * (1.0 - np.cos(np.pi * t / 0.4)), 1.0)
dy_arr *= (loop_fade * loop_start)

print(f"Trajectory computed for {total_frames} frames. Peak dy={np.max(dy_arr):.2f}px")

print("--- Step 5: Rendering Frames ---")
for f_idx in range(total_frames):
    cur_dy = float(dy_arr[f_idx])
    cur_blink = float(blink_arr[f_idx])

    # 1. Apply blink if active
    f_blink = render_blink(base_img, cur_blink)

    # 2. Apply coherent micro-nod
    # Source sampling coordinates:
    # Sampling from (y - dy) moves pixels downward to y
    cur_dy_field = cur_dy * pitch_weight * mask
    src_y = grid_y - cur_dy_field
    src_x = grid_x

    warped_frame = cv2.remap(f_blink, src_x, src_y, interpolation=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT101)

    out_file = os.path.join(frames_dir, f"frame_{f_idx:04d}.png")
    cv2.imwrite(out_file, warped_frame)

    if (f_idx + 1) % 50 == 0 or f_idx == total_frames - 1:
        print(f"  Rendered {f_idx + 1}/{total_frames} frames ({((f_idx + 1)/total_frames)*100:.0f}%)")

print("--- Step 6: Encoding MP4 Video with ffmpeg ---")
temp_video = '/tmp/priya_sharma_listening_v2.mp4'
if os.path.exists(temp_video):
    os.remove(temp_video)

cmd = [
    'ffmpeg', '-y',
    '-framerate', '25',
    '-i', os.path.join(frames_dir, 'frame_%04d.png'),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', '18',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    temp_video
]

proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if proc.returncode != 0:
    print(f"ffmpeg error:\n{proc.stderr}")
    exit(1)

print(f"Video encoded successfully at {temp_video} (size: {os.path.getsize(temp_video)} bytes)")

# Step 7: Copy to targets
targets = [
    '/home/dell/Akhilesh/SACAQ-AI_Counsellor-Python/aiqtest_frontend/public/priya_sharma_listening.mp4',
    '/home/dell/Akhilesh/SACAQ-AI_Counsellor-Python/aiqtest_frontend/public/ai_councloer_listening.mp4',
    '/home/dell/Akhilesh/SACAQ-AI_Counsellor-Python/Python_avtar/assets/priya_sharma_listening.mp4'
]

for tgt in targets:
    shutil.copyfile(temp_video, tgt)
    print(f"Updated: {tgt}")

print("--- ALL DONE! ---")
