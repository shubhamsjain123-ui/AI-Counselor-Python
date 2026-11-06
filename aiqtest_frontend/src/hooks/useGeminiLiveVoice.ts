'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AI_COUNSELOR_WS_URL } from '@/lib/backend';

interface GatewayEvent {
  event: string;
  data?: string;
  text?: string;
  message?: string;
  mimeType?: string;
  avatarServiceUrl?: string;
  videoBase64?: string;
  audioBase64?: string;
  phaseNumber?: number;
  phaseName?: string;
  milestoneId?: string;
  milestoneName?: string;
  milestonePart?: string;
  targetDuration?: string;
  introBeat?: number;
  scriptedIntro?: boolean;
  awaitingStudentReply?: boolean;
  chunk?: number;
  chunkTotal?: number;
  cached?: boolean;
  connected?: boolean;
  warmMode?: string;
  warmReady?: boolean;
  version?: string;
  bboxShift?: number;
  gpuName?: string;
  avatarCached?: boolean;
  lipsyncMode?: string;
  sliceSec?: number;
  seq?: number;
  durationHintSec?: number;
  streamMode?: boolean;
  active?: boolean;
  roomName?: string;
  mode?: string;
  reason?: string;
  mediaOut?: boolean;
  livekitMedia?: boolean;
  wsFallback?: boolean;
  wsFallbackMs?: number;
  publishedSegments?: number;
  segmentsEmitted?: number;
}

export interface PhaseInfo {
  phaseNumber: number;
  phaseName: string;
  milestoneId?: string;
  milestoneName?: string;
  milestonePart?: string;
  targetDuration?: string;
}

export type CounselorState = 'idle' | 'thinking' | 'speaking';

export interface UseGeminiLiveVoiceOptions {
  wsUrl?: string;
  onTextChunk?: (text: string) => void;
  onAudioChunk?: (pcmBase64: string, mimeType: string) => void;
  onStateChange?: (state: CounselorState) => void;
  onError?: (errMessage: string) => void;
  onConnected?: () => void;
  onTurnVideoReady?: (videoBlobUrl: string) => void;
  /** Full MuseTalk render in progress (e.g. Beat 3) — show listening, no progressive clips */
  onTurnRendering?: (info?: { introBeat?: number; chunk?: number; chunkTotal?: number }) => void;
  /** Phase 2: short MuseTalk clip as Gemini speaks */
  onStreamVideoSegment?: (payload: {
    seq: number;
    videoBase64: string;
    mimeType: string;
    durationHintSec?: number;
  }) => void;
  onStreamStarted?: () => void;
  onStreamFlushed?: () => void;
  /** Phase 3b: Nest bridge will publish counselor A/V on LiveKit */
  onLivekitBridgeStatus?: (status: {
    active: boolean;
    mediaOut?: boolean;
    roomName?: string;
    mode?: string;
    wsFallback?: boolean;
    wsFallbackMs?: number;
  }) => void;
}

const DEFAULT_WS_URL = AI_COUNSELOR_WS_URL;

/** Prevent React StrictMode double-mount from opening two counselor sessions. */
let sharedLiveCounselorWs: WebSocket | null = null;

export function useGeminiLiveVoice(options: UseGeminiLiveVoiceOptions = {}) {
  // The caller passes a fresh object literal on every render. Keeping it in a ref
  // stops that from invalidating every useCallback below, which previously made
  // the unmount cleanup effect re-run on each render and tear down the live
  // WebSocket + microphone as soon as they were started.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const wsUrl = options.wsUrl || DEFAULT_WS_URL;

  const [isLiveWsConnected, setIsLiveWsConnected] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const isUserSpeakingRef = useRef(false);
  const userSpeechFramesRef = useRef(0);
  const bargeInFramesRef = useRef(0);
  const userSilenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const [counselorState, setCounselorState] = useState<CounselorState>('idle');
  const counselorStateRef = useRef<CounselorState>('idle');
  const [currentPhaseInfo, setCurrentPhaseInfo] = useState<PhaseInfo>({
    phaseNumber: 1,
    phaseName: 'Introduction & Counseling Setup',
    milestoneName: 'Welcome & Introduction',
  });
  const [avatarServiceUrl, setAvatarServiceUrl] = useState<string>('');
  const avatarServiceUrlRef = useRef<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  // Pending `start_live_session` frames that must wait for the socket to open.
  const queuedFramesRef = useRef<string[]>([]);

  const audioQueueRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);

  const idleDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compressorNodeRef = useRef<DynamicsCompressorNode | null>(null);
  const chunkCountRef = useRef<number>(0);
  const pendingPhaseInfoRef = useRef<PhaseInfo | null>(null);

  // MuseTalk batch path: buffer Gemini PCM until lip-sync MP4 is ready (or fail → play PCM).
  const pendingPcmChunksRef = useRef<{ data: string; mimeType: string }[]>([]);
  const awaitingTurnVideoRef = useRef(false);
  const turnVideoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const avatarVideoPlayingRef = useRef(false);
  // Beat 3 is rendered as 3 MuseTalk chunks (~3–5 min total on free Colab T4).
  // Beat 3 full MuseTalk on Colab T4 can take ~5–10+ min — do not flush PCM early.
  const TURN_VIDEO_TIMEOUT_MS = 900000;
  // After mic opens, suppress uplink for a short window (echo / room noise → Gemini "interrupted").
  const micUplinkWarmupUntilRef = useRef(0);
  const suppressBargeInUntilRef = useRef(0);
  // Phase 3a: false while LiveKit bridge owns Gemini uplink (WS audio_input skipped).
  const geminiUplinkEnabledRef = useRef(true);
  // false when VAD reuses LiveKit MediaStream (don't stop tracks — LiveKit owns them).
  const ownsMicTracksRef = useRef(true);
  // Phase-1 scripted TTS+MuseTalk: Gemini does not hear/speak until intro done.
  const scriptedIntroActiveRef = useRef(true);
  const awaitingStudentReplyRef = useRef(false);
  const lipsyncModeRef = useRef<'stream' | 'batch'>('stream');
  const introReplySentRef = useRef(false);

  const updateState = useCallback((state: CounselorState) => {
    counselorStateRef.current = state;
    if (state === 'speaking') {
      if (idleDebounceTimerRef.current) {
        clearTimeout(idleDebounceTimerRef.current);
        idleDebounceTimerRef.current = null;
      }
      setCounselorState('speaking');
      optionsRef.current.onStateChange?.('speaking');
    } else if (state === 'idle') {
      if (idleDebounceTimerRef.current) return;
      // 400ms Hysteresis Debounce: prevents state flapping to 'idle' during small network packet jitter
      idleDebounceTimerRef.current = setTimeout(() => {
        idleDebounceTimerRef.current = null;
        if (audioQueueRef.current.length === 0) {
          counselorStateRef.current = 'idle';
          setCounselorState('idle');
          optionsRef.current.onStateChange?.('idle');
        }
      }, 400);
    } else {
      setCounselorState(state);
      optionsRef.current.onStateChange?.(state);
    }
  }, []);

  const raiseError = useCallback((message: string) => {
    console.warn('[Gemini Live]', message);
    setIsFallbackMode(true);
    optionsRef.current.onError?.(message);
  }, []);

  const safeSend = useCallback((payload: unknown): boolean => {
    const socket = wsRef.current;
    const frame = JSON.stringify(payload);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
      return true;
    }
    // Buffer instead of dropping - the socket may still be handshaking.
    if (queuedFramesRef.current.length < 50) {
      queuedFramesRef.current.push(frame);
    }
    return false;
  }, []);

  const clearTurnVideoWait = useCallback(() => {
    awaitingTurnVideoRef.current = false;
    if (turnVideoTimeoutRef.current) {
      clearTimeout(turnVideoTimeoutRef.current);
      turnVideoTimeoutRef.current = null;
    }
  }, []);

  // Stable refs avoid TDZ / circular useCallback deps between PCM play and MuseTalk fallback.
  const playPcm24kChunkRef = useRef<
    ((base64Data: string, mimeType?: string) => void) | null
  >(null);
  const flushPendingPcmPlaybackRef = useRef<() => void>(() => {});

  const flushPendingPcmPlayback = useCallback(() => {
    const chunks = pendingPcmChunksRef.current;
    pendingPcmChunksRef.current = [];
    clearTurnVideoWait();
    if (chunks.length === 0) {
      // Already speaking via earlier PCM fallback or video — do not yank state to idle.
      if (
        counselorStateRef.current === 'speaking' ||
        avatarVideoPlayingRef.current ||
        audioQueueRef.current.length > 0
      ) {
        return;
      }
      counselorStateRef.current = 'idle';
      setCounselorState('idle');
      optionsRef.current.onStateChange?.('idle');
      return;
    }
    console.log(
      `[Avatar] MuseTalk video unavailable — playing ${chunks.length} buffered Gemini PCM chunks as audio fallback.`,
    );
    for (const chunk of chunks) {
      playPcm24kChunkRef.current?.(chunk.data, chunk.mimeType);
    }
  }, [clearTurnVideoWait]);

  useEffect(() => {
    flushPendingPcmPlaybackRef.current = flushPendingPcmPlayback;
  }, [flushPendingPcmPlayback]);

  // Stop current audio playback queue (Barge-in Interruption & Session End)
  const stopAudioPlayback = useCallback(() => {
    if (idleDebounceTimerRef.current) {
      clearTimeout(idleDebounceTimerRef.current);
      idleDebounceTimerRef.current = null;
    }
    clearTurnVideoWait();
    pendingPcmChunksRef.current = [];
    avatarVideoPlayingRef.current = false;
    bargeInFramesRef.current = 0;
    const currentQueue = audioQueueRef.current;
    audioQueueRef.current = [];
    nextStartTimeRef.current = 0;
    chunkCountRef.current = 0;

    // Detach onended before stopping to prevent 880x spurious callback loops
    currentQueue.forEach((source) => {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch (_) {}
    });

    counselorStateRef.current = 'idle';
    setCounselorState('idle');
    optionsRef.current.onStateChange?.('idle');
    if (pendingPhaseInfoRef.current) {
      setCurrentPhaseInfo(pendingPhaseInfoRef.current);
      pendingPhaseInfoRef.current = null;
    }
  }, [clearTurnVideoWait]);

  /** Called by avatar UI when MuseTalk MP4 starts/stops — keeps mic echo-shield in sync. */
  const notifyAvatarPlayback = useCallback((active: boolean) => {
    avatarVideoPlayingRef.current = active;
    if (active) {
      clearTurnVideoWait();
      pendingPcmChunksRef.current = [];
      // Block barge-in / uplink briefly while lip-sync video audio fills the room.
      suppressBargeInUntilRef.current = Date.now() + 2500;
      if (idleDebounceTimerRef.current) {
        clearTimeout(idleDebounceTimerRef.current);
        idleDebounceTimerRef.current = null;
      }
      counselorStateRef.current = 'speaking';
      setCounselorState('speaking');
      optionsRef.current.onStateChange?.('speaking');
    } else {
      avatarVideoPlayingRef.current = false;
      // After video ends, keep uplink muted briefly so speaker echo doesn't fake a student turn.
      micUplinkWarmupUntilRef.current = Date.now() + 1800;
      suppressBargeInUntilRef.current = Date.now() + 1800;
      counselorStateRef.current = 'idle';
      setCounselorState('idle');
      optionsRef.current.onStateChange?.('idle');
      if (pendingPhaseInfoRef.current) {
        setCurrentPhaseInfo(pendingPhaseInfoRef.current);
        pendingPhaseInfoRef.current = null;
      }
    }
  }, [clearTurnVideoWait]);

  /** Call when mic is first opened so the first ~2s of noise never reaches Gemini. */
  const armMicUplinkWarmup = useCallback((ms = 2000) => {
    micUplinkWarmupUntilRef.current = Date.now() + ms;
    suppressBargeInUntilRef.current = Date.now() + ms;
  }, []);

  const beginAwaitingTurnVideo = useCallback(() => {
    awaitingTurnVideoRef.current = true;
    updateState('thinking');
    if (turnVideoTimeoutRef.current) {
      clearTimeout(turnVideoTimeoutRef.current);
    }
    turnVideoTimeoutRef.current = setTimeout(() => {
      turnVideoTimeoutRef.current = null;
      if (!awaitingTurnVideoRef.current) return;
      console.warn(
        '[Avatar] MuseTalk render timed out — falling back to Gemini PCM audio.',
      );
      flushPendingPcmPlaybackRef.current();
    }, TURN_VIDEO_TIMEOUT_MS);
  }, [updateState]);

  // Play PCM 24kHz Base64 chunk using Web Audio API with 120ms Jitter Buffer Smoothing
  const playPcm24kChunk = useCallback(
    (base64Data: string, mimeType?: string) => {
      try {
        const sampleRate = /rate=(\d+)/.exec(mimeType || '')?.[1];
        const pcmRate = sampleRate ? parseInt(sampleRate, 10) : 24000;

        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          const AudioContextClass =
            window.AudioContext || (window as any).webkitAudioContext;
          try {
            audioCtxRef.current = new AudioContextClass({ sampleRate: 24000 });
          } catch (_) {
            audioCtxRef.current = new AudioContextClass();
          }
        }

        const audioCtx = audioCtxRef.current;
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }

        // Cancel user silence timer & speech indicator once AI audio starts arriving
        if (userSilenceTimerRef.current) {
          clearTimeout(userSilenceTimerRef.current);
          userSilenceTimerRef.current = null;
        }
        if (isUserSpeakingRef.current) {
          isUserSpeakingRef.current = false;
          setIsUserSpeaking(false);
        }
        userSpeechFramesRef.current = 0;
        bargeInFramesRef.current = 0;

        // Convert Base64 binary string to 16-bit Little-Endian Float32 PCM samples
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const numSamples = Math.floor(len / 2);
        if (numSamples === 0) return;

        const float32Array = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          const low = binaryString.charCodeAt(i * 2);
          const high = binaryString.charCodeAt(i * 2 + 1);
          let sample = (high << 8) | low;
          if (sample & 0x8000) sample |= ~0xffff; // Sign-extend 16-bit negative PCM values
          float32Array[i] = sample / 32768.0;
        }

        const buffer = audioCtx.createBuffer(1, numSamples, pcmRate);
        buffer.getChannelData(0).set(float32Array);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;

        // Anti-Clipping Master Chain: GainNode (0.85) -> DynamicsCompressorNode -> Destination
        // Prevents speaker crackling/buzzing and harsh plosive distortion ("fatti hui awaj")
        if (!gainNodeRef.current || !compressorNodeRef.current) {
          const compressor = audioCtx.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-12, audioCtx.currentTime);
          compressor.knee.setValueAtTime(10, audioCtx.currentTime);
          compressor.ratio.setValueAtTime(4, audioCtx.currentTime);
          compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
          compressor.release.setValueAtTime(0.25, audioCtx.currentTime);
          compressor.connect(audioCtx.destination);
          compressorNodeRef.current = compressor;

          const gain = audioCtx.createGain();
          gain.gain.value = 0.85; // Clean headroom
          gain.connect(compressor);
          gainNodeRef.current = gain;
        }
        source.connect(gainNodeRef.current);

        const currentTime = audioCtx.currentTime;
        let startTime: number;

        // Intelligent Adaptive Jitter Buffer:
        // 1. Fresh turn or drained queue: give 120ms lead-in cushion to buffer incoming bursts
        if (nextStartTimeRef.current === 0 || audioQueueRef.current.length === 0) {
          startTime = currentTime + 0.12;
        } 
        // 2. Continuous playback: chain chunks seamlessly back-to-back with ZERO gap
        else if (nextStartTimeRef.current >= currentTime) {
          startTime = nextStartTimeRef.current;
        } 
        // 3. Packet jitter / small underrun: do NOT inject an artificial 50ms silence hole!
        else {
          const lag = currentTime - nextStartTimeRef.current;
          if (lag < 0.08) {
            // Under 80ms jitter: resume immediately at currentTime with seamless transition
            startTime = currentTime;
          } else {
            // Larger network freeze: minimal 30ms re-anchor cushion
            startTime = currentTime + 0.03;
          }
        }

        source.start(startTime);
        nextStartTimeRef.current = startTime + buffer.duration;
        audioQueueRef.current.push(source);
        chunkCountRef.current += 1;
        updateState('speaking');

        source.onended = () => {
          const index = audioQueueRef.current.indexOf(source);
          if (index > -1) {
            audioQueueRef.current.splice(index, 1);
          }
          if (audioQueueRef.current.length === 0) {
            nextStartTimeRef.current = 0;
            console.log(
              `[Gemini Live] Audio queue complete (${chunkCountRef.current} chunks played). Setting state to idle.`,
            );
            updateState('idle');
            if (pendingPhaseInfoRef.current) {
              setCurrentPhaseInfo(pendingPhaseInfoRef.current);
              pendingPhaseInfoRef.current = null;
            }
          }
        };
      } catch (err) {
        console.error('Audio playback error:', err);
      }
    },
    [updateState],
  );

  useEffect(() => {
    playPcm24kChunkRef.current = playPcm24kChunk;
  }, [playPcm24kChunk]);

  // Connect to Gemini Live WebSocket (singleton — one session per tab)
  const connectLiveWs = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (
      sharedLiveCounselorWs &&
      (sharedLiveCounselorWs.readyState === WebSocket.OPEN ||
        sharedLiveCounselorWs.readyState === WebSocket.CONNECTING)
    ) {
      wsRef.current = sharedLiveCounselorWs;
      if (sharedLiveCounselorWs.readyState === WebSocket.OPEN) {
        setIsLiveWsConnected(true);
      }
      return;
    }

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      sharedLiveCounselorWs = socket;

      socket.onopen = () => {
        console.log('Connected to Gemini Live Counselor WS Gateway');
        setIsFallbackMode(false);
        optionsRef.current.onConnected?.();

        socket.send(
          JSON.stringify({
            event: 'start_live_session',
            data: { languagePreference: 'hinglish' },
          }),
        );

        const queued = queuedFramesRef.current;
        queuedFramesRef.current = [];
        for (const frame of queued) {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        }
      };

      socket.onmessage = (event) => {
        let parsed: GatewayEvent;
        try {
          parsed = JSON.parse(event.data);
        } catch (err) {
          console.error('WS message parse error:', err);
          return;
        }

        switch (parsed.event) {
          case 'audio_chunk':
            if (parsed.data) {
              const mime = parsed.mimeType || 'audio/pcm;rate=24000';
              // Avatar mode: buffer Gemini PCM until MuseTalk MP4 arrives (audio lives in the video).
              // On MuseTalk fail/timeout we flush this buffer so the student still hears Gemini.
              if (avatarServiceUrlRef.current) {
                pendingPcmChunksRef.current.push({ data: parsed.data, mimeType: mime });
                // Show "thinking/preparing" while Gemini voice is being captured for MuseTalk.
                if (counselorStateRef.current === 'idle') {
                  updateState('thinking');
                }
              } else {
                playPcm24kChunk(parsed.data, mime);
              }
              optionsRef.current.onAudioChunk?.(parsed.data, mime);
            }
            break;
          case 'intro_beat_started':
            updateState('thinking');
            introReplySentRef.current = false;
            console.log(`[Intro] Gemini beat ${parsed.introBeat || '?'} started — waiting for voice + MuseTalk`);
            break;
          case 'text_chunk':
            if (parsed.text) optionsRef.current.onTextChunk?.(parsed.text);
            break;
          case 'turn_rendering':
            // Heartbeat per MuseTalk slice while building ONE full MP4 (Beat 3) — do not play clips.
            beginAwaitingTurnVideo();
            introReplySentRef.current = false;
            optionsRef.current.onTurnRendering?.({
              introBeat: parsed.introBeat,
              chunk: parsed.chunk,
              chunkTotal: parsed.chunkTotal,
            });
            if (parsed.chunk && parsed.chunkTotal) {
              console.log(
                `[Avatar] MuseTalk full-render progress ${parsed.chunk}/${parsed.chunkTotal} (no progressive play)`,
              );
            } else {
              console.log('[Avatar] MuseTalk full lip-sync render started — waiting for one MP4');
            }
            break;
          case 'stream_started':
            // Scripted intro (esp. Beat 3) must never use progressive clip player.
            if (scriptedIntroActiveRef.current) {
              console.log(
                `[Intro] ignoring stream_started during scripted intro beat=${parsed.introBeat ?? '-'}`,
              );
              beginAwaitingTurnVideo();
              break;
            }
            lipsyncModeRef.current = 'stream';
            beginAwaitingTurnVideo();
            introReplySentRef.current = false;
            console.log(
              `[Phase2] stream started sliceSec=${parsed.sliceSec ?? 0.8} beat=${parsed.introBeat ?? '-'}`,
            );
            optionsRef.current.onStreamStarted?.();
            break;
          case 'stream_video_segment':
            if (scriptedIntroActiveRef.current) {
              console.warn('[Intro] ignoring stream_video_segment during scripted intro (full MP4 only)');
              break;
            }
            if (parsed.videoBase64) {
              clearTurnVideoWait();
              pendingPcmChunksRef.current = []; // lips+audio live in segments — avoid double audio
              beginAwaitingTurnVideo(); // keep timeout alive for next segment
              optionsRef.current.onStreamVideoSegment?.({
                seq: parsed.seq || 0,
                videoBase64: parsed.videoBase64,
                mimeType: parsed.mimeType || 'video/mp4',
                durationHintSec: parsed.durationHintSec,
              });
              const seqN = Number(parsed.seq ?? 0);
              if (seqN <= 2 || seqN % 5 === 0) {
                console.log(`[Phase2] stream segment seq=${seqN}`);
              }
            }
            break;
          case 'stream_turn_flushed': {
            const emitted = Number(parsed.segmentsEmitted ?? -1);
            console.log(`[Phase2] stream turn flushed segmentsEmitted=${emitted}`);
            optionsRef.current.onStreamFlushed?.();
            // MuseTalk down / 0 clips → play buffered Gemini PCM immediately (no 6min black wait).
            if (emitted === 0) {
              console.warn('[Avatar] 0 MuseTalk segments — PCM audio fallback now');
              flushPendingPcmPlayback();
            }
            break;
          }
          case 'turn_audio_mp3':
            // Exact TTS line when MuseTalk is down — still hear Good morning / assessment.
            if (parsed.audioBase64) {
              try {
                clearTurnVideoWait();
                pendingPcmChunksRef.current = [];
                const byteCharacters = atob(parsed.audioBase64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const blob = new Blob([new Uint8Array(byteNumbers)], {
                  type: parsed.mimeType || 'audio/mpeg',
                });
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => {
                  URL.revokeObjectURL(url);
                  updateState('idle');
                };
                updateState('speaking');
                audio.play().catch((err) => {
                  console.warn('[TTS MP3] autoplay blocked:', err);
                  updateState('idle');
                });
              } catch (err) {
                console.warn('[TTS MP3] play failed:', err);
                updateState('idle');
              }
            }
            break;
          case 'turn_video_ready':
            // Scripted intro always accepts the next video (awaiting flag set by turn_rendering).
            if (!awaitingTurnVideoRef.current && !scriptedIntroActiveRef.current) {
              console.warn('[Avatar] Ignoring late MuseTalk video (already fell back or interrupted)');
              break;
            }
            if (parsed.videoBase64) {
              try {
                pendingPcmChunksRef.current = [];
                clearTurnVideoWait();
                const byteCharacters = atob(parsed.videoBase64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: parsed.mimeType || 'video/mp4' });
                const blobUrl = URL.createObjectURL(blob);
                optionsRef.current.onTurnVideoReady?.(blobUrl);
              } catch (err) {
                console.warn('[Turn Video] Failed to create blob URL:', err);
                flushPendingPcmPlayback();
              }
            } else {
              flushPendingPcmPlayback();
            }
            break;
          case 'turn_video_failed':
            console.warn('[Avatar] MuseTalk render failed:', parsed.message || 'unknown');
            // Always fall back to buffered Gemini PCM so the exact spoken beat is still heard.
            flushPendingPcmPlayback();
            break;
          case 'live_session_started':
            console.log('Gemini Live Session Confirmed & Active!');
            setIsLiveWsConnected(true);
            setIsFallbackMode(false);
            if (parsed.lipsyncMode === 'batch') lipsyncModeRef.current = 'batch';
            else lipsyncModeRef.current = 'stream';
            console.log(
              `[Phase2] lipsyncMode=${lipsyncModeRef.current} sliceSec=${parsed.sliceSec ?? 0.8}`,
            );
            if (parsed.avatarServiceUrl) {
              setAvatarServiceUrl(parsed.avatarServiceUrl);
              avatarServiceUrlRef.current = parsed.avatarServiceUrl;
              console.log('[Avatar Service] Connected Cloud URL:', parsed.avatarServiceUrl);
            } else {
              setAvatarServiceUrl('');
              avatarServiceUrlRef.current = '';
            }
            // Phase 1.5: ask backend for warm_mode confirm (also pushed after /api/warmup)
            safeSend({ event: 'get_avatar_status' });
            break;
          case 'avatar_status':
            console.log(
              `[Avatar Status] connected=${parsed.connected} warm_mode=${parsed.warmMode || '?'} ` +
                `warm_ready=${parsed.warmReady} version=${parsed.version || '?'} ` +
                `${parsed.message || ''}`,
            );
            if (parsed.connected === false) {
              // Stop buffering PCM for MuseTalk — play voice immediately (audio-only mode).
              avatarServiceUrlRef.current = '';
              setAvatarServiceUrl('');
              flushPendingPcmPlayback();
              if (parsed.message) {
                raiseError(parsed.message);
              }
            } else if (parsed.connected === true && parsed.avatarServiceUrl) {
              setAvatarServiceUrl(String(parsed.avatarServiceUrl));
              avatarServiceUrlRef.current = String(parsed.avatarServiceUrl);
            }
            break;
          case 'livekit_bridge_status':
            if (parsed.active) {
              geminiUplinkEnabledRef.current = false;
              console.log(
                `[Phase3a/3b] LiveKit bridge active room=${parsed.roomName || ''} mediaOut=${parsed.mediaOut ? 'yes' : 'no'}`,
              );
            } else {
              geminiUplinkEnabledRef.current = true;
              console.warn(
                `[Phase3a] LiveKit bridge inactive (${parsed.mode || parsed.reason || 'fallback'}) — WS mic uplink on`,
              );
            }
            optionsRef.current.onLivekitBridgeStatus?.({
              active: Boolean(parsed.active),
              mediaOut: Boolean(parsed.mediaOut),
              roomName: parsed.roomName,
              mode: parsed.mode,
              wsFallback: parsed.wsFallback !== false,
              wsFallbackMs: parsed.wsFallbackMs,
            });
            break;
          case 'interrupted':
            console.log('[Gemini Live] Interruption received. Halting audio playback.');
            stopAudioPlayback();
            break;
          case 'turn_complete':
            if (typeof parsed.awaitingStudentReply === 'boolean') {
              awaitingStudentReplyRef.current = parsed.awaitingStudentReply;
              introReplySentRef.current = false;
            }
            if (parsed.scriptedIntro === true) {
              scriptedIntroActiveRef.current = (parsed.phaseNumber ?? 1) < 2;
            }
            if (parsed.phaseNumber != null && parsed.phaseNumber >= 2) {
              scriptedIntroActiveRef.current = false;
              awaitingStudentReplyRef.current = false;
            }
            if (parsed.phaseNumber && parsed.phaseName) {
              const newPhase: PhaseInfo = {
                phaseNumber: parsed.phaseNumber,
                phaseName: parsed.phaseName,
                milestoneId: parsed.milestoneId,
                milestoneName: parsed.milestoneName,
                milestonePart: parsed.milestonePart,
                targetDuration: parsed.targetDuration,
              };
              if (
                audioQueueRef.current.length > 0 ||
                awaitingTurnVideoRef.current ||
                avatarVideoPlayingRef.current
              ) {
                pendingPhaseInfoRef.current = newPhase;
              } else {
                setCurrentPhaseInfo(newPhase);
              }
            }
            if (
              !scriptedIntroActiveRef.current &&
              avatarServiceUrlRef.current &&
              !awaitingTurnVideoRef.current &&
              !avatarVideoPlayingRef.current &&
              pendingPcmChunksRef.current.length > 0
            ) {
              flushPendingPcmPlayback();
            }
            console.log(
              `[Intro/Live] turn_complete. Phase ${parsed.phaseNumber || 1}: ${parsed.milestoneName || 'In progress'} scripted=${!!parsed.scriptedIntro} awaitReply=${!!parsed.awaitingStudentReply}`,
            );
            break;
          case 'live_ws_closed':
            setIsLiveWsConnected(false);
            raiseError(parsed.message || 'Live stream closed by server.');
            break;
          case 'live_ws_fallback':
            setIsFallbackMode(true);
            setIsLiveWsConnected(false);
            raiseError(parsed.message || 'Gemini Live stream is unavailable.');
            break;
          case 'error':
            raiseError(parsed.message || 'Unknown live counselor error');
            break;
          default:
            break;
        }
      };

      socket.onerror = (err) => {
        console.warn('Gemini Live WS Error:', err);
        setIsLiveWsConnected(false);
        raiseError('Could not reach the live counselor gateway on the backend.');
      };

      socket.onclose = () => {
        console.log('Gemini Live WS Closed');
        setIsLiveWsConnected(false);
        if (wsRef.current === socket) wsRef.current = null;
        if (sharedLiveCounselorWs === socket) sharedLiveCounselorWs = null;
      };
    } catch (err) {
      console.error('WS Connection error:', err);
      raiseError(
        err instanceof Error ? err.message : 'WebSocket connection failed.',
      );
    }
  }, [
    wsUrl,
    playPcm24kChunk,
    stopAudioPlayback,
    raiseError,
    beginAwaitingTurnVideo,
    clearTurnVideoWait,
    flushPendingPcmPlayback,
    updateState,
  ]);

  // Disconnect WebSocket
  const disconnectLiveWs = useCallback(() => {
    queuedFramesRef.current = [];
    const socket = wsRef.current || sharedLiveCounselorWs;
    wsRef.current = null;
    sharedLiveCounselorWs = null;
    if (socket) {
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      } catch (_) {}
    }
    setIsLiveWsConnected(false);
    stopAudioPlayback();
  }, [stopAudioPlayback]);

  // Start Real-Time Microphone Audio Streaming (Resampled down to 16kHz PCM)
  /**
   * Local VAD + optional Gemini WS uplink.
   * When LiveKit bridge is active, pass mediaStream from LiveKit and geminiUplink=false
   * so we do not open a second mic or double-send PCM to Gemini.
   */
  const startMicStream = useCallback(async (opts?: {
    mediaStream?: MediaStream;
    geminiUplink?: boolean;
  }) => {
    if (scriptNodeRef.current) return;

    // Ensure WS connection is open (audio frames are buffered until it is).
    connectLiveWs();

    const uplink = opts?.geminiUplink !== false;
    geminiUplinkEnabledRef.current = uplink;
    ownsMicTracksRef.current = !opts?.mediaStream;

    try {
      // Prefer shared LiveKit MediaStream; else capture mic for legacy WS path.
      const stream =
        opts?.mediaStream ||
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }));

      mediaStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const micAudioCtx = new AudioContextClass();
      micAudioCtxRef.current = micAudioCtx;

      const source = micAudioCtx.createMediaStreamSource(stream);
      const scriptNode = micAudioCtx.createScriptProcessor(4096, 1, 1);
      scriptNodeRef.current = scriptNode;

      const nativeSampleRate = micAudioCtx.sampleRate;
      const targetSampleRate = 16000;
      const sampleRatio = nativeSampleRate / targetSampleRate;

      // Muting the ScriptProcessor output keeps it alive without echoing the mic.
      const silentGain = micAudioCtx.createGain();
      silentGain.gain.value = 0;

      scriptNode.onaudioprocess = (e) => {
        const inputBuffer = e.inputBuffer.getChannelData(0);

        // Compute RMS volume of incoming mic frame
        let sumSquares = 0;
        for (let i = 0; i < inputBuffer.length; i++) {
          sumSquares += inputBuffer[i] * inputBuffer[i];
        }
        const rms = Math.sqrt(sumSquares / inputBuffer.length);

        // Also shield while MuseTalk is rendering (thinking) — otherwise noise triggers Gemini interrupt.
        const aiBusy =
          counselorStateRef.current === 'speaking' ||
          counselorStateRef.current === 'thinking' ||
          avatarVideoPlayingRef.current ||
          awaitingTurnVideoRef.current;

        if (aiBusy) {
          const bargeSuppressed = Date.now() < suppressBargeInUntilRef.current;
          const BARGE_IN_RMS_THRESHOLD = 0.12; // higher: ignore speaker bleed
          const REQUIRED_BARGE_IN_FRAMES = 8; // ~680ms sustained voice

          if (!bargeSuppressed && rms >= BARGE_IN_RMS_THRESHOLD) {
            bargeInFramesRef.current += 1;
            if (bargeInFramesRef.current >= REQUIRED_BARGE_IN_FRAMES) {
              console.log(
                '[Gemini Live] Intentional Student Barge-In confirmed (Sustained RMS:',
                rms.toFixed(3),
                '). Stopping AI speech.',
              );
              bargeInFramesRef.current = 0;
              stopAudioPlayback();
              safeSend({ event: 'interrupt' });

              if (userSilenceTimerRef.current) {
                clearTimeout(userSilenceTimerRef.current);
                userSilenceTimerRef.current = null;
              }
              userSpeechFramesRef.current = 4;
              isUserSpeakingRef.current = true;
              setIsUserSpeaking(true);
            }
          } else {
            bargeInFramesRef.current = Math.max(0, bargeInFramesRef.current - 1);
          }

          // Never stream mic to Gemini while counselor audio/video/render is active.
          return;
        } else {
          // AI is NOT speaking: detect student speech activity
          // Tuned parameters: 0.045 RMS threshold, 4 consecutive frames (~340ms), 900ms silence timeout
          const SPEECH_THRESHOLD = 0.045;
          const REQUIRED_SPEECH_FRAMES = 4;
          const SILENCE_TIMEOUT_MS = 900;

          if (rms >= SPEECH_THRESHOLD) {
            userSpeechFramesRef.current += 1;
            if (userSilenceTimerRef.current) {
              clearTimeout(userSilenceTimerRef.current);
              userSilenceTimerRef.current = null;
            }
            if (userSpeechFramesRef.current >= REQUIRED_SPEECH_FRAMES && !isUserSpeakingRef.current) {
              isUserSpeakingRef.current = true;
              setIsUserSpeaking(true);
              if (counselorStateRef.current === 'thinking') {
                updateState('idle');
              }
            }
          } else {
            userSpeechFramesRef.current = Math.max(0, userSpeechFramesRef.current - 1);
            if (isUserSpeakingRef.current && !userSilenceTimerRef.current) {
              userSilenceTimerRef.current = setTimeout(() => {
                userSilenceTimerRef.current = null;
                userSpeechFramesRef.current = 0;
                isUserSpeakingRef.current = false;
                setIsUserSpeaking(false);

                // Phase-1: student finished greeting/assessment answer → next scripted beat.
                if (
                  scriptedIntroActiveRef.current &&
                  awaitingStudentReplyRef.current &&
                  !introReplySentRef.current &&
                  !avatarVideoPlayingRef.current &&
                  counselorStateRef.current !== 'speaking'
                ) {
                  introReplySentRef.current = true;
                  awaitingStudentReplyRef.current = false;
                  updateState('thinking');
                  safeSend({ event: 'intro_student_reply' });
                  console.log('[Intro] Student reply detected → requesting next scripted beat');
                  return;
                }

                if (counselorStateRef.current !== 'speaking') {
                  updateState('thinking');
                }
              }, SILENCE_TIMEOUT_MS);
            }
          }
        }

        // Warmup: mic is open but do not uplink (prevents post-video echo → Gemini interrupted).
        if (Date.now() < micUplinkWarmupUntilRef.current) {
          return;
        }

        // Phase-1 scripted intro: VAD only — do not stream mic to Gemini.
        if (scriptedIntroActiveRef.current) {
          return;
        }

        // Phase 3a: LiveKit bridge owns Gemini uplink — skip WS audio_input.
        if (!geminiUplinkEnabledRef.current) {
          return;
        }

        const outputLength = Math.floor(inputBuffer.length / sampleRatio);
        if (outputLength <= 0) return;

        const pcm16 = new Int16Array(outputLength);

        // Resample native audio down to 16000Hz PCM Int16
        for (let i = 0; i < outputLength; i++) {
          const inputIndex = Math.min(
            Math.floor(i * sampleRatio),
            inputBuffer.length - 1,
          );
          const s = Math.max(-1, Math.min(1, inputBuffer[inputIndex]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Convert Int16Array to Base64
        let binary = '';
        const bytes = new Uint8Array(pcm16.buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }

        safeSend({
          event: 'audio_input',
          data: { pcmBase64: btoa(binary) },
        });
      };

      source.connect(scriptNode);
      scriptNode.connect(silentGain);
      silentGain.connect(micAudioCtx.destination);
      armMicUplinkWarmup(2000);
      setIsMicActive(true);
    } catch (err) {
      console.error('Microphone error:', err);
      raiseError(
        `Could not access microphone: ${err instanceof Error ? err.message : 'please check mic permissions.'}`,
      );
    }
  }, [connectLiveWs, safeSend, stopAudioPlayback, raiseError, armMicUplinkWarmup, updateState]);

  // Stop Microphone Stream
  const stopMicStream = useCallback(() => {
    if (scriptNodeRef.current) {
      try {
        scriptNodeRef.current.onaudioprocess = null;
        scriptNodeRef.current.disconnect();
      } catch (_) {}
      scriptNodeRef.current = null;
    }
    if (micAudioCtxRef.current) {
      try {
        micAudioCtxRef.current.close();
      } catch (_) {}
      micAudioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      if (ownsMicTracksRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      mediaStreamRef.current = null;
    }
    if (userSilenceTimerRef.current) {
      clearTimeout(userSilenceTimerRef.current);
      userSilenceTimerRef.current = null;
    }
    userSpeechFramesRef.current = 0;
    isUserSpeakingRef.current = false;
    setIsUserSpeaking(false);
    setIsMicActive(false);
  }, []);

  // Interrupt AI Speech
  const interruptAi = useCallback(() => {
    stopAudioPlayback();
    safeSend({ event: 'interrupt' });
  }, [stopAudioPlayback, safeSend]);

  // Send a typed message into the live voice session
  const sendLiveText = useCallback(
    (text: string) => {
      if (!text.trim()) return false;
      updateState('thinking');
      return safeSend({ event: 'text_turn', data: { text: text.trim() } });
    },
    [safeSend, updateState],
  );

  // Trigger Official SABCQ Grand Opening Introduction on first mic tap
  const triggerFirstIntro = useCallback(() => {
    updateState('thinking');
    return safeSend({ event: 'trigger_first_intro' });
  }, [safeSend, updateState]);

  /** Ask Nest to join LiveKit room and forward student mic → Gemini. */
  const startLivekitBridge = useCallback(
    (roomName: string) => {
      geminiUplinkEnabledRef.current = false;
      return safeSend({
        event: 'livekit_bridge_start',
        data: { roomName },
      });
    },
    [safeSend],
  );

  const stopLivekitBridge = useCallback(() => {
    geminiUplinkEnabledRef.current = true;
    return safeSend({ event: 'livekit_bridge_stop' });
  }, [safeSend]);

  // Cleanup on unmount only. Deps are all stable callbacks, so this effect
  // runs once instead of tearing the session down on every render.
  useEffect(() => {
    return () => {
      stopMicStream();
      disconnectLiveWs();
    };
  }, [stopMicStream, disconnectLiveWs]);

  return {
    isLiveWsConnected,
    isMicActive,
    isUserSpeaking,
    isFallbackMode,
    counselorState,
    connectLiveWs,
    disconnectLiveWs,
    startMicStream,
    stopMicStream,
    stopAudioPlayback,
    interruptAi,
    sendLiveText,
    triggerFirstIntro,
    notifyAvatarPlayback,
    armMicUplinkWarmup,
    startLivekitBridge,
    stopLivekitBridge,
    currentPhaseInfo,
    avatarServiceUrl,
  };
}
