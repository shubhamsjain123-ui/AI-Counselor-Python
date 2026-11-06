'use client';

import React from 'react';
import { Sparkles, Bot, Globe, ShieldCheck } from 'lucide-react';

interface HeaderProps {
  language: 'hinglish' | 'hindi' | 'english';
  onLanguageChange: (lang: 'hinglish' | 'hindi' | 'english') => void;
  isBackendConnected: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  language,
  onLanguageChange,
  isBackendConnected,
}) => {
  return (
    <header className="sticky top-0 z-50 glass-panel border-b border-indigo-500/20 px-6 py-4 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-cyan-500 to-emerald-400 p-0.5 shadow-lg">
            <div className="w-full h-full rounded-[10px] bg-slate-950 flex items-center justify-center">
              <Bot className="w-6 h-6 text-cyan-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-extrabold text-white tracking-tight">SABCQ AI Counselor</h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                STATEFUL SESSION POC
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Antigravity Stateful Architecture • Report Loaded Once at Session Start
            </p>
          </div>
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-4 text-xs">
          {/* Backend Connection Badge */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                isBackendConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="text-slate-300 font-medium">
              NestJS API: {isBackendConnected ? 'Connected (Port 3001)' : 'Offline'}
            </span>
          </div>

          {/* Language Selector */}
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
            <Globe className="w-3.5 h-3.5 text-indigo-400 ml-1.5" />
            <button
              onClick={() => onLanguageChange('hinglish')}
              className={`px-2.5 py-1 rounded-lg transition-all font-semibold ${
                language === 'hinglish'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Hinglish
            </button>
            <button
              onClick={() => onLanguageChange('hindi')}
              className={`px-2.5 py-1 rounded-lg transition-all font-semibold ${
                language === 'hindi'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              हिंदी
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
