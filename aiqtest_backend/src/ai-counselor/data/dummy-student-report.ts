export interface ReportDataItem {
  name: string;
  section: string;
  score: number;
  category?: string;
}

export interface TestReportItem {
  name: string;
  score: number;
  wordsLength?: number;
  timeTaken?: number;
}

export interface AIUsageGuidelines {
  useReportAsPrimaryStudentContext: boolean;
  personalizeAnswersUsingScores: boolean;
  useConversationHistoryForFollowUps: boolean;
  doNotAskStudentToRepeatReportData: boolean;
  doNotTreatScoresAsAbsoluteCareerDecisions: boolean;
  explainRecommendationsUsingRelevantReportFactors: boolean;
}

export interface StudentAssessmentContext {
  purpose: string;
  reportData: ReportDataItem[];
  testReport: TestReportItem[];
  aiUsageGuidelines: AIUsageGuidelines;
}

export interface FullStudentReport {
  studentId: string;
  studentName: string;
  grade?: string;
  stream?: string;
  assessmentDate?: string;
  studentAssessmentContext: StudentAssessmentContext;
}

export const DUMMY_STUDENT_REPORT: FullStudentReport = {
  studentId: "STD_88492",
  studentName: "aman verma",
  grade: "11th Standard",
  stream: "Commerce   ",
  assessmentDate: "2026-09-20",
  studentAssessmentContext: {
    purpose: "Provide the AI Counselor with the student's existing assessment/report data for personalized career guidance.",
    reportData: [
      { name: "INTRODUCTION", section: "COUNSELLING", score: 20 },
      { name: "MANAGEMENT", section: "CAREER OPTION", score: 57, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "HUMANITY AND ARTS", section: "INTEREST", score: 35, category: "HUMANITY" },
      { name: "ENGINEERING", section: "CAREER OPTION", score: 20, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "DOCTOR AND PHARMACEUTICAL", section: "CAREER OPTION", score: 28, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "LAW PUBLIC AND POLITICAL AFFAIRS", section: "CAREER OPTION", score: 75 },
      { name: "CRITICAL THINKER", section: "THINKING STYLE", score: 28 },
      { name: "BUSINESS APPROACH THINKER", section: "THINKING STYLE", score: 59 },
      { name: "EMOTIONAL THINKER", section: "THINKING STYLE", score: 44 },
      { name: "POSITIVE THINKER", section: "THINKING STYLE", score: 50 },
      { name: "NEGATIVE THINKER", section: "THINKING STYLE", score: 75 },
      { name: "SCIENTIFIC THINKER", section: "THINKING STYLE", score: 28 },
      { name: "VISUAL LEARNING", section: "LEARNING STYLE", score: 32 },
      { name: "READ AND UNDERSTAND LEARNING", section: "LEARNING STYLE", score: 55 },
      { name: "KINAESTHETIC LEARNING", section: "LEARNING STYLE", score: 50 },
      { name: "INTELLIGENCE QUOTIENT", section: "MULTIPLE INTELLIGENCE QUOTIENT", score: 23 },
      { name: "EMOTIONAL QUOTIENT", section: "MULTIPLE INTELLIGENCE QUETIONT", score: 32 },
      { name: "COGNITIVE QUOTIENT", section: "MULTIPLE INTELLIGENCE QUETIONT", score: 27 },
      { name: "VISIONARY QUOTIENT", section: "MULTIPLE INTELLIGENCE QUOTIENT", score: 54 },
      { name: "ADVERSITY QUOTIENT", section: "MULTIPLE INTELLIGENCE QUOTIENT", score: 54 },
      { name: "PROBLEM SOLVING", section: "LOGIC AND RESEARCH", score: 30 },
      { name: "INNOVATIVE SKILLS", section: "LOGIC AND RESEARCH", score: 29 },
      { name: "OBSERVATION SKILLS", section: "LOGIC AND RESEARCH", score: 44 },
      { name: "ANALYTICAL SKILLS", section: "LOGIC AND RESEARCH", score: 50 },
      { name: "RESEARCH SKILLS", section: "LOGIC AND RESEARCH", score: 24 },
      { name: "DECISION MAKING SKILLS", section: "LOGIC AND RESEARCH", score: 21 },
      { name: "MEMORY SKILLS", section: "ACADEMIC SKILLS", score: 66 },
      { name: "CONCENTRATION", section: "ACADEMIC SKILLS", score: 47 },
      { name: "READING SKILLS", section: "ACADEMIC SKILLS", score: 92 },
      { name: "VISUAL CONCENTRATION", section: "ACADEMIC SKILLS", score: 88 },
      { name: "AUDITORY CONCENTRATION", section: "ACADEMIC SKILLS", score: 100 },
      { name: "KINAESTHETIC CONCENTRATION", section: "ACADEMIC SKILLS", score: 94 },
      { name: "COGNITIVE CONCENTRATION", section: "ACADEMIC SKILLS", score: 100 },
      { name: "OVERALL CONCENTRATION", section: "ACADEMIC SKILLS", score: 47 },
      { name: "GRASPING SKILLS", section: "ACADEMIC SKILLS", score: 72 },
      { name: "STUDY POTENTIAL", section: "ACADEMIC SKILLS", score: 68 },
      { name: "TIME MANAGEMENT", section: "MANAGEMENT", score: 20 },
      { name: "LEADERSHIP SKILLS", section: "MANAGEMENT", score: 51 },
      { name: "MANAGERIAL SKILLS", section: "MANAGEMENT", score: 22 },
      { name: "PROCRASTINATION", section: "BEHAVIOUR ANALYSIS", score: 78 },
      { name: "SELF MOTIVATION", section: "BEHAVIOUR ANALYSIS", score: 63 },
      { name: "KNOWLEDGE", section: "BEHAVIOUR ANALYSIS", score: 47 },
      { name: "COMMUNICATION SKILLS", section: "ACADEMIC SKILLS", score: 49 },
      { name: "DOUBT", section: "BEHAVIOUR ANALYSIS", score: 30 },
      { name: "CONFIDENCE", section: "BEHAVIOUR ANALYSIS", score: 57 },
      { name: "FEAR FACTOR", section: "BEHAVIOUR ANALYSIS", score: 63 },
      { name: "TARGET ON WORK", section: "BEHAVIOUR ANALYSIS", score: 88 },
      { name: "AVAIL THE BENEFIT OF SITUATION", section: "BEHAVIOUR ANALYSIS", score: 63 },
      { name: "OPPORTUNITY CONVERSION", section: "BEHAVIOUR ANALYSIS", score: 75 },
      { name: "TECHNOLOGY", section: "DISCOVERY SCIENCE", score: 20 },
      { name: "CHEMISTRY", section: "CAREER OPTION", score: 20, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "WRITING SKILLS", section: "ACADEMIC SKILLS", score: 38 },
      { name: "VISUAL PERCEPTION", section: "BEHAVIOUR ANALYSIS", score: 25 },
      { name: "SPORTS", section: "INTEREST", score: 75, category: "HUMANITY" },
      { name: "COMPETITIVE APPROACH", section: "BEHAVIOUR ANALYSIS", score: 66 },
      { name: "CONVINCING SKILLS", section: "BEHAVIOUR ANALYSIS", score: 36 },
      { name: "CONFUSION", section: "BEHAVIOUR ANALYSIS", score: 50 },
      { name: "CREATIVE PERSONALITY", section: "PERSONALITY TYPE", score: 84 },
      { name: "LOGICAL PERSONALITY", section: "PERSONALITY TYPE", score: 67 },
      { name: "MASS AND MEDIA COMMUNICATION", section: "CAREER OPTION", score: 54, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "EDUCATION AND TRAINING", section: "CAREER OPTION", score: 47, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "BANKING AND FINANCE", section: "CAREER OPTION", score: 38, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "CREATIVE SKILLS", section: "BEHAVIOUR ANALYSIS", score: 28 },
      { name: "ENTERTAINMENT AND RECREATION", section: "INTEREST", score: 100, category: "HUMANITY" },
      { name: "EDUCATION AND GUIDANCE", section: "INTEREST", score: 75, category: "HUMANITY" },
      { name: "PHYSICS", section: "CAREER OPTION", score: 33, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "DESIGNING", section: "CAREER OPTION", score: 38, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "BUSINESS", section: "CAREER OPTION", score: 68, category: "PSYCHOLOGY TOWARDS CAREER" },
      { name: "CALCULATION", section: "ACADEMIC SKILLS", score: 20 },
      { name: "MUSIC AND DANCE", section: "INTEREST", score: 20, category: "HUMANITY" },
      { name: "ACTING & DRAMA", section: "INTEREST", score: 40, category: "HUMANITY" },
      { name: "AUDITORY LEARNING", section: "LEARNING STYLE", score: 50 },
      { name: "FRONTAL LOBE", section: "BRAIN LOBES", score: 38 },
      { name: "PARIETAL LOBE", section: "BRAIN LOBES", score: 46 },
      { name: "OCCIPITAL LOBE", section: "BRAIN LOBES", score: 32 },
      { name: "TEMPORAL LOBE", section: "BRAIN LOBES", score: 28 },
      { name: "CONCLUSION", section: "COUNSELLING", score: 20 },
      { name: "ACCEPTANCE OF CHALLENGES", section: "BEHAVIOUR ANALYSIS", score: 100 },
      { name: "VISUAL MEMORY", section: "ACADEMIC SKILLS", score: 62 },
      { name: "AUDITORY MEMORY", section: "ACADEMIC SKILLS", score: 80 },
      { name: "SHORT TERM MEMORY", section: "ACADEMIC SKILLS", score: 60 },
      { name: "LONG TERM MEMORY", section: "ACADEMIC SKILLS", score: 60 },
      { name: "PRACTICAL MEMORY", section: "ACADEMIC SKILLS", score: 50 },
      { name: "SINCERITY", section: "HUMAN BEHAVIOUR", score: 100 },
      { name: "INQUISITIVENESS", section: "HUMAN BEHAVIOUR", score: 56 },
      { name: "DILIGENCE", section: "HUMAN BEHAVIOUR", score: 53 },
      { name: "DEPENDENCE", section: "HUMAN BEHAVIOUR", score: 50 },
      { name: "SUPPORTIVE", section: "HUMAN BEHAVIOUR", score: 100 },
      { name: "EXTRAVERSION", section: "HUMAN BEHAVIOUR", score: 45 },
      { name: "NEUROTICISM", section: "HUMAN BEHAVIOUR", score: 71 },
      { name: "AMIABLE", section: "HUMAN BEHAVIOUR", score: 56 },
      { name: "RISK TAKER", section: "HUMAN BEHAVIOUR", score: 75 },
      { name: "INTERACTIVE", section: "HUMAN BEHAVIOUR", score: 68 },
      { name: "HESITATION", section: "HUMAN BEHAVIOUR", score: 58 },
      { name: "PARTICIPATION", section: "HUMAN BEHAVIOUR", score: 30 },
      { name: "DISCIPLINE", section: "HUMAN BEHAVIOUR", score: 70 },
      { name: "Limbic", section: "BRAIN LOBES", score: 20 },
      { name: "RETENTION", section: "ACADEMIC SKILLS", score: 20 },
      { name: "READING COMPREHENSION", section: "ACADEMIC SKILLS", score: 71 },
      { name: "LOGIC AND RESEARCH", section: "LOGIC AND RESEARCH", score: 100 }
    ],
    testReport: [
      { name: "NumberTest", score: 60 },
      { name: "WordTest", score: 0 },
      { name: "SignTest", score: 40 },
      { name: "calculationTest", score: 20 },
      { name: "imageTest", score: 80 },
      { name: "readingSpeed", score: 65, wordsLength: 65, timeTaken: 1.0 },
      { name: "passageTest", score: 71 },
      { name: "readingSkill", score: 92 },
      { name: "memory", score: 66 },
      { name: "audioTest", score: 80 },
      { name: "videoScore", score: 25 },
      { name: "concentration", score: 47 }
    ],
    aiUsageGuidelines: {
      useReportAsPrimaryStudentContext: true,
      personalizeAnswersUsingScores: true,
      useConversationHistoryForFollowUps: true,
      doNotAskStudentToRepeatReportData: true,
      doNotTreatScoresAsAbsoluteCareerDecisions: true,
      explainRecommendationsUsingRelevantReportFactors: true
    }
  }
};
