'use client';

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { Mic, MicOff, Send, PhoneOff, Sparkles, UserCheck, Wifi, Volume2, Radio } from 'lucide-react';
import { useGeminiLiveVoice } from '../hooks/useGeminiLiveVoice';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'counselor';
  text: string;
  timestamp: Date;
}

interface HumanCounselorRoomProps {
  messages: ChatMessage[];
  onSendMessage: (msg: string) => void;
  isLoading: boolean;
  counselorState: 'idle' | 'thinking' | 'speaking';
  onEndSession: () => void;
  studentName: string;
}

export const HumanCounselorRoom: React.FC<HumanCounselorRoomProps> = ({
  messages,
  onSendMessage,
  isLoading,
  counselorState: propsState,
  onEndSession,
  studentName,
}) => {
  const [inputText, setInputText] = useState('');
  const [mouthOpen, setMouthOpen] = useState(0);
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const [activeVideo, setActiveVideo] = useState<'A' | 'B'>('A');
  const isSwitchingRef = useRef(false);

  // Real-time Gemini Multimodal Live Voice-to-Voice Hook
  const {
    isLiveWsConnected,
    isMicActive,
    counselorState: liveState,
    startMicStream,
    stopMicStream,
    interruptAi,
  } = useGeminiLiveVoice();

  const counselorState = isLiveWsConnected ? liveState : propsState;
  const lastMessage = messages[messages.length - 1];

  // Dual-Video Ping-Pong Crossfade Playback Controller
  useEffect(() => {
    const vidA = videoRefA.current;
    const vidB = videoRefB.current;
    if (!vidA || !vidB) return;

    if (counselorState === 'speaking') {
      const currentVid = activeVideo === 'A' ? vidA : vidB;
      const playPromise = currentVid.play();
      if (playPromise !== undefined) {
        playPromise.catch((error: any) => {
          if (error.name !== 'AbortError') {
            console.error('Video play error:', error);
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
  }, [counselorState, activeVideo]);

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

  // Real-time lip sync animation
  useEffect(() => {
    if (counselorState !== 'speaking') {
      setMouthOpen(0);
      return;
    }

    let frameId: number;
    let time = 0;

    const animateMouth = () => {
      time += 0.15;
      const openRatio = Math.max(0, Math.sin(time * 8) * 0.6 + Math.cos(time * 14) * 0.4);
      setMouthOpen(openRatio);
      frameId = requestAnimationFrame(animateMouth);
    };

    frameId = requestAnimationFrame(animateMouth);
    return () => cancelAnimationFrame(frameId);
  }, [counselorState]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    if (counselorState === 'speaking') {
      interruptAi();
    }
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const toggleSpeechRecognition = async () => {
    if (counselorState === 'speaking') {
      interruptAi();
    }

    if (isMicActive) {
      stopMicStream();
    } else {
      await startMicStream();
    }
  };

  return (
    <div className="relative w-full max-w-5xl mx-auto h-[82vh] rounded-3xl overflow-hidden glass-panel border border-cyan-500/30 shadow-[0_0_100px_rgba(6,182,212,0.25)] flex flex-col justify-between bg-slate-950">
      
      {/* BACKGROUND HUMAN COUNSELOR VIDEO CONTAINER */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        
        {/* Animated Human Portrait Layer */}
        <div
          className={`relative w-full h-full transition-transform duration-700 ${
            counselorState === 'speaking'
              ? 'scale-105 animate-float'
              : counselorState === 'thinking'
              ? 'scale-102 contrast-105'
              : 'scale-100'
          }`}
        >
          <Image
            src="/ai_councler.png"
            alt="Priya Sharma - Live Human AI Career Counselor"
            fill
            className={`object-cover object-center filter brightness-100 contrast-105 transition-opacity duration-300 z-0 ${counselorState === 'speaking' ? 'opacity-0' : 'opacity-100'}`}
            priority
          />
          <video
            ref={videoRefA}
            src="/ai_councloer.mp4"
            muted
            playsInline
            preload="auto"
            className={`absolute inset-0 w-full h-full object-cover object-center filter brightness-100 contrast-105 transition-opacity duration-300 ${
              activeVideo === 'A'
                ? 'z-20 opacity-100'
                : counselorState === 'speaking'
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
            className={`absolute inset-0 w-full h-full object-cover object-center filter brightness-100 contrast-105 transition-opacity duration-300 ${
              activeVideo === 'B'
                ? 'z-20 opacity-100'
                : counselorState === 'speaking'
                ? 'z-10 opacity-100'
                : 'z-0 opacity-0'
            }`}
          />



          {/* Ambient Lighting & Atmosphere Gradient */}
          <div
            className={`absolute inset-0 transition-opacity duration-500 pointer-events-none ${
              counselorState === 'speaking'
                ? 'bg-gradient-to-t from-slate-950 via-cyan-950/10 to-emerald-950/20 opacity-60'
                : 'bg-gradient-to-t from-slate-950 via-slate-950/20 to-slate-950/40 opacity-80'
            }`}
          />
        </div>
      </div>

      {/* TOP HEADER BAR */}
      <div className="relative z-10 p-5 flex items-center justify-between">
        <div className="flex items-center gap-3 bg-slate-950/85 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 shadow-xl">
          <div className="relative flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-emerald-400 animate-ping absolute" />
            <span className="w-3 h-3 rounded-full bg-emerald-400 relative" />
          </div>
          <div>
            <h2 className="text-sm font-extrabold text-white tracking-wide flex items-center gap-1.5">
              Priya Sharma
              <UserCheck className="w-4 h-4 text-cyan-400" />
            </h2>
            <p className="text-[11px] text-slate-300">Senior AI Career Counselor • SABCQ</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold backdrop-blur-md flex items-center gap-1.5 shadow">
            <Wifi className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            HD 1-on-1 Video Session
          </span>

          <button
            onClick={onEndSession}
            className="p-2.5 rounded-2xl bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/30 transition-all backdrop-blur-md"
            title="End Session"
          >
            <PhoneOff className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* CENTER STATUS VISUALIZER */}
      <div className="relative z-10 flex flex-col items-center justify-center p-6 text-center">


        {counselorState === 'thinking' && (
          <div className="flex items-center gap-2 bg-amber-500/20 backdrop-blur-md px-5 py-2.5 rounded-full border border-amber-500/40 text-amber-300 shadow-2xl">
            <Sparkles className="w-4 h-4 animate-spin text-amber-400" />
            <span className="text-xs font-bold tracking-wider uppercase">Evaluating Report Context...</span>
          </div>
        )}
      </div>

      {/* BOTTOM FLOATING VOICE INPUT BAR */}
      <div className="relative z-10 p-6 space-y-4">

        {/* Floating Voice & Chat Input Controls */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center justify-center gap-3 bg-slate-950/90 backdrop-blur-xl p-3 rounded-2xl border border-white/10 max-w-sm mx-auto shadow-2xl"
        >
          {/* Talk with Voice Button */}
          <button
            type="button"
            onClick={toggleSpeechRecognition}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition-all shadow-lg shrink-0 ${
              isMicActive
                ? 'bg-rose-500 text-white animate-pulse shadow-rose-500/50 border border-rose-400'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30'
            }`}
          >
            {isMicActive ? <Radio className="w-4 h-4 text-white animate-spin" /> : <Mic className="w-4 h-4" />}
            <span>{isMicActive ? 'Live Streaming Mic...' : 'Live Voice (Mic)'}</span>
          </button>
        </form>

      </div>

    </div>
  );
};
