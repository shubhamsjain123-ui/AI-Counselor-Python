import { Injectable, Logger } from '@nestjs/common';
import { remuxGeminiPcmIntoMp4 } from './avatar-remux';

export type StreamSegmentHandler = (payload: {
  seq: number;
  videoBase64: string;
  mimeType: string;
  durationHintSec: number;
}) => void;

interface ClientStreamState {
  sampleRate: number;
  pending: Buffer[];
  pendingBytes: number;
  seq: number;
  chain: Promise<void>;
  aborted: boolean;
  turnId: number;
  /** Successful segments this turn */
  emitted: number;
  /** Consecutive MuseTalk fetch failures — circuit-break after threshold */
  failStreak: number;
  offline: boolean;
}

/**
 * Phase 2: Gemini PCM → short slices → warm MuseTalk → stream segments.
 * If Colab/tunnel is down, circuit-breaks quickly so PCM audio fallback can play.
 */
@Injectable()
export class LipSyncStreamService {
  private readonly logger = new Logger(LipSyncStreamService.name);
  private clients = new Map<object, ClientStreamState>();
  /** Process-wide: after warmup/fetch fails, skip MuseTalk until health recovers */
  private avatarOfflineUntil = 0;

  private sliceSec(): number {
    const n = parseFloat(process.env.LIPSYNC_SLICE_SEC || '1.2');
    return Number.isFinite(n) ? Math.min(2.0, Math.max(0.6, n)) : 1.2;
  }

  private failThreshold(): number {
    return Math.max(1, parseInt(process.env.LIPSYNC_FAIL_STREAK || '2', 10) || 2);
  }

  isAvatarReachable(): boolean {
    return Date.now() >= this.avatarOfflineUntil;
  }

  markAvatarOffline(reason: string, cooldownMs = 120_000): void {
    this.avatarOfflineUntil = Date.now() + cooldownMs;
    this.logger.warn(
      `MuseTalk marked OFFLINE (${reason}) — skip lip-sync for ${Math.round(cooldownMs / 1000)}s; audio fallback`,
    );
  }

  markAvatarOnline(): void {
    this.avatarOfflineUntil = 0;
  }

  isStreamModeEnabled(): boolean {
    const mode = (process.env.LIPSYNC_MODE || 'stream').trim().toLowerCase();
    const avatar = (process.env.AVATAR_SERVICE_URL || '').trim();
    return Boolean(avatar) && mode !== 'batch' && mode !== 'off' && this.isAvatarReachable();
  }

  beginTurn(client: object, sampleRate = 24000): void {
    const prev = this.clients.get(client);
    const turnId = (prev?.turnId || 0) + 1;
    this.clients.set(client, {
      sampleRate,
      pending: [],
      pendingBytes: 0,
      seq: 0,
      chain: Promise.resolve(),
      aborted: false,
      turnId,
      emitted: 0,
      failStreak: 0,
      offline: !this.isAvatarReachable(),
    });
  }

  abort(client: object): void {
    const st = this.clients.get(client);
    if (st) {
      st.aborted = true;
      st.pending = [];
      st.pendingBytes = 0;
      st.turnId += 1;
    }
  }

  clear(client: object): void {
    this.abort(client);
    this.clients.delete(client);
  }

  getEmitted(client: object): number {
    return this.clients.get(client)?.emitted ?? 0;
  }

  pushPcmBase64(
    client: object,
    pcmBase64: string,
    sampleRate: number,
    onSegment: StreamSegmentHandler,
  ): void {
    if (!this.isStreamModeEnabled()) return;

    let st = this.clients.get(client);
    if (!st || st.aborted) {
      this.beginTurn(client, sampleRate);
      st = this.clients.get(client)!;
    }
    if (st.offline) return;
    st.sampleRate = sampleRate || st.sampleRate;

    const buf = Buffer.from(pcmBase64, 'base64');
    if (buf.length < 2) return;
    st.pending.push(buf);
    st.pendingBytes += buf.length;

    const need = Math.floor(this.sliceSec() * st.sampleRate) * 2;
    while (st.pendingBytes >= need && !st.offline) {
      const slice = this.takeBytes(st, need);
      this.enqueueRender(client, st, slice, onSegment);
    }
  }

  async flush(client: object, onSegment: StreamSegmentHandler): Promise<number> {
    const st = this.clients.get(client);
    if (!st || st.aborted) return 0;
    if (!st.offline && st.pendingBytes >= 1600) {
      const slice = this.takeBytes(st, st.pendingBytes);
      this.enqueueRender(client, st, slice, onSegment);
    }
    await st.chain;
    return st.emitted;
  }

  async streamFullPcm(
    client: object,
    pcm: Buffer,
    sampleRate: number,
    onSegment: StreamSegmentHandler,
  ): Promise<number> {
    this.beginTurn(client, sampleRate);
    const st = this.clients.get(client)!;
    if (st.offline || !this.isStreamModeEnabled()) {
      this.logger.warn('streamFullPcm skipped — MuseTalk offline or stream disabled');
      return 0;
    }
    const need = Math.floor(this.sliceSec() * sampleRate) * 2;
    for (let offset = 0; offset < pcm.length; offset += need) {
      if (st.aborted || st.offline) break;
      const slice = pcm.subarray(offset, Math.min(pcm.length, offset + need));
      if (slice.length < 1600) continue;
      this.enqueueRender(client, st, Buffer.from(slice), onSegment);
    }
    await st.chain;
    return st.emitted;
  }

  /**
   * Render all PCM slices to MP4 buffers (no live progressive emit).
   * Used for long intro beats: Colab is ~10–15s per 2s clip — progressive play underruns.
   * Caller concatenates + caches → one smooth turn_video_ready (like Beat 1/2).
   */
  async renderAllSlicesToBuffers(
    pcm: Buffer,
    sampleRate: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Buffer[]> {
    if (!this.isAvatarReachable()) {
      this.logger.warn('renderAllSlicesToBuffers skipped — MuseTalk offline');
      return [];
    }
    const need = Math.floor(this.sliceSec() * sampleRate) * 2;
    const slices: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += need) {
      const slice = pcm.subarray(offset, Math.min(pcm.length, offset + need));
      if (slice.length < 1600) continue;
      slices.push(Buffer.from(slice));
    }
    const out: Buffer[] = [];
    for (let i = 0; i < slices.length; i++) {
      if (!this.isAvatarReachable()) break;
      try {
        const mp4 = await this.renderSlice(slices[i], sampleRate, `intro_full_${i + 1}`);
        if (mp4 && mp4.length > 1000) {
          out.push(mp4);
          this.logger.log(
            `Intro full-render slice ${i + 1}/${slices.length} ok (${mp4.length}B)`,
          );
        } else {
          this.logger.warn(`Intro full-render slice ${i + 1}/${slices.length} empty`);
          this.markAvatarOffline('empty intro slice');
          break;
        }
      } catch (err: any) {
        this.logger.warn(
          `Intro full-render slice ${i + 1}/${slices.length} failed: ${err.message}`,
        );
        this.markAvatarOffline(err?.message || 'intro slice fail');
        break;
      }
      onProgress?.(i + 1, slices.length);
    }
    return out;
  }

  private takeBytes(st: ClientStreamState, n: number): Buffer {
    const out = Buffer.alloc(n);
    let offset = 0;
    while (offset < n && st.pending.length) {
      const head = st.pending[0];
      const take = Math.min(head.length, n - offset);
      head.copy(out, offset, 0, take);
      offset += take;
      if (take >= head.length) st.pending.shift();
      else st.pending[0] = head.subarray(take);
    }
    st.pendingBytes -= n;
    return out;
  }

  private enqueueRender(
    _client: object,
    st: ClientStreamState,
    pcm: Buffer,
    onSegment: StreamSegmentHandler,
  ): void {
    const turnId = st.turnId;
    const seq = ++st.seq;
    const sampleRate = st.sampleRate;
    const dur = pcm.length / 2 / sampleRate;

    st.chain = st.chain
      .then(async () => {
        if (st.aborted || st.turnId !== turnId || st.offline) return;
        try {
          const mp4 = await this.renderSlice(pcm, sampleRate, `stream_${turnId}_${seq}`);
          if (st.aborted || st.turnId !== turnId || !mp4) {
            st.failStreak += 1;
            if (st.failStreak >= this.failThreshold()) {
              st.offline = true;
              this.markAvatarOffline(`empty/fail at seq=${seq}`);
            }
            return;
          }
          st.failStreak = 0;
          st.emitted += 1;
          onSegment({
            seq,
            videoBase64: mp4.toString('base64'),
            mimeType: 'video/mp4',
            durationHintSec: dur,
          });
          this.logger.log(`Stream segment seq=${seq} dur≈${dur.toFixed(2)}s (${mp4.length}B)`);
        } catch (err: any) {
          st.failStreak += 1;
          this.logger.warn(`Stream segment seq=${seq} failed: ${err.message}`);
          if (st.failStreak >= this.failThreshold()) {
            st.offline = true;
            st.pending = [];
            st.pendingBytes = 0;
            this.markAvatarOffline(err?.message || 'fetch failed');
            this.logger.warn(
              `MuseTalk circuit-break after ${st.failStreak} failures — remaining slices skipped`,
            );
          }
        }
      })
      .catch((err) => this.logger.warn(`Stream chain error: ${err.message}`));
  }

  private async renderSlice(
    pcm: Buffer,
    sampleRate: number,
    requestId: string,
  ): Promise<Buffer | null> {
    const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim().replace(/\/+$/, '');
    if (!avatarUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(`${avatarUrl}/api/generate_from_pcm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pcm_base64: pcm.toString('base64'),
          sample_rate: sampleRate,
          avatar_id: 'avator_1',
          request_id: requestId.slice(0, 24),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      const remuxed = await remuxGeminiPcmIntoMp4(raw, pcm, sampleRate);
      return remuxed ? Buffer.from(remuxed) : raw.length > 1000 ? raw : null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
