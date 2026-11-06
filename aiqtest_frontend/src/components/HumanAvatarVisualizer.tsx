'use client';

import React from 'react';
import { Volume2, VolumeX, Sparkles, Bot, Mic } from 'lucide-react';

interface HumanAvatarProps {
  counselorState: 'idle' | 'thinking' | 'speaking';
  isSpeechEnabled: boolean;
  onToggleSpeech: () => void;
  language: 'hinglish' | 'hindi' | 'english';
}

export const HumanAvatarVisualizer: React.FC<HumanAvatarProps> = ({
  counselorState,
  isSpeechEnabled,
  onToggleSpeech,
  language,
}) => {
  return (
    <div className="relative flex flex-col items-center justify-center p-6 glass-panel rounded-2xl border border-indigo-500/20 shadow-2xl overflow-hidden">
      {/* Background Radial Glow */}
      <div
        className={`absolute inset-0 transition-opacity duration-700 pointer-events-none ${
          counselorState === 'speaking'
            ? 'bg-gradient-to-r from-emerald-500/20 via-cyan-500/20 to-indigo-500/20 opacity-100'
            : counselorState === 'thinking'
            ? 'bg-gradient-to-r from-amber-500/15 via-indigo-500/20 to-purple-500/15 opacity-80'
            : 'bg-gradient-to-r from-indigo-500/10 via-slate-900 to-cyan-500/10 opacity-50'
        }`}
      />

      {/* Counselor Title Header */}
      <div className="relative z-10 flex items-center gap-2 mb-4">
        <span className="px-3 py-1 rounded-full text-xs font-semibold tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
          SABCQ AI CAREER COUNSELOR (HINDI)
        </span>
      </div>

      {/* Main Human-Feel Visualizer Sphere */}
      <div className="relative z-10 my-4 flex items-center justify-center">
        {/* Outer Pulsing Ring */}
        <div
          className={`w-36 h-36 rounded-full flex items-center justify-center transition-all duration-500 ${
            counselorState === 'speaking'
              ? 'animate-avatar-pulse border-2 border-cyan-400/80 shadow-[0_0_50px_rgba(6,182,212,0.6)]'
              : counselorState === 'thinking'
              ? 'animate-spin border-2 border-dashed border-amber-400/70 shadow-[0_0_40px_rgba(245,158,11,0.5)]'
              : 'animate-float border border-indigo-500/40 shadow-[0_0_30px_rgba(99,102,241,0.3)]'
          }`}
        >
          {/* Middle Inner Gradient Sphere */}
          <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-indigo-600 via-cyan-600 to-emerald-400 p-0.5 shadow-inner flex items-center justify-center">
            <div className="w-full h-full rounded-full bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center relative overflow-hidden">
              
              {/* Center Icon / Audio Wave */}
              {counselorState === 'speaking' ? (
                /* Equalizer Wavebars */
                <div className="flex items-center gap-1 h-10 px-2">
                  <div className="w-1.5 bg-cyan-400 rounded-full wave-bar-1" />
                  <div className="w-1.5 bg-emerald-400 rounded-full wave-bar-2" />
                  <div className="w-1.5 bg-indigo-400 rounded-full wave-bar-3" />
                  <div className="w-1.5 bg-purple-400 rounded-full wave-bar-4" />
                  <div className="w-1.5 bg-cyan-300 rounded-full wave-bar-5" />
                </div>
              ) : counselorState === 'thinking' ? (
                <div className="flex flex-col items-center gap-1 text-amber-400 animate-pulse">
                  <Sparkles className="w-8 h-8 animate-bounce" />
                  <span className="text-[10px] uppercase font-bold tracking-widest text-amber-300">Evaluating</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1 text-indigo-300">
                  <Bot className="w-9 h-9 text-cyan-400" />
                  <span className="text-[10px] font-semibold text-slate-400 tracking-wider">ONLINE</span>
                </div>
              )}

            </div>
          </div>
        </div>
      </div>

      {/* Human State Indicator Text */}
      <div className="relative z-10 flex flex-col items-center gap-1 mt-2">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              counselorState === 'speaking'
                ? 'bg-emerald-400 animate-ping'
                : counselorState === 'thinking'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-indigo-400'
            }`}
          />
          <span className="text-sm font-medium text-slate-200 capitalize">
            {counselorState === 'speaking'
              ? 'AI Counselor Speaking...'
              : counselorState === 'thinking'
              ? 'Analyzing Report & Context...'
              : 'Listening & Ready'}
          </span>
        </div>
        <p className="text-xs text-slate-400 text-center max-w-xs">
          {language === 'hindi'
            ? 'हिंदी परामर्शदाता - रिपोर्ट के आधार पर सलाह'
            : 'Conversational Hinglish Counselor for SABCQ'}
        </p>
      </div>

      {/* Bottom Controls */}
      <div className="relative z-10 flex items-center justify-between w-full mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-1.5">
          <Mic className="w-3.5 h-3.5 text-cyan-400" />
          <span>Voice Output</span>
        </div>
        
        <button
          onClick={onToggleSpeech}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg transition-all ${
            isSpeechEnabled
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
              : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
          }`}
          title="Toggle Text-to-Speech Audio Voice"
        >
          {isSpeechEnabled ? (
            <>
              <Volume2 className="w-3.5 h-3.5" />
              <span>Voice ON</span>
            </>
          ) : (
            <>
              <VolumeX className="w-3.5 h-3.5" />
              <span>Voice OFF</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
