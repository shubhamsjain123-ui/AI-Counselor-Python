'use client';

import React from 'react';
import { Database, Zap, Clock, ShieldCheck, Cpu, RefreshCw } from 'lucide-react';

interface SessionStateBadgeProps {
  sessionId: string | null;
  messageCount: number;
  isLiveGemini: boolean;
  ttlRemaining: number;
  isSessionActive: boolean;
  onResetSession: () => void;
  isLoading: boolean;
}

export const SessionStateBadge: React.FC<SessionStateBadgeProps> = ({
  sessionId,
  messageCount,
  isLiveGemini,
  ttlRemaining,
  isSessionActive,
  onResetSession,
  isLoading,
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div className="glass-panel p-5 rounded-2xl border border-indigo-500/20 text-slate-300">
      <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-wide">Stateful Session Inspector</h3>
            <p className="text-xs text-slate-400">Antigravity Stateful Counselor Memory</p>
          </div>
        </div>

        <button
          onClick={onResetSession}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-semibold border border-rose-500/30 transition-all disabled:opacity-50"
          title="Manual Erase Session from Server Memory"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Erase Session
        </button>
      </div>

      {isSessionActive && sessionId ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          {/* Item 1: Report Load Status */}
          <div className="bg-slate-900/60 p-3 rounded-xl border border-emerald-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between text-emerald-400 mb-1">
              <span className="font-medium text-slate-400">Report Status</span>
              <Database className="w-4 h-4" />
            </div>
            <span className="text-sm font-bold text-emerald-300">Loaded ONCE (1x)</span>
            <span className="text-[10px] text-slate-400 mt-1">Session Start hook</span>
          </div>

          {/* Item 2: Follow-up Payload Efficiency */}
          <div className="bg-slate-900/60 p-3 rounded-xl border border-cyan-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between text-cyan-400 mb-1">
              <span className="font-medium text-slate-400">Follow-up Payload</span>
              <Zap className="w-4 h-4" />
            </div>
            <span className="text-sm font-bold text-cyan-300">0 Bytes Report Data</span>
            <span className="text-[10px] text-slate-400 mt-1">{messageCount} follow-up messages sent</span>
          </div>

          {/* Item 3: Memory TTL Timer */}
          <div className="bg-slate-900/60 p-3 rounded-xl border border-indigo-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between text-indigo-400 mb-1">
              <span className="font-medium text-slate-400">Auto-Erase TTL</span>
              <Clock className="w-4 h-4" />
            </div>
            <span className="text-sm font-bold text-indigo-300">{formatTime(ttlRemaining)}</span>
            <span className="text-[10px] text-slate-400 mt-1">15 min inactivity timer</span>
          </div>

          {/* Item 4: AI Model Engine */}
          <div className="bg-slate-900/60 p-3 rounded-xl border border-purple-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between text-purple-400 mb-1">
              <span className="font-medium text-slate-400">AI Engine</span>
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="text-sm font-bold text-purple-300">
              {isLiveGemini ? 'Gemini 1.5 Flash' : 'Smart Stateful Engine'}
            </span>
            <span className="text-[10px] text-slate-400 mt-1">Native Chat Session</span>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-slate-900/80 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
          <span>Session is inactive or erased. Click below to initialize a fresh session with student report.</span>
          <button
            onClick={onResetSession}
            className="px-3 py-1 rounded bg-amber-500 text-slate-950 font-bold hover:bg-amber-400"
          >
            Start Session
          </button>
        </div>
      )}

      {/* Session ID Footer */}
      {sessionId && (
        <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <span>Active Session ID: <strong className="text-indigo-300">{sessionId}</strong></span>
          <span className="text-emerald-400 font-semibold flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            Context Retained in Server Memory
          </span>
        </div>
      )}
    </div>
  );
};
