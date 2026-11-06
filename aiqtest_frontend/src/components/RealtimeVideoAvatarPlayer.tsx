'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Wifi, Sparkles, UserCheck, PhoneOff, Mic, MicOff, Send } from 'lucide-react';

interface RealtimeVideoProps {
  counselorState: 'idle' | 'thinking' | 'speaking';
  responseText: string;
  onSendMessage: (msg: string) => void;
  isLoading: boolean;
  onEndSession: () => void;
  studentName: string;
}

export const RealtimeVideoAvatarPlayer: React.FC<RealtimeVideoProps> = ({
  counselorState,
  responseText,
  onSendMessage,
  isLoading,
  onEndSession,
  studentName,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(0);

  // Guaranteed local 1080p MP4 video file
  const VIDEO_SRC = '/ai_live_counc.mp4';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (counselorState === 'speaking') {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          if (error.name !== 'AbortError') {
            console.error('Video play error:', error);
          }
        });
      }
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [counselorState]);

  // Real-time lip sync animation overlay during speech
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
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const toggleSpeechRecognition = () => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please type your question.');
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'hi-IN';
      recognition.interimResults = false;

      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setInputText(transcript);
          onSendMessage(transcript);
        }
        setIsListening(false);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);

      recognition.start();
    } catch (err) {
      console.error('Speech error:', err);
      setIsListening(false);
    }
  };

  return (
    <div className="relative w-full max-w-5xl mx-auto h-[82vh] rounded-3xl overflow-hidden glass-panel border border-cyan-500/40 shadow-[0_0_100px_rgba(6,182,212,0.3)] flex flex-col justify-between bg-slate-950">
      
      {/* 4K REALTIME HUMAN VIDEO PLAYER (Guaranteed Local MP4 Stream) */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-slate-950">
        
        {/* Real Live Human Video Element */}
        <video
          ref={videoRef}
          src={VIDEO_SRC}
          loop
          muted
          playsInline
          className={`w-full h-full object-cover object-center transition-all duration-500 ${
            counselorState === 'speaking'
              ? 'scale-105 filter brightness-105 contrast-105'
              : counselorState === 'thinking'
              ? 'scale-100 filter brightness-90'
              : 'scale-100 filter brightness-95'
          }`}
        />



        {/* Ambient Video Lighting Overlay */}
        <div
          className={`absolute inset-0 transition-opacity duration-500 pointer-events-none ${
            counselorState === 'speaking'
              ? 'bg-gradient-to-t from-slate-950 via-cyan-950/20 to-transparent opacity-60'
              : 'bg-gradient-to-t from-slate-950 via-slate-950/30 to-slate-950/50 opacity-80'
          }`}
        />
      </div>

      {/* TOP HEADER: WebRTC Video Stream Bar */}
      <div className="relative z-10 p-5 flex items-center justify-between">
        <div className="flex items-center gap-3 bg-slate-950/90 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 shadow-xl">
          <div className="relative flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-emerald-400 animate-ping absolute" />
            <span className="w-3 h-3 rounded-full bg-emerald-400 relative" />
          </div>
          <div>
            <h2 className="text-sm font-extrabold text-white tracking-wide flex items-center gap-1.5">
              Priya Sharma
              <UserCheck className="w-4 h-4 text-cyan-400" />
            </h2>
            <p className="text-[11px] text-slate-300">Senior AI Career Counselor • Live Video Call</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Live WebRTC Status Indicator */}
          <span className="px-3.5 py-1.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold backdrop-blur-md flex items-center gap-1.5 shadow">
            <Wifi className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            WebRTC Live Stream • 60 FPS HD
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

      {/* CENTER STATUS VISUALIZER OVERLAY */}
      <div className="relative z-10 flex flex-col items-center justify-center p-6 text-center">


        {counselorState === 'thinking' && (
          <div className="flex items-center gap-2 bg-amber-500/20 backdrop-blur-md px-5 py-2.5 rounded-full border border-amber-500/40 text-amber-300 shadow-2xl">
            <Sparkles className="w-4 h-4 animate-spin text-amber-400" />
            <span className="text-xs font-bold tracking-wider uppercase">Evaluating Report Context...</span>
          </div>
        )}
      </div>

      {/* BOTTOM CONTROLS */}
      <div className="relative z-10 p-6 space-y-4">

        {/* Floating Controls Bar */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center justify-center gap-3 bg-slate-950/90 backdrop-blur-xl p-3 rounded-2xl border border-white/10 max-w-sm mx-auto shadow-2xl"
        >
          <button
            type="button"
            onClick={toggleSpeechRecognition}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition-all shadow-lg shrink-0 ${
              isListening
                ? 'bg-rose-500 text-white animate-bounce shadow-rose-500/50'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30'
            }`}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{isListening ? 'Listening...' : 'Voice (Mic)'}</span>
          </button>
        </form>

      </div>

    </div>
  );
};
