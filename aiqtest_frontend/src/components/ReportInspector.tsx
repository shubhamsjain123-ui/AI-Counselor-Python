'use client';

import React from 'react';
import { User, Award, AlertTriangle, Lightbulb, CheckCircle2 } from 'lucide-react';

export interface StudentReport {
  studentId: string;
  studentName: string;
  grade: string;
  stream: string;
  assessmentDate: string;
  scores: {
    numericalReasoning: number;
    logicalCoding: number;
    concentration: number;
    memoryRecall: number;
    accountingBookkeeping: number;
    verbalCommunication: number;
  };
  topStrengths: string[];
  weaknesses: string[];
  careerInterests: string[];
  counselorNotes: string;
}

interface ReportInspectorProps {
  report: StudentReport | null;
}

export const ReportInspector: React.FC<ReportInspectorProps> = ({ report }) => {
  if (!report) {
    return (
      <div className="glass-panel p-5 rounded-2xl animate-pulse text-slate-400 text-sm">
        Loading Student Assessment Report...
      </div>
    );
  }

  return (
    <div className="glass-panel p-5 rounded-2xl border border-indigo-500/20 text-slate-300">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center text-white shadow-lg">
            <User className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-wide">{report.studentName}</h3>
            <p className="text-xs text-slate-400">{report.grade} • {report.stream}</p>
          </div>
        </div>
        <span className="px-2.5 py-1 rounded-md text-[11px] font-mono bg-slate-800 text-cyan-300 border border-slate-700">
          ID: {report.studentId}
        </span>
      </div>

      {/* Scores Grid */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
          <Award className="w-3.5 h-3.5 text-indigo-400" />
          SABCQ Assessment Scores
        </h4>

        <div className="space-y-2 text-xs">
          {/* Logical Coding */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="font-medium text-slate-200">Logical Coding & Problem Solving</span>
              <span className="font-bold text-emerald-400">{report.scores.logicalCoding}%</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 rounded-full" style={{ width: `${report.scores.logicalCoding}%` }} />
            </div>
          </div>

          {/* Numerical Reasoning */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="font-medium text-slate-200">Numerical & Math Reasoning</span>
              <span className="font-bold text-cyan-400">{report.scores.numericalReasoning}%</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${report.scores.numericalReasoning}%` }} />
            </div>
          </div>

          {/* Concentration */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="font-medium text-slate-200">Concentration & Focus</span>
              <span className="font-bold text-indigo-400">{report.scores.concentration}%</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${report.scores.concentration}%` }} />
            </div>
          </div>

          {/* Accounting & Bookkeeping (WEAK POINT TO DEMO!) */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="font-medium text-rose-300 flex items-center gap-1">
                Accounting & Ledger Entry (Weak Score)
                <AlertTriangle className="w-3 h-3 text-rose-400 inline" />
              </span>
              <span className="font-bold text-rose-400">{report.scores.accountingBookkeeping}%</span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full" style={{ width: `${report.scores.accountingBookkeeping}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Strengths & Weaknesses */}
      <div className="grid grid-cols-1 gap-3 mb-4 text-xs">
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
          <span className="font-semibold text-emerald-200 flex items-center gap-1 mb-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            Top Key Strengths
          </span>
          <ul className="list-disc list-inside space-y-0.5 text-slate-300 text-[11px]">
            {report.topStrengths.map((st, i) => (
              <li key={i}>{st}</li>
            ))}
          </ul>
        </div>

        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
          <span className="font-semibold text-rose-200 flex items-center gap-1 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            Key Weaknesses / Friction
          </span>
          <ul className="list-disc list-inside space-y-0.5 text-slate-300 text-[11px]">
            {report.weaknesses.map((wk, i) => (
              <li key={i}>{wk}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Counselor Notes */}
      <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs">
        <span className="font-semibold text-indigo-300 flex items-center gap-1 mb-1">
          <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
          Pre-Assessment Counselor Notes
        </span>
        <p className="text-slate-300 text-[11px] leading-relaxed">
          {report.counselorNotes}
        </p>
      </div>
    </div>
  );
};
