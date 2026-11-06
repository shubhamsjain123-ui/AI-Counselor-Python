'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Wifi, UserCheck, PhoneOff, Mic, MicOff, Volume2, Layers, Cpu, ShieldCheck, Loader2 } from 'lucide-react';
import { useGeminiLiveVoice } from '../hooks/useGeminiLiveVoice';
import { useProgressiveLipSync } from '../hooks/useProgressiveLipSync';
import { useLiveKitMic } from '../hooks/useLiveKitMic';

interface StreamingAvatarProps {
  counselorState: 'idle' | 'thinking' | 'speaking';
  responseText?: string;
  isLoading?: boolean;
  onEndSession: () => void;
  studentName: string;
}

export const HeyGenStreamingAvatar: React.FC<StreamingAvatarProps> = ({
  counselorState: propsState,
  responseText,
  isLoading,
  onEndSession,
  studentName,
}) => {
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const listeningVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeVideo, setActiveVideo] = useState<'A' | 'B'>('A');
  const isSwitchingRef = useRef(false);

  const [liveError, setLiveError] = useState<string | null>(null);
  const hasSpokenIntroRef = useRef(false);
  const [introStarted, setIntroStarted] = useState(false);
  const [introCompleted, setIntroCompleted] = useState(false);
  const [counselingInitiated, setCounselingInitiated] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const introHasPlayedAudioRef = useRef(false);
  const [isMuseTalkStreaming, setIsMuseTalkStreaming] = useState(false);
  const museTalkWsRef = useRef<WebSocket | null>(null);

  // Cloud GPU MuseTalk — batch turn video OR Phase-2 progressive segments
  const [turnVideoUrl, setTurnVideoUrl] = useState<string | null>(null);
  const [isTurnPlaying, setIsTurnPlaying] = useState(false);
  const turnVideoRef = useRef<HTMLVideoElement>(null);
  const liveKitVideoRef = useRef<HTMLVideoElement>(null);
  const liveKitAudioRef = useRef<HTMLAudioElement>(null);
  const [streamPlaying, setStreamPlaying] = useState(false);
  /** LiveKit media-out flag from Nest (lips still play via WS progressive) */
  const liveKitMediaOutRef = useRef(false);
  const streamPlayingRef = useRef(false);
  const startLivekitBridgeRef = useRef<(room: string) => void>(() => {});

  const [lipsBuffering, setLipsBuffering] = useState(false);

  const { enqueueSegment, clearQueue, beginTurn, endTurnProduce } = useProgressiveLipSync({
    videoRef: turnVideoRef,
    minBufferSegments: 6,
    rebufferSegments: 4,
    onPlayingChange: (playing) => {
      streamPlayingRef.current = playing;
      setStreamPlaying(playing);
      setIsTurnPlaying(playing);
      if (playing) setLipsBuffering(false);
      notifyAvatarPlaybackRef.current?.(playing);
    },
    onBuffering: (buffering) => {
      // Buffering ≠ playing: keep listening loop visible (was black when isTurnPlaying forced true).
      setLipsBuffering(buffering);
    },
    onQueueEmpty: () => {
      streamPlayingRef.current = false;
      setStreamPlaying(false);
      setLipsBuffering(false);
      setIsTurnPlaying(false);
      notifyAvatarPlaybackRef.current?.(false);
    },
  });

  const notifyAvatarPlaybackRef = useRef<((active: boolean) => void) | null>(null);

  const liveKit = useLiveKitMic({
    counselorVideoRef: liveKitVideoRef,
    counselorAudioRef: liveKitAudioRef,
    onCounselorMedia: (active) => {
      // Stream-mode lips are WS progressive. Ignore LiveKit counselor A/V for playback
      // (per-clip WebRTC republish caused shhhh/stutter + black flashes).
      if (active && liveKitMediaOutRef.current) {
        console.log(
          '[LiveKit] counselor track present — lips still via WS progressive (smooth path)',
        );
      }
    },
    onReconnected: (room) => {
      console.log('[Phase3c] re-requesting Nest LiveKit bridge after reconnect', room);
      startLivekitBridgeRef.current(room);
    },
  });

  // Real-time Gemini Multimodal Live Voice-to-Voice Hook
  const {
    isLiveWsConnected,
    isMicActive,
    isUserSpeaking,
    isFallbackMode,
    counselorState: liveState,
    connectLiveWs,
    disconnectLiveWs,
    startMicStream,
    stopMicStream,
    stopAudioPlayback,
    interruptAi,
    triggerFirstIntro,
    notifyAvatarPlayback,
    startLivekitBridge,
    stopLivekitBridge,
    currentPhaseInfo,
    avatarServiceUrl,
  } = useGeminiLiveVoice({
    onConnected: () => setLiveError(null),
    onTextChunk: () => {},
    onAudioChunk: () => {},
    onTurnRendering: ({ introBeat, chunk, chunkTotal } = {}) => {
      // Beat 3 full MP4 path: listening + preparing, never progressive clips.
      clearQueue();
      setTurnVideoUrl(null);
      setLipsBuffering(true);
      setIsTurnPlaying(false);
      setStreamPlaying(false);
      setIsMuseTalkStreaming(false);
      console.log(
        `[Avatar] full-render wait beat=${introBeat ?? '?'} ${chunk && chunkTotal ? `${chunk}/${chunkTotal}` : ''}`,
      );
    },
    onTurnVideoReady: (videoBlobUrl: string) => {
      console.log('[Avatar] MuseTalk lip-sync turn video ready (one continuous MP4)');
      clearQueue();
      setLipsBuffering(false);
      setIsMuseTalkStreaming(false);
      setTurnVideoUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch (_) {}
        }
        return videoBlobUrl;
      });
      setIsTurnPlaying(true);
    },
    onStreamStarted: () => {
      clearQueue();
      beginTurn({ holdUntilFlush: true });
      setTurnVideoUrl(null);
      setIsMuseTalkStreaming(true);
      setLipsBuffering(true);
    },
    onStreamVideoSegment: ({ seq, videoBase64, mimeType, durationHintSec }) => {
      // Live Phase 2 only — intro Beat 3 is blocked in the hook during scripted intro.
      setIsMuseTalkStreaming(true);
      if (!videoBase64) {
        console.warn(`[Avatar] seq=${seq} missing videoBase64 — skip`);
        return;
      }
      enqueueSegment(videoBase64, mimeType, seq, durationHintSec);
    },
    onStreamFlushed: () => {
      console.log('[Avatar] stream flushed — progressive player draining queue');
      endTurnProduce();
      // If MuseTalk sent nothing, don't leave a black "speaking" frame.
      if (!streamPlayingRef.current && !turnVideoRef.current?.src) {
        setIsTurnPlaying(false);
        setStreamPlaying(false);
        setIsMuseTalkStreaming(false);
      }
    },
    onLivekitBridgeStatus: ({ active, mediaOut }) => {
      const out = Boolean(active && mediaOut);
      liveKitMediaOutRef.current = out;
      if (active) {
        console.log(
          `[LiveKit] bridge active mediaOut=${out ? 'yes' : 'no'} — lips=WS progressive, mic=LiveKit`,
        );
      }
    },
    onError: (message) => setLiveError(message),
  });

  useEffect(() => {
    notifyAvatarPlaybackRef.current = notifyAvatarPlayback;
  }, [notifyAvatarPlayback]);

  useEffect(() => {
    startLivekitBridgeRef.current = startLivekitBridge;
  }, [startLivekitBridge]);

  const handleTurnEnded = useCallback(() => {
    console.log('[Avatar] Synced turn video completed.');
    setIsTurnPlaying(false);
    notifyAvatarPlayback(false);
    setTurnVideoUrl((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev);
        } catch (_) {}
      }
      return null;
    });
  }, [notifyAvatarPlayback]);

  const handleEndSessionClick = () => {
    if (turnVideoRef.current) {
      try { turnVideoRef.current.pause(); } catch (_) {}
    }
    clearQueue();
    setIsTurnPlaying(false);
    setStreamPlaying(false);
    liveKit.stopCounselorPlayback();
    stopLivekitBridge();
    void liveKit.disconnect();
    stopMicStream();
    stopAudioPlayback();
    disconnectLiveWs();
    onEndSession();
  };

  const counselorState = isTurnPlaying
    ? 'speaking'
    : isLiveWsConnected && liveState !== 'idle'
    ? liveState
    : propsState;

  // Listening while student waits OR while MuseTalk is still generating (no black).
  const showListeningLoop =
    (lipsBuffering && !streamPlaying && !turnVideoUrl) ||
    (counselingInitiated &&
      !isTurnPlaying &&
      !streamPlaying &&
      !lipsBuffering &&
      counselorState !== 'speaking');

  // Autoplay MuseTalk turn video (lip-sync + Gemini speech in one MP4)
  useEffect(() => {
    if (turnVideoUrl && turnVideoRef.current && isTurnPlaying) {
      const vid = turnVideoRef.current;
      vid.currentTime = 0;
      vid.muted = false;
      notifyAvatarPlayback(true);
      const playPromise = vid.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Avatar] Turn video autoplay with sound blocked, trying muted:', err);
          // If browser blocks unmuted autoplay, fall back: still show lips, user may need a click.
          vid.muted = true;
          vid.play().catch(console.warn);
        });
      }
    }
  }, [turnVideoUrl, isTurnPlaying, notifyAvatarPlayback]);

  // Only cancel lip-sync video on clear barge-in AFTER intro phase (counseling Phase 2+).
  // During intro beats, speaker echo was falsely cutting Good morning / assessment.
  useEffect(() => {
    if (!isUserSpeaking || !isTurnPlaying) return;
    if ((currentPhaseInfo?.phaseNumber ?? 1) < 2) return;

    clearQueue();
    liveKit.stopCounselorPlayback();
    if (turnVideoRef.current) {
      try {
        turnVideoRef.current.pause();
        turnVideoRef.current.currentTime = 0;
      } catch (_) {}
    }
    setIsTurnPlaying(false);
    notifyAvatarPlayback(false);
    setTurnVideoUrl((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev);
        } catch (_) {}
      }
      return null;
    });
    interruptAi();
  }, [
    isUserSpeaking,
    isTurnPlaying,
    notifyAvatarPlayback,
    interruptAi,
    currentPhaseInfo?.phaseNumber,
    clearQueue,
    liveKit,
  ]);

  // Connect Gemini Live WS quietly in background
  useEffect(() => {
    connectLiveWs();
  }, [connectLiveWs]);

  // 1-Second Auto-Intro Trigger upon session connect
  useEffect(() => {
    if (isLiveWsConnected && !hasSpokenIntroRef.current) {
      const timer = setTimeout(() => {
        hasSpokenIntroRef.current = true;
        setIntroStarted(true);
        triggerFirstIntro();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isLiveWsConnected, triggerFirstIntro]);

  // Track that counselor has started speaking (Beat 1 audio/video)
  useEffect(() => {
    if (introStarted && (counselorState === 'speaking' || isTurnPlaying)) {
      introHasPlayedAudioRef.current = true;
    }
  }, [introStarted, counselorState, isTurnPlaying]);

  // After Beat 1 lip-sync video fully ends, wait 2s (echo settle) then open mic.
  useEffect(() => {
    if (
      introStarted &&
      !counselingInitiated &&
      introHasPlayedAudioRef.current &&
      counselorState === 'idle' &&
      !isTurnPlaying &&
      isLiveWsConnected
    ) {
      const timer = setTimeout(() => {
        setCounselingInitiated(true);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [
    introStarted,
    counselingInitiated,
    counselorState,
    isTurnPlaying,
    isLiveWsConnected,
  ]);

  // Full Phase-1 intro (3 beats) done when backend advances to Phase 2
  useEffect(() => {
    if (currentPhaseInfo?.phaseNumber != null && currentPhaseInfo.phaseNumber >= 2) {
      setIntroCompleted(true);
    }
  }, [currentPhaseInfo?.phaseNumber]);

  // Phase 3a: LiveKit mic first → Nest bridge → Gemini. VAD reuses same MediaStream.
  // If LiveKit/bridge fails → legacy WS mic uplink (soft fallback).
  useEffect(() => {
    if (!counselingInitiated || !isLiveWsConnected || isMicActive || isMuted) return;

    let cancelled = false;
    void (async () => {
      const lk = await liveKit.connect(`student_${studentName || 'web'}`);
      if (cancelled) return;
      if (lk.ok) {
        try {
          await startMicStream({ mediaStream: lk.mediaStream, geminiUplink: false });
          startLivekitBridge(lk.roomName);
          console.log('[Phase3a] LiveKit mic + bridge requested', lk.roomName);
        } catch (err) {
          console.warn('[Phase3a] VAD attach failed — WS mic fallback', err);
          await startMicStream({ geminiUplink: true }).catch(console.warn);
        }
      } else {
        await startMicStream({ geminiUplink: true }).catch(console.warn);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    counselingInitiated,
    isLiveWsConnected,
    isMicActive,
    isMuted,
    startMicStream,
    liveKit,
    studentName,
    startLivekitBridge,
  ]);

  // Listening pose loop: student speaking + thinking/idle until answer video starts
  useEffect(() => {
    const vid = listeningVideoRef.current;
    if (!vid) return;
    if (showListeningLoop) {
      vid.muted = true;
      const playPromise = vid.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (err?.name !== 'AbortError') {
            console.warn('[Avatar] Listening loop play blocked:', err);
          }
        });
      }
    } else {
      try {
        vid.pause();
        vid.currentTime = 0;
      } catch (_) {}
    }
  }, [showListeningLoop]);

  // Dual-Video Crossfade Playback Controller for Priya Sharma Base Loop (Fallback / Idle)
  useEffect(() => {
    const vidA = videoRefA.current;
    const vidB = videoRefB.current;
    if (!vidA || !vidB) return;

    // Only play fallback loop if MuseTalk turn video is NOT active
    if (counselorState === 'speaking' && !isTurnPlaying) {
      const currentVid = activeVideo === 'A' ? vidA : vidB;
      const playPromise = currentVid.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          if (error.name !== 'AbortError') {
            console.warn('Video play notice:', error);
          }
        });
      }
    } else {
      vidA.pause();
      vidA.currentTime = 0;
      vidB.pause();
      vidB.currentTime = 0;
      setActiveVideo('A');
      isSwitchingRef.current = false;
    }
  }, [counselorState, activeVideo, isTurnPlaying]);

  // Seamless Zero-Blink Ping-Pong TimeUpdate Switcher
  useEffect(() => {
    const vidA = videoRefA.current;
    const vidB = videoRefB.current;
    if (!vidA || !vidB) return;

    const handleTimeUpdate = (e: Event) => {
      if (counselorState !== 'speaking' || isSwitchingRef.current) return;
      const target = e.target as HTMLVideoElement;
      const threshold = target.duration && !isNaN(target.duration) ? Math.max(0, target.duration - 0.4) : 9.5;

      if (target.currentTime >= threshold) {
        isSwitchingRef.current = true;
        const nextVid = target === vidA ? vidB : vidA;
        const nextMode = target === vidA ? 'B' : 'A';

        nextVid.currentTime = 0;
        const playPromise = nextVid.play();

        const doSwitch = () => {
          setActiveVideo(nextMode);
          setTimeout(() => {
            isSwitchingRef.current = false;
          }, 400);
        };

        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              if (nextVid.readyState >= 3) {
                doSwitch();
              } else {
                const onPlaying = () => {
                  nextVid.removeEventListener('playing', onPlaying);
                  doSwitch();
                };
                nextVid.addEventListener('playing', onPlaying);
              }
            })
            .catch(() => {
              isSwitchingRef.current = false;
            });
        } else {
          doSwitch();
        }
      }
    };

    vidA.addEventListener('timeupdate', handleTimeUpdate);
    vidB.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      vidA.removeEventListener('timeupdate', handleTimeUpdate);
      vidB.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [counselorState]);

  // Per-turn MuseTalk uses HTTP MP4, not /ws/avatar_stream frames.
  // Keep the old stream socket closed so an empty canvas never covers the lip-sync video.
  useEffect(() => {
    setIsMuseTalkStreaming(false);
    if (museTalkWsRef.current) {
      try {
        museTalkWsRef.current.close();
      } catch (_) {}
      museTalkWsRef.current = null;
    }
  }, [avatarServiceUrl]);

  const toggleMicMute = async () => {
    if (!isMuted) {
      setIsMuted(true);
      // Phase 3c: mute LiveKit track (keep VAD/session); also pause local ScriptProcessor uplink.
      await liveKit.setMicMuted(true);
      stopMicStream();
    } else {
      setIsMuted(false);
      await liveKit.setMicMuted(false);
      try {
        const shared = liveKit.getMediaStream();
        if (liveKit.connected && shared) {
          await startMicStream({
            mediaStream: shared,
            geminiUplink: !liveKit.connected,
          });
          if (liveKit.connected && liveKit.roomName) {
            startLivekitBridge(liveKit.roomName);
          }
        } else {
          await startMicStream({ geminiUplink: true });
        }
      } catch (err) {
        console.warn('Failed to resume mic stream:', err);
      }
    }
  };

  return (
    <div className="relative w-full max-w-5xl mx-auto h-[82vh] rounded-3xl overflow-hidden glass-panel border border-cyan-500/40 shadow-[0_0_100px_rgba(6,182,212,0.3)] flex flex-col justify-between bg-slate-950">
      
      {/* 4K REALTIME HUMAN AVATAR DISPLAY */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-slate-950 flex items-center justify-center">
        
        {/* Photorealistic Interactive Counselor Video Canvas */}
        <div className={`relative w-full h-full transition-all duration-500 ease-in-out ${
          counselorState === 'speaking'
            ? 'scale-[1.02] filter brightness-105 contrast-105'
            : counselorState === 'thinking'
            ? 'scale-[1.01] filter brightness-110'
            : 'scale-100'
        }`}>
          {/* Base Static Image — only before counseling / as fallback under videos */}
          <img
            src="/ai_councler.png"
            alt="Priya Sharma - Senior AI Career Counselor"
            className={`absolute inset-0 z-0 w-full h-full object-cover object-center transition-opacity duration-300 ${
              counselorState === 'speaking' || showListeningLoop ? 'opacity-0' : 'opacity-100'
            }`}
          />

          {/* Listening loop while student speaks / Priya waits for answer */}
          <video
            ref={listeningVideoRef}
            src="/priya_sharma_listening.mp4"
            muted
            loop
            playsInline
            preload="auto"
            className={`absolute inset-0 w-full h-full object-cover object-center transition-opacity duration-300 ${
              showListeningLoop ? 'z-[15] opacity-100' : 'z-0 opacity-0 pointer-events-none'
            }`}
          />

          {/* Dual Seamless Ping-Pong Video Streams for Natural Loop */}
          <video
            ref={videoRefA}
            src="/ai_councloer.mp4"
            muted
            playsInline
            preload="auto"
            className={`absolute inset-0 w-full h-full object-cover object-center transition-opacity duration-300 ${
              activeVideo === 'A' && !isTurnPlaying && !showListeningLoop
                ? 'z-20 opacity-100'
                : counselorState === 'speaking' && !isTurnPlaying
                ? 'z-10 opacity-100'
                : 'z-0 opacity-0'
            }`}
          />
          <video
            ref={videoRefB}
            src="/ai_councloer.mp4"
            muted
            playsInline
            preload="auto"
            className={`absolute inset-0 w-full h-full object-cover object-center transition-opacity duration-300 ${
              activeVideo === 'B' && !showListeningLoop
                ? 'z-20 opacity-100'
                : counselorState === 'speaking' && !isTurnPlaying
                ? 'z-10 opacity-100'
                : 'z-0 opacity-0'
            }`}
          />

          {/* MuseTalk WS progressive clips (smooth buffered path) */}
          <video
            ref={turnVideoRef}
            {...(turnVideoUrl ? { src: turnVideoUrl } : {})}
            playsInline
            preload="auto"
            className={`absolute inset-0 w-full h-full object-cover object-center z-25 transition-opacity duration-300 ${
              (turnVideoUrl && isTurnPlaying) || streamPlaying
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
            onEnded={turnVideoUrl ? handleTurnEnded : undefined}
          />

          {/* LiveKit counselor A/V — hidden; stream lips use WS progressive (no per-clip WebRTC) */}
          <video
            ref={liveKitVideoRef}
            playsInline
            autoPlay
            muted
            className="absolute inset-0 w-full h-full object-cover object-center z-[26] opacity-0 pointer-events-none"
          />
          <audio ref={liveKitAudioRef} autoPlay playsInline muted className="hidden" />

          {/* Canvas only for true frame-stream GPU path — never cover WS MP4 */}
          <canvas
            ref={canvasRef}
            width={512}
            height={512}
            className={`absolute inset-0 w-full h-full object-cover object-center transition-opacity duration-300 pointer-events-none ${
              isMuseTalkStreaming &&
              counselorState === 'speaking' &&
              !streamPlaying &&
              !turnVideoUrl
                ? 'z-30 opacity-100'
                : 'opacity-0 z-0'
            }`}
          />

          {/* Thinking Glow Overlay */}
          {counselorState === 'thinking' && (
            <div className="absolute inset-0 bg-gradient-to-t from-indigo-950/50 via-cyan-950/20 to-transparent pointer-events-none animate-pulse" />
          )}
        </div>
        
        {/* Ambient Dark Backdrop */}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-slate-950/40 pointer-events-none" />
      </div>

      {/* TOP OVERLAY HEADER: Counselor Profile (Left) & SABCQ Phase Badge (Right) */}
      <div className="relative z-10 p-6 flex items-center justify-between gap-3 w-full">
        {/* Top Left Counselor Info Badge */}
        <div className="flex items-center gap-3 bg-slate-900/90 backdrop-blur-xl px-4 py-2.5 rounded-full border border-white/10 shadow-2xl">
          <div className="relative flex items-center justify-center">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping absolute" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 relative" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide flex items-center gap-1.5">
              Priya Sharma
              <UserCheck className="w-4 h-4 text-cyan-400" />
            </h2>
            <p className="text-[11px] text-slate-300 flex items-center gap-1.5">
              {avatarServiceUrl ? (
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {lipsBuffering
                    ? 'Preparing full lip-sync (please wait)…'
                    : streamPlaying || isTurnPlaying
                      ? 'MuseTalk lip-sync (WS)'
                      : liveKit.connected
                        ? 'LiveKit mic · lips via WS'
                        : 'MuseTalk lip-sync'}
                </span>
              ) : liveError ? (
                <span className="text-amber-400 font-semibold">Audio only — MuseTalk offline</span>
              ) : (
                'Senior AI Career Counselor • SABCQ'
              )}
            </p>
          </div>
        </div>

        {/* Top Right SABCQ Phase Badge */}
        <div className="flex items-center gap-2.5 bg-gradient-to-r from-cyan-950/90 via-blue-950/90 to-indigo-950/90 backdrop-blur-xl px-5 py-2.5 rounded-full border border-cyan-500/40 shadow-xl max-w-lg">
          <Layers className="w-4 h-4 text-cyan-400 shrink-0 animate-pulse" />
          <div className="flex flex-col text-left">
            <span className="text-[10px] font-semibold text-cyan-400 tracking-wider uppercase">
              {currentPhaseInfo?.phaseName || 'Introduction & Counseling Setup'}
            </span>
            <span className="text-xs font-bold text-white tracking-wide truncate">
              {currentPhaseInfo?.milestoneName || 'Welcome & Introduction'}
            </span>
          </div>
        </div>
      </div>

      {/* CENTER STATUS OVERLAY */}
      {isFallbackMode && (
        <div className="relative z-10 flex flex-col items-center justify-center p-4 text-center">
          <div className="mb-2 flex items-center gap-2 bg-indigo-500/20 backdrop-blur-md px-5 py-2 rounded-full border border-indigo-500/40 text-indigo-200 shadow-2xl max-w-xl">
            <Wifi className="w-4 h-4 text-cyan-300" />
            <span className="text-xs font-semibold tracking-wide">
              Live AI Counselor Stream Connected
            </span>
          </div>
        </div>
      )}

      {liveError && (
        <div className="relative z-20 flex justify-center px-6 -mt-1 mb-2">
          <div className="flex items-start gap-2 bg-amber-950/95 backdrop-blur-md px-4 py-2.5 rounded-xl border border-amber-500/50 text-amber-100 shadow-2xl max-w-2xl">
            <span className="text-[11px] font-medium leading-snug">{liveError}</span>
            <button
              type="button"
              className="shrink-0 text-amber-300/80 hover:text-white text-xs font-bold"
              onClick={() => setLiveError(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* BOTTOM CONTROLS: Center Mic & Audio Visualizer Capsule + Right Circular End Button */}
      <div className="relative z-10 px-6 pb-6 pt-2 w-full flex flex-col items-center justify-center">
        
        {/* Main Controls Row with Centered Action and Right-Aligned Circular End Button */}
        <div className="relative w-full flex items-center justify-center">
          
          {/* Main Interaction Action Capsule */}
          {!counselingInitiated ? (
            <div className="flex items-center justify-center">
              <div className="flex items-center gap-4 bg-slate-950/85 backdrop-blur-xl px-7 py-3 rounded-full border border-cyan-500/40 shadow-[0_0_40px_rgba(6,182,212,0.3)]">
                {counselorState === 'thinking' ? (
                  <span className="text-xs font-semibold text-cyan-200 tracking-wide flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                    Generating lip-sync video... (short greeting)
                  </span>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 h-6">
                      <span className="w-1 bg-cyan-400 rounded-full h-3 animate-pulse" />
                      <span className="w-1 bg-cyan-400 rounded-full h-6 animate-bounce" />
                      <span className="w-1 bg-cyan-400 rounded-full h-4 animate-pulse" />
                      <span className="w-1 bg-cyan-400 rounded-full h-6 animate-bounce" />
                      <span className="w-1 bg-cyan-400 rounded-full h-2 animate-pulse" />
                    </div>
                    <span className="text-xs font-semibold text-cyan-200 tracking-wide flex items-center gap-2">
                      <Volume2 className="w-4 h-4 text-cyan-400 animate-pulse" />
                      Priya: Good morning...
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            // CONTINUOUS HANDS-FREE FULL-DUPLEX MODE ACTIVE!
            <div className={`flex items-center gap-6 bg-slate-950/85 backdrop-blur-xl px-8 py-3 rounded-full border transition-all duration-300 shadow-2xl ${
              isUserSpeaking
                ? 'border-emerald-500/50 shadow-[0_0_40px_rgba(16,185,129,0.3)] ring-2 ring-emerald-500/20'
                : counselorState === 'thinking'
                ? 'border-amber-500/40 shadow-[0_0_35px_rgba(245,158,11,0.25)]'
                : 'border-cyan-500/30 shadow-[0_0_40px_rgba(6,182,212,0.25)]'
            }`}>
              {/* Left Audio Waveform Bars */}
              <div className="flex items-center gap-1.5 h-8">
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-6 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-6 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-3 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-8 animate-bounce'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-8 animate-bounce'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-4 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/50 h-3'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-5 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-5 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-2.5 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-7 animate-bounce'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-7 animate-bounce'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-4 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/60 h-3.5'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-4 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-4 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-2 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
              </div>

              {/* Center Mic Mute/Unmute Toggle Button */}
              <button
                type="button"
                onClick={toggleMicMute}
                className={`relative w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl cursor-pointer ${
                  !isMuted && isMicActive
                    ? 'bg-gradient-to-tr from-cyan-500 to-blue-600 text-white shadow-[0_0_35px_rgba(6,182,212,0.6)] ring-4 ring-cyan-400/30 hover:scale-105'
                    : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-white'
                }`}
                title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
              >
                {!isMuted && isMicActive ? (
                  <Mic className="w-6 h-6 animate-pulse" />
                ) : (
                  <MicOff className="w-6 h-6 text-rose-400" />
                )}
                {isUserSpeaking && (
                  <span className="absolute inset-0 rounded-full border-2 border-emerald-400 animate-ping pointer-events-none" />
                )}
              </button>

              {/* Right Audio Waveform Bars */}
              <div className="flex items-center gap-1.5 h-8">
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-4 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-4 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-2 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-7 animate-bounce'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-7 animate-bounce'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-4 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/60 h-3.5'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-5 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-5 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-2.5 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-8 animate-bounce'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-8 animate-bounce'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-4 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/50 h-3'
                    : 'bg-slate-700 h-1.5'
                }`} />
                <span className={`w-1 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? 'bg-emerald-400 h-6 animate-pulse'
                    : counselorState === 'speaking'
                    ? 'bg-cyan-400 h-6 animate-pulse'
                    : counselorState === 'thinking'
                    ? 'bg-amber-400 h-2 animate-pulse'
                    : isMicActive
                    ? 'bg-cyan-400/40 h-2'
                    : 'bg-slate-700 h-1.5'
                }`} />
              </div>
            </div>
          )}

          {/* Right Circular End Button: Positioned on the right */}
          <div className="absolute right-0 flex items-center">
            <button
              type="button"
              onClick={handleEndSessionClick}
              className="w-14 h-14 rounded-full bg-[#E11D48] hover:bg-[#F43F5E] text-white flex flex-col items-center justify-center shadow-[0_0_25px_rgba(225,29,72,0.5)] hover:scale-105 active:scale-95 transition-all duration-200 border-2 border-rose-400/30 cursor-pointer"
              title="End Session"
            >
              <PhoneOff className="w-4 h-4 text-white mb-0.5" />
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-white">End</span>
            </button>
          </div>
        </div>

        {/* Live Status Text underneath */}
        <div className="mt-3 flex items-center justify-center">
          {!counselingInitiated ? (
            <p className="text-xs font-semibold tracking-wider text-cyan-300 uppercase bg-slate-950/80 px-4 py-1.5 rounded-full border border-cyan-500/20 backdrop-blur-md">
              ● Interactive intro — short greeting first, then your turn
            </p>
          ) : !introCompleted ? (
            <p className="text-xs font-semibold tracking-wide text-emerald-300 uppercase bg-emerald-950/80 px-4 py-1.5 rounded-full border border-emerald-500/30 backdrop-blur-md">
              {counselorState === 'speaking' || isTurnPlaying
                ? '● Listen — then reply when she pauses'
                : counselorState === 'thinking'
                  ? '● Preparing next short intro beat...'
                  : currentPhaseInfo?.milestoneName?.toLowerCase().includes('assessment')
                    ? '● Your turn — tell her how the assessment was'
                    : '● Your turn — say Good morning'}
            </p>
          ) : (
            <p
              className={`text-xs font-semibold tracking-wide px-4 py-1.5 rounded-full backdrop-blur-md transition-all duration-300 flex items-center gap-2 ${
                counselorState === 'speaking'
                  ? 'text-cyan-300 bg-cyan-950/80 border border-cyan-500/30 shadow-[0_0_20px_rgba(6,182,212,0.2)]'
                  : counselorState === 'thinking'
                  ? 'text-amber-300 bg-amber-950/80 border border-amber-500/40 shadow-[0_0_25px_rgba(245,158,11,0.3)] animate-pulse'
                  : isUserSpeaking
                  ? 'text-emerald-300 bg-emerald-950/80 border border-emerald-500/40 shadow-[0_0_25px_rgba(16,185,129,0.3)] animate-pulse'
                  : isMicActive
                  ? 'text-cyan-200/90 bg-slate-950/80 border border-cyan-500/20'
                  : 'text-rose-300 bg-rose-950/80 border border-rose-500/30'
              }`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                counselorState === 'speaking'
                  ? 'bg-cyan-400 animate-pulse'
                  : counselorState === 'thinking'
                  ? 'bg-amber-400 animate-spin'
                  : isUserSpeaking
                  ? 'bg-emerald-400 animate-ping'
                  : isMicActive
                  ? 'bg-cyan-400 animate-pulse'
                  : 'bg-rose-500'
              }`} />
              <span>
                {counselorState === 'speaking'
                  ? 'Priya Mam Speaking'
                  : counselorState === 'thinking'
                  ? 'Preparing Answer...'
                  : isUserSpeaking
                  ? 'Listening to You...'
                  : isMicActive
                  ? 'Ready to Speak'
                  : 'Mic Muted'}
              </span>
            </p>
          )}
        </div>

      </div>

    </div>
  );
};

// Clean Alias Export for Future Modular Imports
export const SabcqLiveCounselorAvatar = HeyGenStreamingAvatar;
