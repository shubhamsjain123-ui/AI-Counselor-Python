'use client';

import React, { useState, useEffect } from 'react';
import { HeyGenStreamingAvatar } from '@/components/HeyGenStreamingAvatar';
import { Bot, PhoneCall, Play, RefreshCw, UserCheck, Sparkles, ShieldCheck } from 'lucide-react';
import { AI_COUNSELOR_API_BASE } from '@/lib/backend';

const API_BASE_URL = AI_COUNSELOR_API_BASE;

export default function Dashboard() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [counselorState, setCounselorState] = useState<'idle' | 'thinking' | 'speaking'>('idle');
  const [lastResponseText, setLastResponseText] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isCallActive, setIsCallActive] = useState<boolean>(false);
  const [studentName, setStudentName] = useState<string>('aman verma');
  const [preloadedAudio, setPreloadedAudio] = useState<HTMLAudioElement | null>(null);

  // Pre-fetch student session & pre-buffer Neural HD Intro Audio on page load
  useEffect(() => {
    fetch(`${API_BASE_URL}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STD_88492',
        languagePreference: 'hinglish',
      }),
    })
      .then((res) => res.ok && res.json())
      .then((data) => {
        if (data) {
          setSessionId(data.sessionId);
          const name = data.reportLoaded?.studentName || 'Aman Verma';
          setStudentName(name);
          const welcomeText = `Namaste ${name}! Main Priya Sharma, aapki सब सी क्यू (SABCQ) Career Counselor hoon. Aapki report mere paas hai. Aap bina kisi jhijhak ke mujhse apne career options ke baare mein baat kar sakte hain!`;
          setLastResponseText(welcomeText);
        }
      })
      .catch((err) => console.warn('Pre-fetch session context:', err));

    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Direct user-gesture silent session start action (no auto-playing sound on start)
  const startCounselorSession = () => {
    // Session connects silently and waits for user to tap Mic to Speak
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    setIsCallActive(true);
    setCounselorState('idle');
  };

  const handleEndSession = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (sessionId) {
      fetch(`${API_BASE_URL}/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    }
    setSessionId(null);
    setIsCallActive(false);
    setLastResponseText('');
    setCounselorState('idle');
  };

  return (
    <div className="min-h-screen bg-[#060b19] text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-black">
      
      {/* Navbar */}
      <header className="px-6 py-4 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-wide">SABCQ AI Portal</h1>
            <p className="text-xs text-slate-400">{studentName} • Class 12th Commerce</p>
          </div>
        </div>

        {isCallActive && (
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Session Active</span>
          </div>
        )}
      </header>

      {/* Main Stream Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 flex items-center justify-center">
        {isCallActive ? (
          <HeyGenStreamingAvatar
            counselorState={counselorState}
            responseText={lastResponseText}
            isLoading={isLoading}
            onEndSession={handleEndSession}
            studentName={studentName}
          />
        ) : (
          /* Initial Screen 1: Welcome & Start Session */
          <div className="w-full max-w-4xl glass-panel rounded-3xl border border-cyan-500/30 overflow-hidden shadow-[0_0_80px_rgba(6,182,212,0.15)] bg-slate-950/90 flex flex-col md:flex-row">
            
            {/* Left: Counselor Avatar Image Preview */}
            <div className="relative w-full md:w-1/2 min-h-[340px] md:min-h-[440px] bg-slate-900 overflow-hidden flex items-center justify-center">
              <img
                src="/ai_councler.png"
                alt="Priya Sharma - Senior AI Career Counselor"
                className="w-full h-full object-cover object-center filter brightness-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent" />
              
              <div className="absolute bottom-4 left-4 right-4 bg-slate-950/80 backdrop-blur-md p-3 rounded-2xl border border-white/10 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                <div>
                  <h3 className="text-xs font-bold text-white flex items-center gap-1">
                    Priya Sharma <UserCheck className="w-3.5 h-3.5 text-cyan-400" />
                  </h3>
                  <p className="text-[10px] text-slate-300">Senior AI Career Counselor</p>
                </div>
              </div>
            </div>

            {/* Right: Info & Start Session Action */}
            <div className="w-full md:w-1/2 p-6 md:p-8 flex flex-col justify-between space-y-6">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-semibold">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Talk Live with Your AI Mentor.</span>
                </div>
                
                <h2 className="text-2xl font-extrabold text-white tracking-tight leading-snug">
                  Hi {studentName ? (studentName.split(' ')[0].charAt(0).toUpperCase() + studentName.split(' ')[0].slice(1).toLowerCase()) : 'Aman'}! Let's Plan Your Future Together.
                </h2>
                
                <p className="text-xs text-slate-300 leading-relaxed">
                  Talk live with Priya mam, your AI guide! Get instant voice and video advice based on your report to discover your strengths and future path.
                </p>

              </div>

              {/* Start Session Action Button */}
              <button
                onClick={startCounselorSession}
                disabled={isLoading}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-blue-600 via-cyan-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm shadow-[0_0_30px_rgba(6,182,212,0.4)] transition-all hover:scale-[1.02] flex items-center justify-center gap-3 disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    <span>Connecting Session...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 fill-white" />
                    <span>Start Now</span>
                  </>
                )}
              </button>
            </div>

          </div>
        )}
      </main>

    </div>
  );
}
