/**
 * Phase-1 intro beats (exact Gemini speech → MuseTalk lip-sync).
 *
 * Flow:
 *  1) Session start → Beat 1 "Good morning" → MuseTalk video
 *  2) Student greets → Beat 2 assessment-day question → MuseTalk video
 *  3) Student answers → Beat 3 short SABCQ intro (~35–50s) → MuseTalk video → Phase 2
 *
 * Beat 3 `speechChunks` are OPTIONAL (INTRO_TTS_MODE=chunks). Free-tier default is
 * INTRO_TTS_MODE=single → one Flash TTS call; MuseTalk still uses stream slices.
 * speechChunks kept for optional spaced multi-TTS / legacy chunked MuseTalk batch.
 */

export type IntroBeatId = 1 | 2 | 3;

export const INTRO_BEAT_META: Record<
  IntroBeatId,
  {
    id: IntroBeatId;
    label: string;
    targetDuration: string;
    spokenText: string;
    /** Optional MuseTalk-safe chunks (joined with a soft breath pause). */
    speechChunks?: string[];
  }
> = {
  1: {
    id: 1,
    label: 'Greeting — your turn (say Good morning)',
    targetDuration: '~6 sec',
    spokenText: 'Good morning... I hope you are doing well today.',
  },
  2: {
    id: 2,
    label: 'Assessment check-in — your turn',
    targetDuration: '~5 sec',
    spokenText: 'How was your assessment day?',
  },
  3: {
    id: 3,
    label: 'Welcome philosophy (35–50 sec)',
    targetDuration: '35–50 sec',
    spokenText:
      'Thank you for sharing that... Every student has a unique pattern of learning, thinking, behaviour, skills, and growth. ' +
      'Sab see q is here to understand your pattern, and give you a personal growth roadmap. ' +
      'Remember... your percentage does not define you. It only shows where you are today. ' +
      'We grow through five phases: Skill Improvement, Academic Performance, Behavior Analysis, Career Guidance, and Quality of Life. ' +
      'Your report is not the destination... it is the starting point. ' +
      'So let us begin with one simple question... What can I become?',
    // Optional multi-TTS (INTRO_TTS_MODE=chunks + INTRO_TTS_CHUNK_GAP_MS). Default path ignores these.
    speechChunks: [
      'Thank you for sharing that... Every student has a unique pattern of learning, thinking, behaviour, skills, and growth.',
      'Sab see q is here to understand your pattern, and give you a personal growth roadmap.',
      'Remember... your percentage does not define you. It only shows where you are today.',
      'We grow through five phases: Skill Improvement, Academic Performance, Behavior Analysis, Career Guidance, and Quality of Life.',
      'Your report is not the destination... it is the starting point. So let us begin with one simple question... What can I become?',
    ],
  },
};

/** @deprecated Live prompts — native audio ignores them; kept for reference only. */
export function buildGeminiIntroBeatPrompt(beatId: IntroBeatId): string {
  return `Speak exactly: ${INTRO_BEAT_META[beatId].spokenText}`;
}
