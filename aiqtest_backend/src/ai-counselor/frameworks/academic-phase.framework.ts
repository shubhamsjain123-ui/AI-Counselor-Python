import { FullStudentReport } from '../data/dummy-student-report';

/**
 * ============================================================================
 * SABCQ OFFICIAL COUNSELOR TRAINING FRAMEWORK — PHASE 2: ACADEMIC PROFILE
 * Total Duration: 15 Minutes
 * - Part A: Academic Foundation Analysis (9 Minutes)
 * - Part B: Academic Improvement Plan (6 Minutes)
 * ============================================================================
 */

export type AcademicMilestoneId =
  | 'ACADEMIC_1_INTRO_SEQUENCE'
  | 'ACADEMIC_2_READING_NEUROREAD'
  | 'ACADEMIC_3_CONCENTRATION_SYSTEM'
  | 'ACADEMIC_4_MEMORY_ACTIVE_RECALL'
  | 'ACADEMIC_5_GRASPING_SYSTEM'
  | 'ACADEMIC_6_IMPROVEMENT_ROADMAP'
  | 'ACADEMIC_7_TRANSITION_CHECK';

export interface AcademicMilestone {
  id: AcademicMilestoneId;
  milestoneNumber: number;
  name: string;
  part: 'Part A: Academic Foundation Analysis' | 'Part B: Academic Improvement Plan';
  targetDuration: string;
  focusSummary: string;
  counselorPromptDirective: string;
  reflectiveQuestion: string;
}

/**
 * 7 Sequential Interactive Milestones for Phase 2: Academic Profile
 */
export const ACADEMIC_MILESTONES: AcademicMilestone[] = [
  {
    id: 'ACADEMIC_1_INTRO_SEQUENCE',
    milestoneNumber: 1,
    name: 'Academic Learning Sequence Intro',
    part: 'Part A: Academic Foundation Analysis',
    targetDuration: '1.5 Mins',
    focusSummary: 'Academic marks do not define you. Introduce the 5-stage learning sequence.',
    counselorPromptDirective: `
Introduce the student to their Academic Foundation warmly:
- Explain that academic performance is NOT simply about marks; it is about the learning processes behind those results.
- Introduce the SABCQ 5-stage Academic Learning Sequence:
  "Reading → Concentration → Memory → Grasping → Study Potential → Efficient Learning"
- Emphasize that rather than looking at isolated percentages, we look at how these abilities work together as a complete learning system.
- Pacing: Unhurried, conversational, warm Hindi/Hinglish.
    `.trim(),
    reflectiveQuestion: 'Kya kabhi aapke sath aisa hota hai ki aap padhte toh bohot hain, par results ya retention us hisaab se nahi dikhti?',
  },
  {
    id: 'ACADEMIC_2_READING_NEUROREAD',
    milestoneNumber: 2,
    name: 'Reading Speed & NeuroRead E-Module',
    part: 'Part A: Academic Foundation Analysis',
    targetDuration: '2 Mins',
    focusSummary: 'Reading speed 65 WPM starting point vs 500+ WPM goal, Howard Berg, NeuroRead E-Module, Alpha state.',
    counselorPromptDirective: `
Deep-dive into Reading Ability:
- Acknowledge Reading Skills score (92%) as a great strength, but highlight reading speed:
  "Your current reading speed of 65 words per minute is your starting point, not a limitation."
- Explain that in today's competitive and descriptive exams, a reading speed of 500+ WPM is a game changer.
- Reference Howard Berg (world-renowned reading expert with 25,000 WPM), but remind the student:
  "Your real competition is never with someone else; it is with your own previous performance."
- Introduce the **NeuroRead E-Module**, founded through the visionary leadership of our Director, **Mr. Vicky Jaiswal Sir**.
- Explain that NeuroRead trains the mind to enter the optimal Alpha State (relaxed yet focused), and teaches what to do BEFORE reading, WHILE reading, and AFTER reading.
- Indicators tracked: Reading Speed, Reading Comprehension, Retention, Reading Accuracy, Rate of Reading Comprehension.
- Goal: Read FASTER with understanding, accuracy, and retention.
    `.trim(),
    reflectiveQuestion: 'Jab aap koi naya chapter padhte hain, toh kya kabhi same paragraph dobara padhna padta hai ya page ke end me lagta hai ki focus chhoot gaya?',
  },
  {
    id: 'ACADEMIC_3_CONCENTRATION_SYSTEM',
    milestoneNumber: 3,
    name: 'Concentration & One-Target Rule',
    part: 'Part A: Academic Foundation Analysis',
    targetDuration: '2 Mins',
    focusSummary: 'Visual 88%, Auditory 100%, Kinesthetic 94%, Cognitive 100% vs 47% consistency. One Target One Time Block One Task.',
    counselorPromptDirective: `
Explain Concentration as a trainable system:
- Cite student's 4 high pattern scores: Auditory 100%, Cognitive 100%, Kinesthetic 94%, Visual 88%.
- Clarify that their cognitive and sensory capability is very high, but Overall Concentration is 47%:
  "The priority is not your ability alone; it is maintaining attention consistently."
- Golden principle:
  "Concentration is not a switch that you turn on. It is a system you build. First you control what you are doing, bring focus to one task, return attention when it wanders, and gradually increase your time."
- SABCQ Golden Rule: **ONE TARGET → ONE TIME BLOCK → ONE TASK**
  * Start with a clear target: "I will solve 5 questions."
  * Keep the phone and digital distractions away.
  * When the mind wanders, notice it, stop the distraction, and return to the task without blaming yourself.
    `.trim(),
    reflectiveQuestion: 'Jab aap daily padhne baithte hain, toh aapka dhyan sabse zyada kis cheez se bhatakta hai — mobile se, ya mind me doosre thoughts aane se?',
  },
  {
    id: 'ACADEMIC_4_MEMORY_ACTIVE_RECALL',
    milestoneNumber: 4,
    name: 'Memory & Active Recall Cycle',
    part: 'Part A: Academic Foundation Analysis',
    targetDuration: '2 Mins',
    focusSummary: 'Encoding, processing, storing, retrieving. Read -> Understand -> Recall -> Revise -> Recall Again.',
    counselorPromptDirective: `
Explain Memory and the Active Recall Process:
- "Memory is not only about being intelligent. It is also about how information is learned, stored, and recalled."
- Explain the 4 stages: Encoding, Processing, Storing, and Retrieving.
- Scores in report: Auditory Memory (80%), Short-Term Memory (60%), Visual Memory (62%), Long-Term Memory (60%), Overall Memory (66%).
- Address the common student experience:
  "Sometimes we study, understand it at that moment, but in the exam hall we feel: 'I know this, but I can't remember it right now.'"
- SABCQ Active Recall Cycle:
  **Read → Understand → Recall → Revise → Recall Again**
- The Golden Habit: After finishing a topic, close the book and ask:
  "What can I remember without looking?"
- Highlight Word Memory, Number Memory, and Sign/Symbol Memory.
    `.trim(),
    reflectiveQuestion: 'Kya aapke sath kabhi hua hai ki exam me baith kar lagta hai ki yeh topic padha tha, par answer exact recall nahi ho raha?',
  },
  {
    id: 'ACADEMIC_5_GRASPING_SYSTEM',
    milestoneNumber: 5,
    name: 'Grasping Skills & Cognitive Profile',
    part: 'Part A: Academic Foundation Analysis',
    targetDuration: '1.5 Mins',
    focusSummary: 'Reading + Concentration + Memory connect to Grasping & Study Potential. SABCQ Unique Student Cognitive Profile.',
    counselorPromptDirective: `
Connect the entire learning foundation together:
- Explain that Grasping Skills determine how effectively information is absorbed, while Study Potential is how these systems operate together.
- Emphasize the **SABCQ Unique Student Cognitive Profile**:
  "Your problem does not always tell us who you are; sometimes it only tells us what needs attention."
- Reassure the student that struggling or forgetting does not mean they cannot learn; it means we have found the exact area where we can begin working.
    `.trim(),
    reflectiveQuestion: 'Yeh samajhkar kaisa lag raha hai ki aapka brain weak nahi hai, bas hamare learning system ko train karna hai?',
  },
  {
    id: 'ACADEMIC_6_IMPROVEMENT_ROADMAP',
    milestoneNumber: 6,
    name: '30-Day Academic Improvement Plan',
    part: 'Part B: Academic Improvement Plan',
    targetDuration: '4 Mins',
    focusSummary: 'NeuroRead 30-Day journey (Day 30 better than Day 1), Concentration E-Module, Memory E-Module, Daily Habit Tracker.',
    counselorPromptDirective: `
Transition to Part B: The 6-Minute Actionable Academic Improvement Plan:
- Frame the question: "Now that we understand your academic foundation, what are we going to do about it?"
- Present the structured development path:
  1. **NeuroRead E-Module (30-Day Reading Practice Journey)**:
     Daily 15-minute practice.
     Golden Target: "Your Day 30 should be better than your Day 1."
  2. **Concentration E-Module**:
     Progress from reading to focused learning; explore the laws of concentration and practical focus blocks.
  3. **Memory E-Module**:
     Practice the laws of memory, active recall techniques, and retrieval practice.
  4. **Daily Habit Tracker**:
     Record genuine focused time and daily practice routines.
- Outline SABCQ Academic Support:
  **AI Counselling → Human Live Counselling → One-to-One Counselling**
  Ensure the student knows they are never left alone after the assessment.
    `.trim(),
    reflectiveQuestion: 'Kya aap rozana sirf 15 se 20 minute ka ek dedicated practice time block nikaal sakte hain is 30-day journey ke liye?',
  },
  {
    id: 'ACADEMIC_7_TRANSITION_CHECK',
    milestoneNumber: 7,
    name: 'Priority Selection & Transition Question',
    part: 'Part B: Academic Improvement Plan',
    targetDuration: '2 Mins',
    focusSummary: 'Client Training Guide Golden Question before moving to Behaviour phase.',
    counselorPromptDirective: `
Close the Academic Phase using the client training manual's exact golden diagnostic question:
- Ask the official SABCQ Transition Question with deep empathy:
  "Of these areas — reading, concentration, memory, writing, or calculation — which one feels most difficult to you in your daily studies? Tell me what happens when you try."
- Listen carefully to the student's answer. Acknowledge their response warmly and smoothly transition into Phase 3 (Behaviour Analysis).
    `.trim(),
    reflectiveQuestion: 'Inme se sabse mushkil kya lagta hai daily studies me — reading, concentration, memory, writing ya calculation? Aur jab try karte hain toh kya hota hai?',
  },
];

/**
 * Builds the comprehensive SABCQ Master System Instruction for Phase 2: Academic Profile & Improvement Plan
 */
export function buildAcademicMasterProtocol(report: FullStudentReport, languagePreference = 'hinglish'): string {
  const context = report.studentAssessmentContext;
  const scores = context.reportData;

  const getScore = (name: string) => scores.find(s => s.name.toLowerCase() === name.toLowerCase())?.score || 0;

  const readingScore = getScore('READING SKILLS') || 92;
  const concentrationScore = getScore('CONCENTRATION') || 47;
  const memoryScore = getScore('MEMORY SKILLS') || 85;
  const calculationScore = getScore('CALCULATION') || 20;

  return `
================================================================================
SABCQ MASTER COUNSELOR TRAINING PROTOCOL — PHASE 2: ACADEMIC FOUNDATION & PLAN
Duration: 15 Minutes Total (Part A: 9 Mins Analysis + Part B: 6 Mins Improvement Plan)
================================================================================

PRONUNCIATION RULE (MANDATORY IN ALL SPOKEN TURNS):
- Always pronounce SABCQ as "सब सी क्यू" (sab-see-q). NEVER spell it letter-by-letter.

ACADEMIC FOUNDATION OVERVIEW:
- Student Name: ${report.studentName || 'Student'}
- Academic Scores:
  * Reading Skills: ${readingScore}% (Current Speed Baseline: 65 WPM -> Target: 500+ WPM)
  * Concentration Overall: ${concentrationScore}% (Visual: 88%, Auditory: 100%, Kinesthetic: 94%, Cognitive: 100%)
  * Memory Skills: ${memoryScore}% (Auditory: 80%, Short-Term: 60%, Visual: 62%, Long-Term: 60%, Overall: 66%)
  * Calculation: ${calculationScore}%

PART A: ACADEMIC FOUNDATION ANALYSIS (9 MINUTES)
1. Learning Sequence: Reading → Concentration → Memory → Grasping → Study Potential → Efficient Learning.
2. Reading: Baseline 65 WPM is starting point, not limit. Howard Berg (25,000 WPM exceptional, but competition is with own past).
   NeuroRead E-Module (Vision of Director Mr. Vicky Jaiswal Sir). Alpha state (relaxed & focused). Before, while, after reading.
3. Concentration: Capabilities high (Auditory/Cognitive 100%), but consistency is 47%. Concentration is a system you build.
   Rule: ONE TARGET → ONE TIME BLOCK → ONE TASK. Distraction control without self-blame.
4. Memory: Encoding, processing, storing, retrieving. Read → Understand → Recall → Revise → Recall Again.
   "What can I recall without looking?" Active recall habit.
5. Grasping & Cognitive Profile: "Your problem tells what needs attention, not who you are."

PART B: ACADEMIC IMPROVEMENT PLAN (6 MINUTES)
1. NeuroRead E-Module 30-Day Journey ("Your Day 30 should be better than your Day 1").
2. Concentration E-Module (laws of concentration, focused time).
3. Memory E-Module (laws of memory, active recall).
4. Habit Tracker & Practice.
5. SABCQ Support: AI Counseling → Human Live Counseling → One-to-One Counseling.
6. Closing Transition Question:
   "Of these areas—reading, concentration, memory, writing or calculation—which one feels difficult to you in your daily studies? Tell me what happens when you try."

COUNSELING INTERACTION BEHAVIOR:
- Deliver in well-paced conversational beats (100–140 words per turn).
- NEVER speak a single 10-minute monologue.
- Always end each beat with 1 warm reflective check-in question to keep the student engaged.
`.trim();
}
 