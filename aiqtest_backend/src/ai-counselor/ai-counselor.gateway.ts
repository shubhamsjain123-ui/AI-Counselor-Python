import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket, Server } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AiCounselorService,
  buildSabcqSystemInstruction,
  buildPhase2UnlockInstruction,
  SABCQ_PHASES,
} from './ai-counselor.service';
import { ACADEMIC_MILESTONES } from './frameworks/academic-phase.framework';
import { DUMMY_STUDENT_REPORT } from './data/dummy-student-report';
import { IntroBeatId, INTRO_BEAT_META } from './scripted-intro';
import {
  remuxGeminiPcmIntoMp4,
  mp4MatchesPcmDuration,
  concatMp4Buffers,
} from './avatar-remux';
import { LipSyncStreamService } from './lip-sync-stream.service';
import { LivekitBridgeService } from '../livekit/livekit-bridge.service';
import { livekitFlags } from '../livekit/livekit-flags';

// NOTE: the service path is case-sensitive and must stay lowercase
// ("generativelanguage"), otherwise Google answers the WS upgrade with HTTP 404.
const GEMINI_LIVE_WS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Only these models support bidiGenerateContent on the Live API.
// Plain chat models (gemini-2.0-flash / gemini-2.5-flash) are rejected with 1008.
const GEMINI_LIVE_MODELS = [
  'models/gemini-2.5-flash-native-audio-preview-12-2025',
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
];

const VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';
const HANDSHAKE_TIMEOUT_MS = 10000;

interface ClientCounselingState {
  currentPhase: number;
  currentMilestoneIndex: number;
  totalTurnCount: number;
  milestoneTurnCount: number;
  milestoneStartedAt: number;
  phaseStartedAt: number;
  wasInterrupted: boolean;
  /**
   * Phase-1 controlled intro: we prompt Gemini per beat; mic is VAD-only until Beat 3 done.
   * Gemini voice PCM → MuseTalk → lip-sync video on screen.
   */
  scriptedIntroActive: boolean;
  introBeatCompleted: number;
  awaitingStudentReply: boolean;
  /** Which intro beat we asked Gemini to speak (0 = none in flight). */
  pendingIntroBeat: number;
}

@WebSocketGateway({ path: '/ws/live-counselor', cors: { origin: '*' } })
export class AiCounselorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AiCounselorGateway.name);

  @WebSocketServer()
  server: Server;

  // Active client sockets mapped to their Gemini Live WS sessions
  private clientGeminiSockets = new Map<WebSocket, WebSocket>();
  // Active client counseling milestone state
  private clientCounselingStates = new Map<WebSocket, ClientCounselingState>();
  // Accumulated 24kHz PCM chunks per client for current turn (for Cloud GPU MuseTalk rendering)
  private clientTurnPcm = new Map<WebSocket, string[]>();
  // In-flight MuseTalk render abort controllers (cancel on barge-in / disconnect)
  private clientAvatarAbort = new Map<WebSocket, AbortController>();
  // Monotonic render id so a late response from an aborted job is ignored
  private clientAvatarRenderId = new Map<WebSocket, number>();
  // Phase 2: emit stream_started once per live turn (first Gemini PCM)
  private clientStreamAnnounced = new Map<WebSocket, boolean>();
  // Phase 3a: when LiveKit bridge is active, ignore WS mic uplink (avoid double audio)
  private clientLivekitUplink = new Map<WebSocket, boolean>();
  constructor(
    private readonly counselorService: AiCounselorService,
    private readonly lipSyncStream: LipSyncStreamService,
    private readonly livekitBridge: LivekitBridgeService,
  ) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Client connected to Live Counselor WebSocket');
    this.clientTurnPcm.set(client, []);
    this.clientAvatarRenderId.set(client, 0);
    this.lipSyncStream.beginTurn(client, 24000);
    this.clientCounselingStates.set(client, {
      currentPhase: 1,
      currentMilestoneIndex: 0,
      totalTurnCount: 0,
      milestoneTurnCount: 0,
      milestoneStartedAt: Date.now(),
      phaseStartedAt: Date.now(),
      wasInterrupted: false,
      scriptedIntroActive: true,
      introBeatCompleted: 0,
      awaitingStudentReply: false,
      pendingIntroBeat: 0,
    });
  }

  handleDisconnect(client: WebSocket) {
    this.logger.log('Client disconnected from Live Counselor WebSocket');
    this.cancelAvatarRender(client);
    this.lipSyncStream.clear(client);
    void this.livekitBridge.stopBridge(client);
    this.clientLivekitUplink.delete(client);
    this.closeGeminiSocket(client);
    this.clientCounselingStates.delete(client);
    this.clientTurnPcm.delete(client);
    this.clientAvatarRenderId.delete(client);
    this.clientStreamAnnounced.delete(client);
  }

  /** Phase 2/3b: MuseTalk clip → LiveKit A/V (+ WS fallback for progressive player). */
  private emitStreamSegment(
    client: WebSocket,
    seg: {
      seq: number;
      videoBase64: string;
      mimeType: string;
      durationHintSec: number;
    },
  ): void {
    try {
      const mp4 = Buffer.from(seg.videoBase64, 'base64');
      this.livekitBridge.publishCounselorMp4(client, mp4);
    } catch (_) {}

    const flags = livekitFlags();
    // Dual-safe: always publish on LiveKit when mediaOut, AND keep WS base64 as
    // emergency lips if WebRTC tracks never attach (avoids black screen).
    this.sendToClient(client, {
      event: 'stream_video_segment',
      seq: seg.seq,
      videoBase64: seg.videoBase64,
      mimeType: seg.mimeType,
      durationHintSec: seg.durationHintSec,
      streamMode: true,
      livekitMedia: flags.mediaOut,
      wsFallback: flags.wsFallback,
      wsFallbackMs: flags.wsFallbackMs,
    });
  }

  /** Batch full-turn / cached intro MP4 → LiveKit + existing WS event. */
  private emitTurnVideoReady(
    client: WebSocket,
    payload: Record<string, unknown> & { videoBase64: string },
  ): void {
    try {
      const mp4 = Buffer.from(payload.videoBase64, 'base64');
      this.livekitBridge.publishCounselorMp4(client, mp4);
    } catch (_) {}
    this.sendToClient(client, {
      ...payload,
      event: 'turn_video_ready',
      livekitMedia: this.livekitBridge.isMediaOutEnabled(),
    });
  }

  private cancelAvatarRender(client: WebSocket): void {
    const pending = this.clientAvatarAbort.get(client);
    if (pending) {
      try {
        pending.abort();
      } catch (_) {}
      this.clientAvatarAbort.delete(client);
    }
    const nextId = (this.clientAvatarRenderId.get(client) || 0) + 1;
    this.clientAvatarRenderId.set(client, nextId);
  }

  /**
   * Safe send to the browser: never throws when the socket is already gone.
   */
  private sendToClient(client: WebSocket, payload: Record<string, unknown>): void {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(payload));
    } catch (err: any) {
      this.logger.warn(`Failed to push event to client: ${err.message}`);
    }
  }

  private closeGeminiSocket(client: WebSocket): void {
    const geminiWs = this.clientGeminiSockets.get(client);
    this.clientGeminiSockets.delete(client);
    this.clientTurnPcm.delete(client);
    if (!geminiWs) return;
    try {
      geminiWs.removeAllListeners('close');
      geminiWs.close();
    } catch (_) {}
  }

  @SubscribeMessage('start_live_session')
  async handleStartLiveSession(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { studentId?: string; languagePreference?: string },
  ) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();

    if (!apiKey || apiKey === 'not_set') {
      this.sendToClient(client, {
        event: 'error',
        message: 'GEMINI_API_KEY is missing on the backend. Set it in aiqtest_backend/.env.',
      });
      return;
    }

    // Close any previous Gemini WS for this client
    this.closeGeminiSocket(client);

    const report = DUMMY_STUDENT_REPORT;
    const langPref = data?.languagePreference || 'hinglish';
    // Phase-1 only: no academic protocol — otherwise Gemini Live invents career openers.
    const systemInstructionText = buildSabcqSystemInstruction(report, langPref, SABCQ_PHASES[0], {
      includeAcademicProtocol: false,
    });

    const lastFailure = { message: 'unknown error' };

    for (const modelName of GEMINI_LIVE_MODELS) {
      try {
        const opened = await this.openGeminiLiveSession(client, modelName, systemInstructionText, apiKey);

        if (opened) {
          this.logger.log(`Gemini Live WS ready. model=${modelName} voice=${VOICE_NAME}`);
          return;
        }
      } catch (err: any) {
        lastFailure.message = err.message;
        this.logger.warn(`Failed to start Gemini Live WS on model ${modelName}: ${err.message}`);
      }
    }

    this.logger.error(`All Gemini Live models failed. Last error: ${lastFailure.message}`);
    this.sendToClient(client, {
      event: 'live_ws_fallback',
      message: `Gemini Live WebSocket stream unavailable (${lastFailure.message}). Falling back to HTTP REST counselor.`,
    });
  }

  /**
   * Opens the Gemini Live WS, sends `setup`, and resolves ONLY once Gemini
   * acknowledges with `setupComplete`. Rejects fast on error/early close so we
   * do not burn the full timeout on a dead model.
   */
  private openGeminiLiveSession(
    client: WebSocket,
    modelName: string,
    systemInstructionText: string,
    apiKey: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const geminiWs = new WebSocket(`${GEMINI_LIVE_WS_BASE_URL}?key=${apiKey}`);
      let settled = false;

      // Only used on failure: on success the message listener must stay attached
      // so server output keeps streaming to the browser.
      const teardown = () => {
        clearTimeout(timeout);
        geminiWs.removeAllListeners('open');
        geminiWs.removeAllListeners('message');
        geminiWs.removeAllListeners('error');
        geminiWs.removeAllListeners('close');
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.clientGeminiSockets.set(client, geminiWs);
        const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();
        this.sendToClient(client, {
          event: 'live_session_started',
          model: modelName,
          voice: VOICE_NAME,
          message: 'Connected to Live Gemini Realtime Voice Stream!',
          avatarServiceUrl: avatarUrl,
          lipsyncMode: this.lipSyncStream.isStreamModeEnabled() ? 'stream' : 'batch',
          sliceSec: parseFloat(process.env.LIPSYNC_SLICE_SEC || '0.8'),
        });
        // Warm MuseTalk GPU first (Phase 1.5), then Beat 1 — gives models time to load on Colab.
        void (async () => {
          await this.warmupAvatarService(client);
          const st = this.clientCounselingStates.get(client);
          if (st?.scriptedIntroActive && st.introBeatCompleted === 0 && st.pendingIntroBeat === 0) {
            this.logger.log('Auto-starting exact Gemini Intro Beat 1 after warmup.');
            void this.promptGeminiIntroBeat(client, 1);
          }
        })();
        resolve(true);
      };

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        teardown();
        try {
          geminiWs.close();
        } catch (_) {}
        reject(new Error(message));
      };

      const timeout = setTimeout(
        () => fail('Timed out waiting for Gemini setup acknowledgement'),
        HANDSHAKE_TIMEOUT_MS,
      );

      geminiWs.on('open', () => {
        const setupMsg = {
          setup: {
            model: modelName,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
              },
              // Lowest practical temp so Beat-1 "Good morning" is followed.
              temperature: 0.1,
            },
            systemInstruction: { parts: [{ text: systemInstructionText }] },
          },
        };
        geminiWs.send(JSON.stringify(setupMsg));
      });

      geminiWs.on('message', (rawMessage: Buffer) => {
        let parsed: any;
        try {
          parsed = JSON.parse(rawMessage.toString('utf-8'));
        } catch (_) {
          return;
        }

        // Gemini rejected the session - surface the real reason instead of hanging.
        if (parsed.error) {
          const reason = parsed.error.message || 'unknown Gemini error';
          this.logger.warn(`Gemini Live WS rejected model ${modelName}: ${reason}`);
          if (!this.clientGeminiSockets.has(client)) {
            fail(reason);
          } else {
            this.sendToClient(client, { event: 'error', message: reason });
            this.closeGeminiSocket(client);
          }
          return;
        }

        // Gate "connected" on the real setup acknowledgement.
        if (!settled) {
          if (parsed.setupComplete) {
            succeed();
          }
          return;
        }

        this.relayServerContent(client, parsed);
      });

      geminiWs.on('error', (err) => {
        if (!settled) fail(err.message);
      });

      geminiWs.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer?.toString() || '';
        if (!settled) {
          fail(`Gemini Live WS closed before setup (code ${code}) ${reason}`.trim());
          return;
        }
        this.logger.log(`Gemini Live WS closed (code ${code}). ${reason}`);
        this.clientGeminiSockets.delete(client);
        this.sendToClient(client, {
          event: 'live_ws_closed',
          message: `Gemini Live stream closed (code ${code}). ${reason}`.trim(),
        });
      });
    });
  }

  /**
   * Forwards Gemini server output (24kHz PCM audio + text) to the browser.
   */
  private relayServerContent(client: WebSocket, parsed: any): void {
    const serverContent = parsed.serverContent;
    if (!serverContent) return;

    const parts = serverContent.modelTurn?.parts || [];
    for (const part of parts) {
      // `thought` parts are the model's internal reasoning - never surface those.
      if (part.thought === true) continue;

      if (part.inlineData?.data) {
        const mimeType: string = part.inlineData.mimeType || 'audio/pcm;rate=24000';
        const rateMatch = /rate=(\d+)/i.exec(mimeType);
        const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
        let turnBuffer = this.clientTurnPcm.get(client);
        if (!turnBuffer) {
          turnBuffer = [];
          this.clientTurnPcm.set(client, turnBuffer);
        }
        turnBuffer.push(part.inlineData.data);

        // Browser buffers PCM for audio playback / fallback.
        this.sendToClient(client, {
          event: 'audio_chunk',
          data: part.inlineData.data,
          mimeType,
        });

        // Phase 2: stream short MuseTalk clips as Gemini speaks (skip during scripted intro).
        const stateEarly = this.clientCounselingStates.get(client);
        if (
          this.lipSyncStream.isStreamModeEnabled() &&
          !stateEarly?.scriptedIntroActive
        ) {
          if (!this.clientStreamAnnounced.get(client)) {
            this.clientStreamAnnounced.set(client, true);
            this.sendToClient(client, {
              event: 'stream_started',
              sliceSec: parseFloat(process.env.LIPSYNC_SLICE_SEC || '0.8'),
            });
          }
          this.lipSyncStream.pushPcmBase64(
            client,
            part.inlineData.data,
            sampleRate,
            (seg) => this.emitStreamSegment(client, seg),
          );
        }
      }
      if (part.text) {
        this.sendToClient(client, { event: 'text_chunk', text: part.text });
      }
    }

    if (serverContent.interrupted) {
      this.clientTurnPcm.set(client, []);
      this.cancelAvatarRender(client);
      this.lipSyncStream.abort(client);
      this.clientStreamAnnounced.set(client, false);
      const state = this.clientCounselingStates.get(client);
      if (state) {
        state.wasInterrupted = true;
        state.pendingIntroBeat = 0;
      }
      this.sendToClient(client, { event: 'interrupted' });
    }

    if (serverContent.turnComplete) {
      const turnBuffer = this.clientTurnPcm.get(client) || [];
      this.clientTurnPcm.set(client, []);
      const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();

      const state = this.clientCounselingStates.get(client);

      // Phase-1 intro beats are exact Gemini speech (not Live turns) — ignore stray Live audio.
      if (state?.scriptedIntroActive) {
        this.clientTurnPcm.set(client, []);
        this.logger.log('Ignoring Gemini Live turn during Phase-1 exact-speech intro.');
        return;
      }

      // Phase 2 stream: flush leftover PCM slices — do NOT wait for one giant MP4.
      if (
        this.lipSyncStream.isStreamModeEnabled() &&
        !state?.wasInterrupted
      ) {
        void this.lipSyncStream
          .flush(client, (seg) => this.emitStreamSegment(client, seg))
          .then((emitted) => {
            this.sendToClient(client, {
              event: 'stream_turn_flushed',
              segmentsEmitted: emitted,
            });
            if (emitted === 0 && this.clientStreamAnnounced.get(client)) {
              this.sendToClient(client, {
                event: 'turn_video_failed',
                message:
                  'MuseTalk offline — no lip-sync segments. Playing Gemini audio only.',
              });
            }
            this.clientStreamAnnounced.set(client, false);
            this.lipSyncStream.beginTurn(client, 24000);
          });
      } else if (
        avatarUrl &&
        turnBuffer.length > 0 &&
        !state?.wasInterrupted &&
        this.lipSyncStream.isAvatarReachable()
      ) {
        // Batch fallback (LIPSYNC_MODE=batch)
        this.renderAvatarTurnVideo(client, avatarUrl, turnBuffer);
      }
      if (state) {
        // If this turn was aborted/interrupted by a barge-in, do NOT advance conversation counters or milestones!
        if (state.wasInterrupted) {
          state.wasInterrupted = false;
          const currentMilestone = state.currentPhase === 2 ? ACADEMIC_MILESTONES[state.currentMilestoneIndex] : null;
          this.sendToClient(client, {
            event: 'turn_complete',
            phaseNumber: state.currentPhase,
            phaseName: state.currentPhase === 2 ? 'Academic Profile & Improvement Plan' : SABCQ_PHASES[state.currentPhase - 1]?.name || 'Active Phase',
            milestoneId: currentMilestone?.id,
            milestoneName: currentMilestone?.name,
            milestonePart: currentMilestone?.part,
            targetDuration: currentMilestone?.targetDuration,
          });
          return;
        }

        state.totalTurnCount++;

        if (state.currentPhase === 2) {
          state.milestoneTurnCount++;

          const REQUIRED_TURNS_PER_MILESTONE = 2;
          const timeOnMilestoneSec = (Date.now() - state.milestoneStartedAt) / 1000;

          if (
            state.milestoneTurnCount >= REQUIRED_TURNS_PER_MILESTONE &&
            state.currentMilestoneIndex < ACADEMIC_MILESTONES.length - 1
          ) {
            state.currentMilestoneIndex++;
            state.milestoneTurnCount = 0;
            state.milestoneStartedAt = Date.now();
            const nextMilestone = ACADEMIC_MILESTONES[state.currentMilestoneIndex];
            this.logger.log(
              `Advancing to Academic Milestone ${state.currentMilestoneIndex + 1}/${ACADEMIC_MILESTONES.length}: "${nextMilestone.name}" (Time on previous: ${timeOnMilestoneSec.toFixed(0)}s)`,
            );
          }
        }

        const milestone =
          state.currentPhase === 2
            ? ACADEMIC_MILESTONES[state.currentMilestoneIndex]
            : null;

        this.sendToClient(client, {
          event: 'turn_complete',
          phaseNumber: state.currentPhase,
          phaseName:
            state.currentPhase === 2
              ? 'Academic Profile & Improvement Plan'
              : SABCQ_PHASES[state.currentPhase - 1]?.name || 'Active Phase',
          milestoneId: milestone?.id,
          milestoneName: milestone?.name,
          milestonePart: milestone?.part,
          targetDuration: milestone?.targetDuration,
        });
        return;
      }
      this.sendToClient(client, { event: 'turn_complete' });
    }
  }

  /**
   * Legacy WS mic uplink. Skipped while LiveKit bridge is active (Phase 3a).
   */
  @SubscribeMessage('audio_input')
  handleAudioInput(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { pcmBase64: string },
  ) {
    if (this.clientLivekitUplink.get(client)) return;
    this.forwardMicPcmToGemini(client, data?.pcmBase64);
  }

  /**
   * Phase 3a: browser joined LiveKit + published mic → Nest bridge subscribes → Gemini.
   */
  @SubscribeMessage('livekit_bridge_start')
  async handleLivekitBridgeStart(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { roomName?: string },
  ) {
    const roomName = (data?.roomName || '').trim();
    if (!roomName) {
      this.sendToClient(client, {
        event: 'livekit_bridge_status',
        active: false,
        reason: 'missing_room',
      });
      return;
    }

    const ok = await this.livekitBridge.startBridge(client, roomName, (pcmBase64) => {
      this.forwardMicPcmToGemini(client, pcmBase64);
    });

    this.clientLivekitUplink.set(client, ok);
    const flags = livekitFlags();
    const bridgeStatus = this.livekitBridge.getStatus(client);
    this.sendToClient(client, {
      event: 'livekit_bridge_status',
      active: ok,
      roomName,
      mode: ok ? 'livekit' : 'ws_fallback',
      mediaOut: ok && flags.mediaOut,
      wsFallback: flags.wsFallback,
      wsFallbackMs: flags.wsFallbackMs,
      publishedSegments: bridgeStatus.publishedSegments,
    });
    this.logger.log(
      ok
        ? `[Phase3c] LiveKit bridge OK room=${roomName} mediaOut=${flags.mediaOut} wsFallback=${flags.wsFallback}`
        : `[Phase3c] LiveKit bridge failed — WS mic uplink room=${roomName}`,
    );
  }

  @SubscribeMessage('livekit_bridge_stop')
  async handleLivekitBridgeStop(@ConnectedSocket() client: WebSocket) {
    await this.livekitBridge.stopBridge(client);
    this.clientLivekitUplink.set(client, false);
    this.sendToClient(client, {
      event: 'livekit_bridge_status',
      active: false,
      mode: 'ws_fallback',
    });
  }

  /** Shared Gemini mic forward (WS path or LiveKit bridge). Honours scripted-intro mute. */
  private forwardMicPcmToGemini(client: WebSocket, pcmBase64?: string): void {
    if (!pcmBase64) return;
    const state = this.clientCounselingStates.get(client);
    // During scripted intro, mic is for student VAD only — never feed Gemini.
    if (state?.scriptedIntroActive) return;

    const geminiWs = this.clientGeminiSockets.get(client);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      const audioMsg = {
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: 'audio/pcm;rate=16000',
              data: pcmBase64,
            },
          ],
        },
      };
      try {
        geminiWs.send(JSON.stringify(audioMsg));
      } catch (err: any) {
        this.logger.warn(`Failed to forward mic chunk: ${err.message}`);
      }
    }
  }

  /**
   * Typed messages join the SAME live voice session instead of falling back to
   * the HTTP REST endpoint, so the counselor keeps one continuous conversation.
   */
  @SubscribeMessage('text_turn')
  handleTextTurn(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { text?: string } | string,
  ) {
    const text = typeof data === 'string' ? data : data?.text;
    if (!text || !text.trim()) return;

    const geminiWs = this.clientGeminiSockets.get(client);
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
      this.sendToClient(client, {
        event: 'error',
        message: 'Live session is not connected. Start the live session before sending a message.',
      });
      return;
    }

    try {
      geminiWs.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: text.trim() }] }],
            turnComplete: true,
          },
        }),
      );
      this.logger.log(`Forwarded text turn to Gemini live session (${text.trim().length} chars).`);
    } catch (err: any) {
      this.logger.warn(`Failed to forward text turn: ${err.message}`);
    }
  }

  @SubscribeMessage('trigger_first_intro')
  handleTriggerFirstIntro(@ConnectedSocket() client: WebSocket) {
    const state = this.clientCounselingStates.get(client);
    // Server already auto-starts Beat 1 on setupComplete — ignore duplicate frontend trigger.
    if (state && (state.pendingIntroBeat > 0 || state.introBeatCompleted > 0)) {
      this.logger.log('trigger_first_intro ignored (Beat 1 already started/done).');
      return;
    }
    void this.promptGeminiIntroBeat(client, 1);
  }

  /**
   * Frontend VAD: student finished speaking during Phase-1 → next Gemini beat prompt.
   */
  @SubscribeMessage('intro_student_reply')
  handleIntroStudentReply(@ConnectedSocket() client: WebSocket) {
    const state = this.clientCounselingStates.get(client);
    if (!state?.scriptedIntroActive) return;
    if (!state.awaitingStudentReply || state.pendingIntroBeat > 0) {
      this.logger.log(
        `Ignoring intro_student_reply (awaiting=${state.awaitingStudentReply} pendingBeat=${state.pendingIntroBeat})`,
      );
      return;
    }

    if (state.introBeatCompleted === 1) {
      void this.promptGeminiIntroBeat(client, 2);
    } else if (state.introBeatCompleted === 2) {
      void this.promptGeminiIntroBeat(client, 3);
    } else {
      this.logger.log(`intro_student_reply ignored; introBeatCompleted=${state.introBeatCompleted}`);
    }
  }

  /**
   * Disk cache for fixed intro beats (same spoken text → reuse TTS PCM + MuseTalk MP4).
   * First session builds cache; later sessions serve Good morning / assessment / intro instantly.
   */
  private introBeatCachePaths(beatId: IntroBeatId): {
    dir: string;
    pcm: string;
    meta: string;
    mp4: string;
  } {
    const voice = process.env.GEMINI_VOICE_NAME || 'Kore';
    const text = INTRO_BEAT_META[beatId].spokenText;
    const hash = crypto
      .createHash('sha1')
      .update(`${beatId}|${voice}|${text}`)
      .digest('hex')
      .slice(0, 12);
    const dir = path.join(process.cwd(), 'cache', 'intro-beats');
    return {
      dir,
      pcm: path.join(dir, `beat${beatId}_${hash}.pcm`),
      meta: path.join(dir, `beat${beatId}_${hash}.json`),
      mp4: path.join(dir, `beat${beatId}_${hash}.mp4`),
    };
  }

  private loadCachedIntroSpeech(
    beatId: IntroBeatId,
  ): { pcm: Buffer; sampleRate: number; chunkPcms?: Buffer[] } | null {
    const paths = this.introBeatCachePaths(beatId);
    try {
      if (!fs.existsSync(paths.pcm) || !fs.existsSync(paths.meta)) return null;
      const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8')) as {
        sampleRate?: number;
        chunkCount?: number;
      };
      const pcm = fs.readFileSync(paths.pcm);
      if (pcm.length < 1000) return null;
      const sampleRate = meta.sampleRate || 24000;
      const chunkPcms: Buffer[] = [];
      const n = meta.chunkCount || 0;
      for (let i = 0; i < n; i++) {
        const chunkPath = paths.pcm.replace(/\.pcm$/, `_c${i}.pcm`);
        if (!fs.existsSync(chunkPath)) {
          return { pcm, sampleRate };
        }
        chunkPcms.push(fs.readFileSync(chunkPath));
      }
      if (chunkPcms.length > 1) {
        return { pcm, sampleRate, chunkPcms };
      }
      return { pcm, sampleRate };
    } catch {
      return null;
    }
  }

  private saveCachedIntroSpeech(
    beatId: IntroBeatId,
    pcm: Buffer,
    sampleRate: number,
    chunkPcms?: Buffer[],
  ): void {
    const paths = this.introBeatCachePaths(beatId);
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.pcm, pcm);
      fs.writeFileSync(
        paths.meta,
        JSON.stringify({
          sampleRate,
          beatId,
          savedAt: Date.now(),
          chunkCount: chunkPcms?.length || 0,
        }),
      );
      if (chunkPcms?.length) {
        chunkPcms.forEach((c, i) => {
          fs.writeFileSync(paths.pcm.replace(/\.pcm$/, `_c${i}.pcm`), c);
        });
      }
    } catch (err: any) {
      this.logger.warn(`Intro PCM cache save failed: ${err.message}`);
    }
  }

  private loadCachedIntroVideo(beatId: IntroBeatId): Buffer | null {
    const paths = this.introBeatCachePaths(beatId);
    try {
      if (!fs.existsSync(paths.mp4)) return null;
      const buf = fs.readFileSync(paths.mp4);
      return buf.length > 1000 ? buf : null;
    } catch {
      return null;
    }
  }

  private saveCachedIntroVideo(beatId: IntroBeatId, video: Buffer): void {
    const paths = this.introBeatCachePaths(beatId);
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.mp4, video);
      this.logger.log(`Cached intro MuseTalk MP4 for Beat ${beatId} (${video.length} bytes).`);
    } catch (err: any) {
      this.logger.warn(`Intro MP4 cache save failed: ${err.message}`);
    }
  }

  /**
   * Exact Gemini speech (Kore) for one intro beat → MuseTalk lip-sync → screen.
   * Beat 1 auto on session start; Beat 2/3 after student VAD via intro_student_reply.
   * Does NOT use Live native-audio (that invents openers).
   */
  private async promptGeminiIntroBeat(client: WebSocket, beatId: IntroBeatId): Promise<void> {
    const state = this.clientCounselingStates.get(client);
    if (!state) return;

    if (state.pendingIntroBeat > 0) {
      this.logger.warn(`Intro Beat ${beatId} skipped — Beat ${state.pendingIntroBeat} still in flight.`);
      return;
    }

    const meta = INTRO_BEAT_META[beatId];
    state.pendingIntroBeat = beatId;
    state.awaitingStudentReply = false;
    state.wasInterrupted = false;
    this.clientTurnPcm.set(client, []);

    this.sendToClient(client, {
      event: 'intro_beat_started',
      introBeat: beatId,
      message: `Gemini exact speech beat ${beatId}…`,
    });
    this.sendToClient(client, { event: 'turn_rendering', introBeat: beatId });

    try {
      this.logger.log(
        `Intro Beat ${beatId}: "${meta.spokenText.slice(0, 70)}${meta.spokenText.length > 70 ? '…' : ''}"`,
      );

      // Load / generate exact Gemini speech FIRST (source of truth for lips + words).
      // Free-tier: cache-first; Beat 3 defaults to ONE Flash TTS call (not 5× RPM).
      // MuseTalk still gets short jobs via LIPSYNC_MODE=stream slices on the full PCM.
      let pcm: Buffer;
      let sampleRate: number;
      let chunkPcms: Buffer[] | null = null;
      const cachedSpeech = this.loadCachedIntroSpeech(beatId);
      const textChunks = meta.speechChunks?.filter((c) => c.trim().length > 0) || null;
      const ttsMode = (process.env.INTRO_TTS_MODE || 'single').trim().toLowerCase();

      if (cachedSpeech) {
        pcm = cachedSpeech.pcm;
        sampleRate = cachedSpeech.sampleRate;
        chunkPcms =
          cachedSpeech.chunkPcms && cachedSpeech.chunkPcms.length > 1
            ? cachedSpeech.chunkPcms
            : null;
        this.logger.log(
          `Intro Beat ${beatId}: reusing cached Gemini PCM (${pcm.length} bytes` +
            `${chunkPcms ? `, ${chunkPcms.length} muse chunks` : ''}).`,
        );
      } else if (ttsMode === 'chunks' && textChunks && textChunks.length > 1) {
        // Optional: multi-TTS with INTRO_TTS_CHUNK_GAP_MS (~65s) for free-tier RPM.
        const speech = await this.counselorService.generateGeminiExactSpeechPcmChunks(
          textChunks,
          0.45,
        );
        pcm = speech.pcm;
        sampleRate = speech.sampleRate;
        chunkPcms = speech.chunkPcms;
        this.saveCachedIntroSpeech(beatId, pcm, sampleRate, chunkPcms);
        this.logger.log(
          `Intro Beat ${beatId}: calm TTS in ${chunkPcms.length} spaced chunks (${pcm.length} bytes).`,
        );
      } else {
        // DEFAULT (free-tier safe): one TTS request for the full spoken line.
        this.logger.log(
          `Intro Beat ${beatId}: single Flash TTS call (INTRO_TTS_MODE=${ttsMode || 'single'})…`,
        );
        const speech = await this.counselorService.generateGeminiExactSpeechPcm(meta.spokenText);
        pcm = speech.pcm;
        sampleRate = speech.sampleRate;
        this.saveCachedIntroSpeech(beatId, pcm, sampleRate);
      }

      const pcmBase64 = pcm.toString('base64');
      const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();
      let servedVideo = false;

      /**
       * Beat 3 (sir demo): ONE MuseTalk call on FULL PCM → ONE MP4 (no slice/concat).
       * Beat 1–2: cache or short one-shot. Never progressive WS clips for intro.
       */
      const beat3OneShot = beatId === 3;

      if (!beat3OneShot) {
        this.sendToClient(client, {
          event: 'audio_chunk',
          data: pcmBase64,
          mimeType: `audio/pcm;rate=${sampleRate}`,
        });
      }

      if (avatarUrl && this.lipSyncStream.isAvatarReachable()) {
        const cachedVideo = this.loadCachedIntroVideo(beatId);
        if (cachedVideo && (await mp4MatchesPcmDuration(cachedVideo, pcm, sampleRate))) {
          this.logger.log(`Intro Beat ${beatId}: cached full MP4 (one-shot play).`);
          this.emitTurnVideoReady(client, {
            videoBase64: cachedVideo.toString('base64'),
            mimeType: 'video/mp4',
            introBeat: beatId,
            cached: true,
          });
          servedVideo = true;
        } else if (beat3OneShot) {
          /**
           * Browser always gets ONE continuous MP4 (Beat 1–2 feel).
           * Free Colab + Cloudflare kill a single ~50s MuseTalk job in ~1.5–3 min →
           * try one-shot briefly, then build the same one MP4 via internal slices+concat
           * (NOT progressive play, NOT audio-only).
           */
          const pcmSec = pcm.length / 2 / sampleRate;
          this.sendToClient(client, {
            event: 'turn_rendering',
            introBeat: beatId,
            message: 'Preparing one continuous lip-sync MP4…',
          });
          const keepAlive = this.startGeminiKeepAlive(client);
          try {
            // Default OFF on free Colab — tunnel kills ~50s one-shot in ~2 min.
            // Set INTRO_BEAT3_ONESHOT=true on RunPod / strong GPU to try true single job.
            const preferOneShot =
              (process.env.INTRO_BEAT3_ONESHOT || 'false').trim().toLowerCase() === 'true';

            let videoBuf: Buffer | null = null;
            if (preferOneShot) {
              this.logger.log(
                `Intro Beat 3: try ONE-SHOT MuseTalk (~${pcmSec.toFixed(1)}s PCM)…`,
              );
              this.sendToClient(client, {
                event: 'turn_rendering',
                introBeat: beatId,
                message: 'Trying single MuseTalk job on full audio…',
              });
              videoBuf = await this.renderIntroBeatOneShotMp4(
                client,
                avatarUrl,
                pcm,
                sampleRate,
                beatId,
              );
              if (videoBuf) {
                this.logger.log(`Intro Beat 3: one-shot OK (${videoBuf.length}B)`);
              } else {
                this.logger.warn(
                  'Intro Beat 3: one-shot failed (Colab/tunnel) — building ONE MP4 via internal slices+concat',
                );
              }
            }

            if (!videoBuf || videoBuf.length < 1000) {
              this.sendToClient(client, {
                event: 'turn_rendering',
                introBeat: beatId,
                message:
                  'Building one continuous MP4 (Colab cannot finish single long job)…',
              });
              const parts = await this.lipSyncStream.renderAllSlicesToBuffers(
                pcm,
                sampleRate,
                (done, total) => {
                  this.sendToClient(client, {
                    event: 'turn_rendering',
                    introBeat: beatId,
                    chunk: done,
                    chunkTotal: total,
                    message: `Building full MP4 ${done}/${total}…`,
                  });
                },
              );
              if (parts.length > 0) {
                const joined = await concatMp4Buffers(parts);
                const locked = joined
                  ? await remuxGeminiPcmIntoMp4(joined, pcm, sampleRate)
                  : null;
                videoBuf = Buffer.from(locked || joined || parts[0]);
                this.logger.log(
                  `Intro Beat 3: continuous MP4 from ${parts.length} internal slices (${videoBuf.length}B)`,
                );
              }
            }

            if (videoBuf && videoBuf.length > 1000) {
              this.saveCachedIntroVideo(beatId, videoBuf);
              this.emitTurnVideoReady(client, {
                videoBase64: videoBuf.toString('base64'),
                mimeType: 'video/mp4',
                introBeat: beatId,
                cached: false,
              });
              servedVideo = true;
            }
          } finally {
            keepAlive.stop();
          }

          if (!servedVideo) {
            this.logger.warn('Intro Beat 3: all MuseTalk paths failed — PCM audio fallback');
            this.sendToClient(client, {
              event: 'audio_chunk',
              data: pcmBase64,
              mimeType: `audio/pcm;rate=${sampleRate}`,
            });
            this.sendToClient(client, {
              event: 'turn_video_failed',
              message:
                'MuseTalk could not build Beat 3 video on Colab. Playing audio only.',
            });
          }
        } else {
          // Short Beat 1–2 without cache: single MuseTalk call (audio is short).
          this.logger.log(`Intro Beat ${beatId}: one-shot MuseTalk (short intro)…`);
          this.sendToClient(client, {
            event: 'turn_rendering',
            introBeat: beatId,
            message: 'Preparing full lip-sync video…',
          });
          const videoBuf = await this.renderAvatarTurnVideo(
            client,
            avatarUrl,
            [pcmBase64],
            sampleRate,
            beatId,
            pcm,
          );
          if (videoBuf) {
            this.saveCachedIntroVideo(beatId, videoBuf);
            servedVideo = true;
          }
        }
      } else if (avatarUrl && !this.lipSyncStream.isAvatarReachable()) {
        this.logger.warn(`Intro Beat ${beatId}: MuseTalk offline — audio only`);
        this.sendToClient(client, {
          event: 'audio_chunk',
          data: pcmBase64,
          mimeType: `audio/pcm;rate=${sampleRate}`,
        });
        this.sendToClient(client, {
          event: 'turn_video_failed',
          message:
            'MuseTalk offline. Playing audio only. Start Colab MuseTalk and paste fresh Cloudflare URL into AVATAR_SERVICE_URL.',
        });
      } else if (beat3OneShot) {
        this.sendToClient(client, {
          event: 'audio_chunk',
          data: pcmBase64,
          mimeType: `audio/pcm;rate=${sampleRate}`,
        });
      }

      // Batch path (LIPSYNC_MODE=batch) or stream disabled
      if (!servedVideo) {
        const cachedVideo = this.loadCachedIntroVideo(beatId);
        if (cachedVideo && (await mp4MatchesPcmDuration(cachedVideo, pcm, sampleRate))) {
          this.logger.log(`Intro Beat ${beatId}: serving validated cached MuseTalk MP4.`);
          this.emitTurnVideoReady(client, {
            videoBase64: cachedVideo.toString('base64'),
            mimeType: 'video/mp4',
            introBeat: beatId,
            cached: true,
          });
          servedVideo = true;
        } else if (cachedVideo) {
          try {
            fs.unlinkSync(this.introBeatCachePaths(beatId).mp4);
          } catch (_) {}
        }
      }

      if (!servedVideo) {
        if (avatarUrl) {
          let videoBuf: Buffer | null = null;
          if (chunkPcms && chunkPcms.length > 1) {
            videoBuf = await this.renderAvatarTurnVideoChunked(
              client,
              avatarUrl,
              chunkPcms,
              sampleRate,
              beatId,
              pcm,
            );
          } else {
            videoBuf = await this.renderAvatarTurnVideo(
              client,
              avatarUrl,
              [pcmBase64],
              sampleRate,
              beatId,
              pcm,
            );
          }
          if (videoBuf) {
            this.saveCachedIntroVideo(beatId, videoBuf);
          }
        } else {
          this.sendToClient(client, {
            event: 'turn_video_failed',
            message: 'AVATAR_SERVICE_URL missing — playing Gemini PCM audio.',
          });
        }
      }

      state.introBeatCompleted = beatId;
      state.totalTurnCount = beatId;
      state.pendingIntroBeat = 0;

      if (beatId >= 3) {
        state.scriptedIntroActive = false;
        state.awaitingStudentReply = false;
        state.currentPhase = 2;
        state.currentMilestoneIndex = 0;
        state.milestoneTurnCount = 0;
        state.milestoneStartedAt = Date.now();
        state.phaseStartedAt = Date.now();
        this.injectPhase2AcademicUnlock(client);
        this.logger.log('Phase-1 exact Gemini intro done. Phase 2 Live unlocked.');
      } else {
        state.awaitingStudentReply = true;
      }

      this.sendToClient(client, {
        event: 'turn_complete',
        phaseNumber: state.currentPhase,
        phaseName:
          state.currentPhase === 2
            ? 'Academic Profile & Improvement Plan'
            : SABCQ_PHASES[0].name,
        milestoneId: `INTRO_BEAT_${beatId}`,
        milestoneName: meta.label,
        milestonePart: 'Intro',
        targetDuration: meta.targetDuration,
        introBeat: beatId,
        scriptedIntro: true,
        awaitingStudentReply: state.awaitingStudentReply,
      });
    } catch (err: any) {
      state.pendingIntroBeat = 0;
      this.logger.error(`Exact Gemini intro Beat ${beatId} failed: ${err.message}`);
      this.sendToClient(client, {
        event: 'error',
        message: `Intro Beat ${beatId} failed: ${err.message}`,
      });
      this.sendToClient(client, {
        event: 'turn_video_failed',
        message: err.message || 'Intro beat failed',
      });
    }
  }

  /** Push Phase-2 protocol into Live context without forcing an immediate spoken turn. */
  private injectPhase2AcademicUnlock(client: WebSocket): void {
    const geminiWs = this.clientGeminiSockets.get(client);
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;

    const unlock = buildPhase2UnlockInstruction(DUMMY_STUDENT_REPORT, 'hinglish');
    try {
      geminiWs.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text:
                      unlock +
                      '\n\nSYSTEM: Do not speak this update aloud. Wait for the student\'s next utterance, then begin Phase 2 briefly.',
                  },
                ],
              },
            ],
            // false = add to context only; avoid an extra counselor turn that breaks beat counting
            turnComplete: false,
          },
        }),
      );
      this.logger.log('Injected Phase 2 academic unlock into Gemini Live session (silent).');
    } catch (err: any) {
      this.logger.warn(`Failed to inject Phase 2 unlock: ${err.message}`);
    }
  }

  @SubscribeMessage('interrupt')
  handleInterrupt(@ConnectedSocket() client: WebSocket) {
    this.clientTurnPcm.set(client, []);
    this.cancelAvatarRender(client);
    this.lipSyncStream.abort(client);
    this.livekitBridge.interruptCounselorMedia(client);
    const state = this.clientCounselingStates.get(client);
    if (state) {
      state.wasInterrupted = true;
    }
    const geminiWs = this.clientGeminiSockets.get(client);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      const interruptMsg = { realtimeInput: { audioStreamEnd: true } };
      try {
        geminiWs.send(JSON.stringify(interruptMsg));
        this.logger.log('Forwarded barge-in (audioStreamEnd) to Gemini live session.');
      } catch (err: any) {
        this.logger.warn(`Failed to forward interrupt: ${err.message}`);
      }
    }
  }

  /** Per-chunk MP4 path — Phase 1.5: 2nd run skips GPU for already-rendered parts. */
  private introChunkVideoPath(beatId: IntroBeatId, chunkIndex: number, chunkPcm: Buffer): string {
    const paths = this.introBeatCachePaths(beatId);
    const pcmHash = crypto.createHash('sha1').update(chunkPcm).digest('hex').slice(0, 10);
    return paths.pcm.replace(/\.pcm$/, `_vid_c${chunkIndex}_${pcmHash}.mp4`);
  }

  private loadCachedChunkVideo(
    beatId: IntroBeatId,
    chunkIndex: number,
    chunkPcm: Buffer,
    sampleRate: number,
  ): Buffer | null {
    const p = this.introChunkVideoPath(beatId, chunkIndex, chunkPcm);
    try {
      if (!fs.existsSync(p)) return null;
      const buf = fs.readFileSync(p);
      if (buf.length < 1000) return null;
      // Duration check is async elsewhere; quick size heuristic vs pcm length
      const pcmSec = chunkPcm.length / 2 / sampleRate;
      // ~30–80 KB/s for our remuxed talking heads — reject tiny stubs
      if (buf.length < Math.max(8000, pcmSec * 8000)) return null;
      return buf;
    } catch {
      return null;
    }
  }

  private saveCachedChunkVideo(
    beatId: IntroBeatId,
    chunkIndex: number,
    chunkPcm: Buffer,
    video: Buffer,
  ): void {
    try {
      const p = this.introChunkVideoPath(beatId, chunkIndex, chunkPcm);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, video);
      this.logger.log(`Cached intro chunk video beat=${beatId} c${chunkIndex} (${video.length}B)`);
    } catch (err: any) {
      this.logger.warn(`Chunk video cache save failed: ${err.message}`);
    }
  }

  /**
   * Keep Gemini Live WS from closing with 1008 inactivity while MuseTalk runs (many minutes on T4).
   * Sends tiny silent PCM as realtimeInput every ~20s.
   */
  private startGeminiKeepAlive(client: WebSocket): { stop: () => void } {
    const silence16k = Buffer.alloc(3200); // 100ms @ 16kHz mono s16le
    const b64 = silence16k.toString('base64');
    const timer = setInterval(() => {
      const geminiWs = this.clientGeminiSockets.get(client);
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      try {
        geminiWs.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: b64,
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          }),
        );
      } catch (err: any) {
        this.logger.warn(`Gemini keepalive send failed: ${err?.message || err}`);
      }
    }, 20000);
    this.logger.log('Gemini keepalive started (Beat 3 MuseTalk wait)');
    return {
      stop: () => {
        clearInterval(timer);
        this.logger.log('Gemini keepalive stopped');
      },
    };
  }

  /**
   * Beat 3: single MuseTalk job on the FULL intro PCM (no slice/concat).
   * Long timeout for free Colab T4 (~45–50s speech can take many minutes).
   */
  private async renderIntroBeatOneShotMp4(
    client: WebSocket,
    avatarServiceUrl: string,
    pcm: Buffer,
    sampleRate: number,
    beatId: IntroBeatId,
  ): Promise<Buffer | null> {
    this.cancelAvatarRender(client);
    const renderId = this.clientAvatarRenderId.get(client) || 0;
    const controller = new AbortController();
    this.clientAvatarAbort.set(client, controller);
    // Cloudflare quick tunnels often die ~100–180s on long posts — fail fast into slice+concat.
    const oneShotMs = Math.min(
      900000,
      Math.max(90000, parseInt(process.env.INTRO_BEAT3_ONESHOT_MS || '120000', 10) || 120000),
    );
    const timeout = setTimeout(() => controller.abort(), oneShotMs);
    this.logger.log(`Beat ${beatId} one-shot abort after ${Math.round(oneShotMs / 1000)}s`);
    try {
      const videoBuffer = await this.fetchMuseTalkRemuxedMp4(
        avatarServiceUrl,
        pcm,
        sampleRate,
        `beat${beatId}_oneshot_${renderId}`,
        beatId,
        controller.signal,
      );
      if (this.clientAvatarRenderId.get(client) !== renderId) return null;
      return videoBuffer;
    } catch (err: any) {
      this.logger.warn(
        `Beat ${beatId} one-shot MuseTalk failed: ${err?.message || err}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
      if (this.clientAvatarAbort.get(client) === controller) {
        this.clientAvatarAbort.delete(client);
      }
    }
  }

  /**
   * Low-level MuseTalk fetch + Gemini-audio remux. Does not emit client events.
   * Short clips preferred on free Cloudflare tunnels; Beat 3 one-shot uses long timeout intentionally.
   */
  private async fetchMuseTalkRemuxedMp4(
    avatarServiceUrl: string,
    pcm: Buffer,
    sampleRate: number,
    requestId: string,
    beatId: IntroBeatId | undefined,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const cleanUrl = avatarServiceUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/api/generate_from_pcm`;
    const pcmDur = pcm.length / 2 / sampleRate;
    this.logger.log(
      `MuseTalk request id=${requestId} pcm=${pcm.length}B (~${pcmDur.toFixed(1)}s)` +
        `${beatId ? ` beat=${beatId}` : ''}`,
    );

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pcm_base64: pcm.toString('base64'),
        sample_rate: sampleRate,
        avatar_id: 'avator_1',
        request_id: requestId,
        beat_id: beatId ?? null,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText || '<none>'}`);
    }

    const videoBuffer = Buffer.from(await response.arrayBuffer());
    if (videoBuffer.length < 1000) {
      throw new Error('MuseTalk returned empty/invalid video');
    }

    const remuxed = await remuxGeminiPcmIntoMp4(videoBuffer, pcm, sampleRate);
    if (!remuxed) {
      throw new Error('MuseTalk video did not match Gemini speech after remux');
    }
    return Buffer.from(remuxed);
  }

  /** One chunk with 100s timeout + 1 retry (Phase 1.5 anti-574). */
  private async fetchMuseTalkChunkWithRetry(
    avatarServiceUrl: string,
    pcm: Buffer,
    sampleRate: number,
    requestId: string,
    beatId: IntroBeatId,
    parentSignal: AbortSignal,
  ): Promise<Buffer> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (parentSignal.aborted) throw new Error('Aborted');
      const chunkController = new AbortController();
      const timer = setTimeout(() => chunkController.abort(), 100000);
      const onParentAbort = () => chunkController.abort();
      parentSignal.addEventListener('abort', onParentAbort);
      try {
        const buf = await this.fetchMuseTalkRemuxedMp4(
          avatarServiceUrl,
          pcm,
          sampleRate,
          `${requestId}_a${attempt}`,
          beatId,
          chunkController.signal,
        );
        return buf;
      } catch (err: any) {
        lastErr = err instanceof Error ? err : new Error(String(err?.message || err));
        this.logger.warn(
          `MuseTalk chunk attempt ${attempt}/2 failed (${requestId}): ${lastErr.message}`,
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
    throw lastErr || new Error('MuseTalk chunk failed');
  }

  /**
   * Beat 3: per-chunk MuseTalk + disk cache + concat.
   * 2nd run: cached chunk MP4s → near-instant join (Phase 1.5).
   */
  private async renderAvatarTurnVideoChunked(
    client: WebSocket,
    avatarServiceUrl: string,
    chunkPcms: Buffer[],
    sampleRate: number,
    beatId: IntroBeatId,
    fullPcm: Buffer,
  ): Promise<Buffer | null> {
    this.cancelAvatarRender(client);
    const renderId = this.clientAvatarRenderId.get(client) || 0;
    const controller = new AbortController();
    this.clientAvatarAbort.set(client, controller);

    const fail = (message: string) => {
      if (this.clientAvatarRenderId.get(client) !== renderId) return;
      this.clientAvatarAbort.delete(client);
      this.logger.warn(`MuseTalk chunked render failed: ${message}`);
      this.sendToClient(client, { event: 'turn_video_failed', message });
    };

    try {
      this.sendToClient(client, {
        event: 'turn_rendering',
        introBeat: beatId,
        message: `Rendering lip-sync in ${chunkPcms.length} parts…`,
      });

      const overallMs = Math.max(240000, chunkPcms.length * 120000);
      const overallTimer = setTimeout(() => controller.abort(), overallMs);

      const partVideos: Buffer[] = [];
      try {
        for (let i = 0; i < chunkPcms.length; i++) {
          if (this.clientAvatarRenderId.get(client) !== renderId) return null;

          this.sendToClient(client, {
            event: 'turn_rendering',
            introBeat: beatId,
            chunk: i + 1,
            chunkTotal: chunkPcms.length,
          });

          const cachedPart = this.loadCachedChunkVideo(beatId, i, chunkPcms[i], sampleRate);
          if (cachedPart && (await mp4MatchesPcmDuration(cachedPart, chunkPcms[i], sampleRate))) {
            this.logger.log(
              `MuseTalk chunk ${i + 1}/${chunkPcms.length} CACHE HIT (skip GPU)`,
            );
            partVideos.push(cachedPart);
            continue;
          }

          this.logger.log(`MuseTalk chunk ${i + 1}/${chunkPcms.length} for Beat ${beatId} (GPU)…`);
          const part = await this.fetchMuseTalkChunkWithRetry(
            avatarServiceUrl,
            chunkPcms[i],
            sampleRate,
            `b${beatId}_c${i}_${renderId}`,
            beatId,
            controller.signal,
          );
          this.saveCachedChunkVideo(beatId, i, chunkPcms[i], part);
          partVideos.push(part);
        }
      } finally {
        clearTimeout(overallTimer);
      }

      const joined = await concatMp4Buffers(partVideos);
      if (!joined) {
        fail('Failed to join MuseTalk chunk videos');
        return null;
      }

      const locked = await remuxGeminiPcmIntoMp4(joined, fullPcm, sampleRate);
      const videoBuffer = Buffer.from(locked || joined);

      if (this.clientAvatarRenderId.get(client) !== renderId) return null;
      this.clientAvatarAbort.delete(client);
      this.logger.log(
        `MuseTalk chunked Beat ${beatId} ready (${videoBuffer.length} bytes, ${chunkPcms.length} parts).`,
      );
      this.emitTurnVideoReady(client, {
        videoBase64: videoBuffer.toString('base64'),
        mimeType: 'video/mp4',
        introBeat: beatId,
      });
      return videoBuffer;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (this.clientAvatarRenderId.get(client) === renderId) {
          this.clientAvatarAbort.delete(client);
          fail('MuseTalk chunked render aborted or timed out');
        }
        return null;
      }
      fail(err?.message || 'Unknown MuseTalk chunked error');
      return null;
    }
  }

  /**
   * Sends turn PCM audio to Cloud GPU MuseTalk server to render lip-synced video.
   * On failure emits `turn_video_failed` so the browser can play buffered Gemini PCM.
   * Returns the MP4 buffer when successful (for intro-beat disk cache).
   */
  private async renderAvatarTurnVideo(
    client: WebSocket,
    avatarServiceUrl: string,
    pcmChunks: string[],
    sampleRate = 24000,
    beatId?: IntroBeatId,
    pcmRaw?: Buffer,
  ): Promise<Buffer | null> {
    this.cancelAvatarRender(client);
    const renderId = this.clientAvatarRenderId.get(client) || 0;

    const controller = new AbortController();
    this.clientAvatarAbort.set(client, controller);

    const fail = (message: string) => {
      if (this.clientAvatarRenderId.get(client) !== renderId) return;
      this.clientAvatarAbort.delete(client);
      this.logger.warn(`MuseTalk render failed: ${message}`);
      this.sendToClient(client, { event: 'turn_video_failed', message });
    };

    try {
      this.sendToClient(client, { event: 'turn_rendering', introBeat: beatId });

      const buffers = pcmChunks.map((chunk) => Buffer.from(chunk, 'base64'));
      const combinedBuffer = pcmRaw && pcmRaw.length > 0 ? pcmRaw : Buffer.concat(buffers);

      // Per-request limit: keep under Cloudflare tunnel patience (~100s). Short intros only.
      const timeout = setTimeout(() => controller.abort(), 150000);
      const videoBuffer = await this.fetchMuseTalkRemuxedMp4(
        avatarServiceUrl,
        combinedBuffer,
        sampleRate,
        `turn_${renderId}_${Date.now()}`,
        beatId,
        controller.signal,
      );
      clearTimeout(timeout);

      if (this.clientAvatarRenderId.get(client) !== renderId) {
        this.logger.log(`Ignoring stale MuseTalk response for renderId=${renderId}`);
        return null;
      }

      this.clientAvatarAbort.delete(client);
      this.logger.log(`MuseTalk video remuxed OK (${videoBuffer.length} bytes). Sending to client...`);

      this.emitTurnVideoReady(client, {
        videoBase64: videoBuffer.toString('base64'),
        mimeType: 'video/mp4',
        introBeat: beatId,
      });
      return videoBuffer;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (this.clientAvatarRenderId.get(client) === renderId) {
          this.clientAvatarAbort.delete(client);
          fail('MuseTalk render aborted or timed out');
        }
        return null;
      }
      fail(err?.message || 'Unknown MuseTalk error');
      return null;
    }
  }

  /** Ask Colab MuseTalk to preload models into GPU (Phase 1.5 — confirm warm_mode). */
  private async warmupAvatarService(client?: WebSocket): Promise<void> {
    const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();
    if (!avatarUrl) return;

    const base = avatarUrl.replace(/\/$/, '');
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);
        const res = await fetch(`${base}/api/warmup`, {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const data: any = await res.json().catch(() => ({}));
        const warmMode = data?.warm_mode || data?.mode || '?';
        const warmReady = warmMode === 'warm' || data?.ok === true;
        this.logger.log(
          `MuseTalk warmup attempt ${attempt}: ok=${res.ok} warm_mode=${warmMode} version=${data?.version || '?'}`,
        );
        if (client) {
          this.sendToClient(client, {
            event: 'avatar_status',
            connected: res.ok,
            warmMode,
            warmReady,
            gpuName: data?.gpu_name,
            avatarCached: data?.avatar_cached,
            bboxShift: data?.bbox_shift,
            avatarServiceUrl: avatarUrl,
            version: data?.version,
            message: warmReady
              ? 'MuseTalk warm engine ready (Phase 1.5)'
              : `MuseTalk mode=${warmMode} (subprocess fallback possible)`,
          });
        }
        if (warmReady || res.ok) {
          this.lipSyncStream.markAvatarOnline();
          return;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (err: any) {
        lastErr = err.message;
        this.logger.warn(`MuseTalk warmup attempt ${attempt} failed: ${err.message}`);
      }
    }
    // Tunnel/Colab down — do not spam 40× fetch failed; use audio-only until URL is fixed.
    this.lipSyncStream.markAvatarOffline(lastErr || 'warmup failed', 180_000);
    if (client) {
      this.sendToClient(client, {
        event: 'avatar_status',
        connected: false,
        warmReady: false,
        warmMode: 'failed',
        message: `MuseTalk OFFLINE: ${lastErr}. Restart Colab + update AVATAR_SERVICE_URL. Audio-only until then.`,
        avatarServiceUrl: avatarUrl,
      });
    }
  }

  @SubscribeMessage('get_avatar_status')
  async handleGetAvatarStatus(@ConnectedSocket() client: WebSocket) {
    const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();
    if (!avatarUrl) {
      this.sendToClient(client, {
        event: 'avatar_status',
        connected: false,
        message: 'AVATAR_SERVICE_URL not configured. Using local fallback.',
      });
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${avatarUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data: any = await res.json();
      const warmMode = data.warm_mode || data.mode || 'unknown';
      this.sendToClient(client, {
        event: 'avatar_status',
        connected: res.ok,
        gpuName: data.gpu_name || 'Cloud GPU',
        avatarCached: data.avatar_cached || false,
        warmMode,
        warmReady: warmMode === 'warm',
        bboxShift: data.bbox_shift,
        version: data.version,
        avatarServiceUrl: avatarUrl,
        message:
          warmMode === 'warm'
            ? 'MuseTalk warm engine confirmed'
            : `MuseTalk warm_mode=${warmMode}`,
      });
    } catch (err: any) {
      this.sendToClient(client, {
        event: 'avatar_status',
        connected: false,
        message: `Cloud Avatar unreachable: ${err.message}`,
        avatarServiceUrl: avatarUrl,
      });
    }
  }
}
