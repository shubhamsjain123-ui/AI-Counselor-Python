# Phase 2 — Low-latency lip-sync stream + LiveKit

## What changed

| Piece | Behavior |
|--------|----------|
| **LIPSYNC_MODE=stream** | Gemini audio is sliced (~0.8s) → warm MuseTalk → `stream_video_segment` events |
| **No giant turn MP4** | Live turns no longer wait for full-turn MuseTalk (batch still available) |
| **Intro** | Exact TTS sliced into stream segments (or cached full MP4 if present) |
| **LiveKit** | Self-host WebRTC mic (`docker-compose.livekit.yml`) |
| **Frontend** | Progressive short-clip player + optional LiveKit mic |
| **Listening** | `/priya_sharma_listening.mp4` loops while student speaks / waiting for answer |

## LiveKit setup (step-by-step)

### Requirements

| Need | Why | How to get |
|------|-----|------------|
| **Docker** | Runs LiveKit server locally | Ubuntu: `sudo apt install docker.io docker-compose-v2` then `sudo usermod -aG docker $USER` (logout/login). Or [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| **Ports free** | `7880` (WS/HTTP), `7881` (RTC TCP), `50000–50100/udp` | Close anything else on those ports |
| **Dev keys** | Already in repo `livekit.yaml` | `devkey` / `secret_dev_livekit_change_me` — fine for local only |
| **Backend env** | Nest issues room tokens | See `.env` below |
| **npm pkgs** | Already in package.json | `livekit-server-sdk` (backend), `livekit-client` (frontend) |

**Cloud LiveKit (optional later):** create project at [https://cloud.livekit.io](https://cloud.livekit.io) → copy `LIVEKIT_URL`, API key, secret → put in `.env`. Self-host Docker is enough for local Phase 2.

### Start (self-host)

Uses **LiveKit server v1.9.10+** (needs to match modern `livekit-client`) and **`network_mode: host`** on Linux so WebRTC UDP works.

```bash
# from repo root
sudo docker compose -f docker-compose.livekit.yml down
sudo docker compose -f docker-compose.livekit.yml pull
sudo docker compose -f docker-compose.livekit.yml up -d

# check (host network — no port map lines)
sudo docker compose -f docker-compose.livekit.yml ps
# WebSocket: ws://localhost:7880
```

If browser shows `v1 RTC path not found` / `negotiation timed out`, you are on an old server image or bridge networking — pull/up again with the compose file above.

Without LiveKit, mic still works via the existing Gemini WS path — LiveKit connect fails soft.

Keys in `livekit.yaml` must match `.env`:
- `LIVEKIT_API_KEY=devkey`
- `LIVEKIT_API_SECRET=secret_dev_livekit_change_me`
- `LIVEKIT_URL=ws://localhost:7880`

### Backend `.env`

```env
LIPSYNC_MODE=stream
LIPSYNC_SLICE_SEC=0.8
AVATAR_SERVICE_URL=https://your-colab.trycloudflare.com
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret_dev_livekit_change_me
```

Fallback to old per-turn MP4:

```env
LIPSYNC_MODE=batch
```

### Verify LiveKit + stream

1. Colab MuseTalk warm (`/health` → `warm_ready: true`)
2. LiveKit up: browser/WS to `ws://localhost:7880` or token API `POST /api/v1/ai-counselor/livekit/token`
3. Backend restart → frontend session
4. Console: `[Phase2] lipsyncMode=stream` then `stream segment seq=1…` and optionally `[LiveKit] connected`
5. Lips should start after first ~0.8s slice renders (warm GPU)
6. Student speaking → `priya_sharma_listening.mp4` (not static png) until answer video starts

## Phase 3a — LiveKit mic → Gemini (implemented)

| Piece | Behavior |
|--------|----------|
| Browser | Publishes mic to LiveKit; VAD reuses same `MediaStream` (no double mic) |
| Nest bridge | `@livekit/rtc-node` joins room as hidden `gemini-bridge`, subscribes audio @ 16 kHz |
| Gemini | Receives PCM from bridge (same as old `audio_input`) |
| Fallback | If LiveKit/bridge fails → WS `audio_input` path (legacy) |
| Env | `LIVEKIT_BRIDGE_ENABLED=true` |

## Phase 3b — Counselor A/V on LiveKit (implemented)

| Piece | Behavior |
|--------|----------|
| Nest | Decodes MuseTalk MP4 (ffmpeg) → LiveKit `counselor-video` + `counselor-audio` tracks |
| Browser | Subscribes bridge tracks → `<video>` / `<audio>` |
| WS | Still sends segments as **fallback** if LiveKit media attach fails |
| Env | `LIVEKIT_MEDIA_OUT=true` (requires host `ffmpeg` / `ffprobe`) |

Console success:
- `[LiveKit] connected …`
- `[Phase3a/3b] LiveKit bridge active … mediaOut=yes`
- `[LiveKit] counselor video attached` / `counselor audio attached`

## Phase 3c — Harden / polish (implemented)

| Piece | Behavior |
|--------|----------|
| **Flags** | `LIVEKIT_BRIDGE_ENABLED`, `LIVEKIT_MEDIA_OUT`, `LIVEKIT_WS_FALLBACK`, `LIVEKIT_WS_FALLBACK_MS` (`livekit-flags.ts`) |
| **Barge-in** | Clears MuseTalk stream + LiveKit audio queue (mediaGeneration bump) + pauses remote A/V |
| **Mic mute** | Mutes LiveKit `LocalAudioTrack` (does not require full disconnect) |
| **Reconnect** | Auto rejoin LiveKit (backoff, max 5) then re-request Nest bridge |
| **Double-play** | Prefer LiveKit; WS segments only after `LIVEKIT_WS_FALLBACK_MS` if A/V never attaches |
| **Status API** | `GET .../lipsync-mode` returns all LiveKit flags |

Rollback (WS-only counseling):
```env
LIVEKIT_BRIDGE_ENABLED=false
```
Or keep bridge mic but disable counselor LiveKit A/V:
```env
LIVEKIT_MEDIA_OUT=false
```

## Free-tier intro TTS (dev)

Flash TTS free RPM ≈ **3/min**. Beat 3 used to fire **5 TTS calls** → instant 429.

| Env | Default | Meaning |
|-----|---------|---------|
| `INTRO_TTS_MODE` | `single` | One Flash TTS per beat; MuseTalk uses stream slices |
| `INTRO_TTS_MODE=chunks` | — | Multi-TTS with `INTRO_TTS_CHUNK_GAP_MS` (~65s) |
| `GEMINI_TTS_429_WAIT_MS` | `65000` | Wait/retry on HTTP 429 |
| Cache | `aiqtest_backend/cache/intro-beats/` | After first success, no TTS on next runs |

Session after intro remains **dynamic** (Gemini Live + LiveKit). Only scripted intro lines are cached exact speech.

## LiveKit is primary media (not full-WS)

| Path | Role |
|------|------|
| **LiveKit WebRTC** | Student mic + counselor audio/video (40–45 min capable) |
| **WS** | Control only: session, phases, interrupts, lightweight seq pings |

Bridge participant is **visible** (`hidden: false`) so the browser can subscribe to `counselor-*` tracks.
When `LIVEKIT_MEDIA_OUT=true`, WS no longer carries base64 MP4 segments (avoids WS flood).

## Stutter fix (Colab-slow MuseTalk)

Symptom: one word → pause → next word. Cause: 0.8s clip played immediately while next MuseTalk
slice needs ~7–8s on Colab; LiveKit lips often never attach (`LiveKit A/V slow` spam).

Mitigation:
- Prefetch **3 segments** before starting progressive playback
- On underrun, **wait** for next slice (don’t end turn)
- If LiveKit lips don’t attach in grace window → **sticky buffered WS** for that turn
- LiveKit still used for **mic uplink**; lips use smooth WS buffer when LK A/V flaky

## Limits (honest)

- First segment latency = slice fill + MuseTalk + ffmpeg republish (~1–4s on Colab T4).
- ffmpeg decode on Nest adds a bit of CPU; dedicated GPU still the main lipsync bottleneck.
- Cloudflare free tunnel can still slow MuseTalk slices — warm engine + short slices mitigate 574s.
