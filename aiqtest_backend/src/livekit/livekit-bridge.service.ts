import { Injectable, Logger } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose as livekitDispose,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { LivekitService } from './livekit.service';
import { livekitFlags } from './livekit-flags';

export type BridgePcmHandler = (pcmBase64: string) => void;

interface BridgeSession {
  room: Room;
  roomName: string;
  aborted: boolean;
  consumeTasks: Set<Promise<void>>;
  audioSource?: AudioSource;
  videoSource?: VideoSource;
  audioTrack?: LocalAudioTrack;
  videoTrack?: LocalVideoTrack;
  mediaReady: boolean;
  mediaChain: Promise<void>;
  /** Phase 3c: bump on barge-in to drop in-flight ffmpeg publish */
  mediaGeneration: number;
  videoWidth: number;
  videoHeight: number;
  publishedSegments: number;
  startedAt: number;
}

/**
 * Phase 3a+3b: Nest joins student LiveKit room.
 * - Subscribe student mic → Gemini (16 kHz)
 * - Publish counselor MuseTalk A/V (and PCM fallback) back to the browser
 */
@Injectable()
export class LivekitBridgeService {
  private readonly logger = new Logger(LivekitBridgeService.name);
  private bridges = new Map<object, BridgeSession>();
  private disposedRuntime = false;

  constructor(private readonly livekit: LivekitService) {}

  isEnabled(): boolean {
    return livekitFlags().bridge;
  }

  isMediaOutEnabled(): boolean {
    return livekitFlags().mediaOut;
  }

  getStatus(clientKey: object): {
    active: boolean;
    roomName?: string;
    mediaReady: boolean;
    publishedSegments: number;
    uptimeMs: number;
  } {
    const session = this.bridges.get(clientKey);
    if (!session || session.aborted) {
      return { active: false, mediaReady: false, publishedSegments: 0, uptimeMs: 0 };
    }
    return {
      active: true,
      roomName: session.roomName,
      mediaReady: session.mediaReady,
      publishedSegments: session.publishedSegments,
      uptimeMs: Date.now() - session.startedAt,
    };
  }

  async startBridge(
    clientKey: object,
    roomName: string,
    onPcm: BridgePcmHandler,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.warn('LiveKit bridge disabled or not configured');
      return false;
    }

    await this.stopBridge(clientKey);

    const safeRoom = roomName.replace(/\W+/g, '_').slice(0, 64);
    if (!safeRoom) return false;

    try {
      const token = await this.createBridgeToken(safeRoom);
      const url = this.livekit.getPublicUrl();
      const room = new Room();
      const session: BridgeSession = {
        room,
        roomName: safeRoom,
        aborted: false,
        consumeTasks: new Set(),
        mediaReady: false,
        mediaChain: Promise.resolve(),
        mediaGeneration: 0,
        videoWidth: 512,
        videoHeight: 512,
        publishedSegments: 0,
        startedAt: Date.now(),
      };
      this.bridges.set(clientKey, session);

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (session.aborted) return;
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        const task = this.consumeAudioTrack(session, track, onPcm);
        session.consumeTasks.add(task);
        void task.finally(() => session.consumeTasks.delete(task));
      });

      room.on(RoomEvent.Disconnected, () => {
        this.logger.log(`LiveKit bridge disconnected room=${safeRoom}`);
      });

      await room.connect(url, token, { autoSubscribe: true, dynacast: true });
      this.logger.log(`LiveKit bridge joined room=${safeRoom}`);

      if (this.isMediaOutEnabled()) {
        await this.ensureOutboundTracks(session);
      }

      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.track.kind === TrackKind.KIND_AUDIO) {
            const task = this.consumeAudioTrack(session, pub.track as RemoteTrack, onPcm);
            session.consumeTasks.add(task);
            void task.finally(() => session.consumeTasks.delete(task));
          }
        }
      }

      return true;
    } catch (err: any) {
      this.logger.warn(`LiveKit bridge start failed: ${err?.message || err}`);
      await this.stopBridge(clientKey);
      return false;
    }
  }

  async stopBridge(clientKey: object): Promise<void> {
    const session = this.bridges.get(clientKey);
    if (!session) return;
    session.aborted = true;
    this.bridges.delete(clientKey);
    try {
      session.audioSource?.clearQueue();
    } catch (_) {}
    try {
      await session.audioSource?.close();
    } catch (_) {}
    try {
      await session.videoSource?.close();
    } catch (_) {}
    try {
      await session.audioTrack?.close();
    } catch (_) {}
    try {
      await session.videoTrack?.close();
    } catch (_) {}
    try {
      await session.room.disconnect();
    } catch (_) {}
    this.logger.log(`LiveKit bridge stopped room=${session.roomName}`);
  }

  /** @deprecated use interruptCounselorMedia */
  clearCounselorMedia(clientKey: object): void {
    this.interruptCounselorMedia(clientKey);
  }

  /**
   * Phase 3c: barge-in / interrupt — drop queued + in-flight counselor A/V publish.
   */
  interruptCounselorMedia(clientKey: object): void {
    const session = this.bridges.get(clientKey);
    if (!session) return;
    session.mediaGeneration += 1;
    try {
      session.audioSource?.clearQueue();
    } catch (_) {}
    this.logger.log(
      `LiveKit counselor media interrupted room=${session.roomName} gen=${session.mediaGeneration}`,
    );
  }

  /**
   * Phase 3b: publish remuxed MuseTalk MP4 (lips + Gemini speech) over LiveKit.
   */
  publishCounselorMp4(clientKey: object, mp4: Buffer): void {
    if (!this.isMediaOutEnabled() || mp4.length < 1000) return;
    const session = this.bridges.get(clientKey);
    if (!session || session.aborted || !session.mediaReady) return;

    const gen = session.mediaGeneration;
    session.mediaChain = session.mediaChain
      .then(async () => {
        if (session.aborted || gen !== session.mediaGeneration) return;
        await this.pushMp4ToLiveKit(session, mp4, gen);
        if (!session.aborted && gen === session.mediaGeneration) {
          session.publishedSegments += 1;
        }
      })
      .catch((err) =>
        this.logger.warn(`LiveKit MP4 publish failed: ${err?.message || err}`),
      );
  }

  /**
   * Phase 3b fallback: Gemini PCM only (no MuseTalk video).
   */
  publishCounselorPcm(clientKey: object, pcm: Buffer, sampleRate = 24000): void {
    if (!this.isMediaOutEnabled() || pcm.length < 2) return;
    const session = this.bridges.get(clientKey);
    if (!session || session.aborted || !session.mediaReady || !session.audioSource) return;

    const gen = session.mediaGeneration;
    session.mediaChain = session.mediaChain
      .then(async () => {
        if (session.aborted || gen !== session.mediaGeneration || !session.audioSource) return;
        const samples = new Int16Array(
          pcm.buffer,
          pcm.byteOffset,
          Math.floor(pcm.byteLength / 2),
        );
        const frameSize = Math.floor(sampleRate / 50); // 20ms
        for (let i = 0; i < samples.length; i += frameSize) {
          if (session.aborted || gen !== session.mediaGeneration) break;
          const slice = samples.subarray(i, Math.min(samples.length, i + frameSize));
          if (slice.length < 80) continue;
          const frame = new AudioFrame(
            slice,
            sampleRate,
            1,
            slice.length,
          );
          await session.audioSource.captureFrame(frame);
        }
      })
      .catch((err) =>
        this.logger.warn(`LiveKit PCM publish failed: ${err?.message || err}`),
      );
  }

  async shutdownAll(): Promise<void> {
    const keys = [...this.bridges.keys()];
    await Promise.all(keys.map((k) => this.stopBridge(k)));
    if (!this.disposedRuntime) {
      this.disposedRuntime = true;
      try {
        await livekitDispose();
      } catch (_) {}
    }
  }

  private async ensureOutboundTracks(session: BridgeSession): Promise<void> {
    if (session.mediaReady) return;
    const participant = session.room.localParticipant;
    if (!participant) throw new Error('no local participant');

    const audioSource = new AudioSource(24000, 1, 1000);
    const audioTrack = LocalAudioTrack.createAudioTrack('counselor-audio', audioSource);
    const audioOpts = new TrackPublishOptions();
    audioOpts.source = TrackSource.SOURCE_MICROPHONE;
    await participant.publishTrack(audioTrack, audioOpts);

    const w = session.videoWidth;
    const h = session.videoHeight;
    const videoSource = new VideoSource(w, h);
    const videoTrack = LocalVideoTrack.createVideoTrack('counselor-video', videoSource);
    const videoOpts = new TrackPublishOptions();
    videoOpts.source = TrackSource.SOURCE_CAMERA;
    await participant.publishTrack(videoTrack, videoOpts);

    session.audioSource = audioSource;
    session.videoSource = videoSource;
    session.audioTrack = audioTrack;
    session.videoTrack = videoTrack;
    session.mediaReady = true;
    this.logger.log(
      `LiveKit counselor A/V tracks published room=${session.roomName} ${w}x${h}`,
    );
  }

  private async pushMp4ToLiveKit(
    session: BridgeSession,
    mp4: Buffer,
    gen: number,
  ): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-av-'));
    const mp4Path = path.join(tmpDir, 'seg.mp4');
    fs.writeFileSync(mp4Path, mp4);

    try {
      if (session.aborted || gen !== session.mediaGeneration) return;
      const meta = await this.probeVideo(mp4Path);
      const fps = meta.fps > 1 && meta.fps < 60 ? meta.fps : 25;
      const w = session.videoWidth;
      const h = session.videoHeight;
      const frameBytes = w * h + 2 * Math.floor((w + 1) / 2) * Math.floor((h + 1) / 2);

      const audioPromise = this.streamMp4AudioToLiveKit(session, mp4Path, gen);
      const videoPromise = this.streamMp4VideoToLiveKit(
        session,
        mp4Path,
        w,
        h,
        fps,
        frameBytes,
        gen,
      );
      await Promise.all([audioPromise, videoPromise]);
      if (!session.aborted && gen === session.mediaGeneration) {
        this.logger.log(
          `LiveKit published MP4 room=${session.roomName} seg#${session.publishedSegments + 1} (~${(mp4.length / 1024).toFixed(0)}KB)`,
        );
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  private streamMp4AudioToLiveKit(
    session: BridgeSession,
    mp4Path: string,
    gen: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!session.audioSource) {
        resolve();
        return;
      }
      const ff = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          mp4Path,
          '-f',
          's16le',
          '-acodec',
          'pcm_s16le',
          '-ac',
          '1',
          '-ar',
          '24000',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let pending = Buffer.alloc(0);
      const frameBytes = 960 * 2; // 20ms @ 24k mono s16
      let pumpChain = Promise.resolve();
      let frameIdx = 0;
      const startMs = Date.now();

      const stopEarly = () => session.aborted || gen !== session.mediaGeneration;

      ff.stdout.on('data', (chunk: Buffer) => {
        if (stopEarly()) {
          try {
            ff.kill('SIGKILL');
          } catch (_) {}
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        pumpChain = pumpChain.then(async () => {
          while (pending.length >= frameBytes && !stopEarly() && session.audioSource) {
            const slice = pending.subarray(0, frameBytes);
            pending = pending.subarray(frameBytes);
            const samples = new Int16Array(
              slice.buffer,
              slice.byteOffset,
              slice.byteLength / 2,
            );
            // Realtime pace — dumping decode-speed frames causes WebRTC underrun "shhhh"
            const target = startMs + frameIdx * 20;
            frameIdx += 1;
            const delay = target - Date.now();
            if (delay > 2) await new Promise((r) => setTimeout(r, delay));
            if (stopEarly() || !session.audioSource) break;
            try {
              await session.audioSource.captureFrame(
                new AudioFrame(samples, 24000, 1, samples.length),
              );
            } catch (err: any) {
              this.logger.warn(`audio captureFrame: ${err?.message || err}`);
              break;
            }
          }
        });
      });

      ff.on('error', reject);
      ff.on('close', (code) => {
        void pumpChain.finally(() => {
          if (code === 0 || stopEarly()) resolve();
          else reject(new Error(`ffmpeg audio exit ${code}`));
        });
      });
    });
  }

  private streamMp4VideoToLiveKit(
    session: BridgeSession,
    mp4Path: string,
    w: number,
    h: number,
    fps: number,
    frameBytes: number,
    gen: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!session.videoSource) {
        resolve();
        return;
      }
      const ff = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          mp4Path,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          '-s',
          `${w}x${h}`,
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let pending = Buffer.alloc(0);
      let frameIdx = 0;
      const startMs = Date.now();
      let chain = Promise.resolve();
      const stopEarly = () => session.aborted || gen !== session.mediaGeneration;

      ff.stdout.on('data', (chunk: Buffer) => {
        if (stopEarly()) {
          try {
            ff.kill('SIGKILL');
          } catch (_) {}
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= frameBytes && !stopEarly()) {
          const raw = pending.subarray(0, frameBytes);
          pending = pending.subarray(frameBytes);
          const idx = frameIdx++;
          const copy = Buffer.from(raw);
          chain = chain.then(async () => {
            if (stopEarly() || !session.videoSource) return;
            const target = startMs + (idx * 1000) / fps;
            const delay = target - Date.now();
            if (delay > 2) await new Promise((r) => setTimeout(r, delay));
            if (stopEarly() || !session.videoSource) return;
            const frame = new VideoFrame(
              new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength),
              w,
              h,
              VideoBufferType.I420,
            );
            session.videoSource.captureFrame(frame);
          });
        }
      });

      ff.on('error', reject);
      ff.on('close', (code) => {
        void chain
          .then(() => {
            if (code === 0 || stopEarly()) resolve();
            else reject(new Error(`ffmpeg video exit ${code}`));
          })
          .catch(reject);
      });
    });
  }

  private probeVideo(
    mp4Path: string,
  ): Promise<{ width: number; height: number; fps: number }> {
    return new Promise((resolve) => {
      const ff = spawn(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height,r_frame_rate',
          '-of',
          'csv=p=0',
          mp4Path,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      ff.stdout.on('data', (d) => {
        out += d.toString();
      });
      ff.on('close', () => {
        const parts = out.trim().split(',');
        const width = parseInt(parts[0], 10) || 512;
        const height = parseInt(parts[1], 10) || 512;
        let fps = 25;
        if (parts[2] && parts[2].includes('/')) {
          const [a, b] = parts[2].split('/').map(Number);
          if (a > 0 && b > 0) fps = a / b;
        }
        resolve({ width, height, fps });
      });
      ff.on('error', () => resolve({ width: 512, height: 512, fps: 25 }));
    });
  }

  private async createBridgeToken(roomName: string): Promise<string> {
    const apiKey = (process.env.LIVEKIT_API_KEY || 'devkey').trim();
    const apiSecret = (process.env.LIVEKIT_API_SECRET || 'secret_dev_livekit_change_me').trim();
    const identity = `bridge_${roomName}`.slice(0, 64);

    // IMPORTANT: do NOT set hidden:true — student browser must see this participant
    // to subscribe counselor-audio / counselor-video (WebRTC lips path).
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: 'Priya Counselor',
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      hidden: false,
    });
    return at.toJwt();
  }

  private async consumeAudioTrack(
    session: BridgeSession,
    track: RemoteTrack,
    onPcm: BridgePcmHandler,
  ): Promise<void> {
    this.logger.log(`LiveKit bridge consuming audio track room=${session.roomName}`);
    const stream = new AudioStream(track, 16000, 1);
    try {
      for await (const frame of stream) {
        if (session.aborted) break;
        const samples = frame.data;
        if (!samples || samples.length < 80) continue;

        const bytes = Buffer.from(
          samples.buffer,
          samples.byteOffset,
          samples.byteLength,
        );
        onPcm(bytes.toString('base64'));
      }
    } catch (err: any) {
      if (!session.aborted) {
        this.logger.warn(`LiveKit bridge audio consume ended: ${err?.message || err}`);
      }
    }
  }
}
