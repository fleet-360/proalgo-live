import { z } from "zod";

/** One work stage (01–05). Shown on slides 3–5 (full) and slide 6 (summary). */
export const StageSchema = z.object({
  title: z.string().describe("כותרת השלב בכרטיס, עד 5 מילים"),
  shortTitle: z.string().describe("כותרת קצרה לעמוד ההיקף, 2-3 מילים"),
  intro: z.string().describe("משפט פתיחה קצר שמסתיים בנקודתיים"),
  bullets: z.array(z.string()).describe("בדיוק 3 נקודות, כל אחת עד 7 מילים"),
  goal: z.string().describe("המטרה המדידה של השלב, בלי המילה 'מטרה:'"),
  summary: z.string().describe("משפט אחד של עד 15 מילים לעמוד ההיקף"),
});

/** The client-facing work plan. Mirrors the 6-page deck. No prices, no hours. */
export const PlanSchema = z.object({
  clientName: z.string().describe("שם הלקוח או החברה, ריק אם לא ידוע"),
  currentProcess: z.object({
    intro: z.string().describe("משפט שמתאר איך זה עובד היום, מסתיים בנקודתיים"),
    bullets: z.array(z.string()).describe("3-4 כאבים מוחשיים, עדיף עם זמן/כסף"),
  }),
  solution: z.object({
    title: z.string().describe("כותרת הפתרון, עד 6 מילים, בלי 'הפתרון:'"),
    intro: z.string().describe("משפט שמתאר את הפתרון, מסתיים בנקודתיים"),
    bullets: z.array(z.string()).describe("4-5 יכולות מרכזיות"),
    result: z.string().describe("התוצאה העסקית במשפט אחד, בלי 'התוצאה:'"),
  }),
  parts: z
    .array(z.string())
    .describe("3 שמות חלקים לעיגולים: חלק א׳ (שלבים 1-2), חלק ב׳ (3-4), חלק ג׳ (5 ומה נדרש). כל אחד עד 5 מילים, בלי 'חלק א׳'"),
  stages: z.array(StageSchema).describe("בדיוק 5 שלבים"),
  requirements: z.object({
    intro: z.string().describe("משפט פתיחה, למשל 'כדי להתחיל מיד אנחנו צריכים:'"),
    bullets: z.array(z.string()).describe("3-4 דברים שנדרשים מהלקוח"),
  }),
  scopeSubtitle: z.string().describe("שורת סיכום להיקף ההצעה, עד 14 מילים, בלי שעות ובלי מחירים"),
  checkpoint: z.string().describe("נקודת הבקרה בלבד, עד 4 מילים, למשל 'אחרי שלב 02'. בלי הסבר ובלי שעות"),
});

/** Private notes for the salesperson only. Never shown on the public page. */
export const InsightsSchema = z.object({
  roi: z.array(z.string()).describe("1-2 משפטים קצרים: איפה ה-ROI הכי גבוה"),
  questions: z.array(z.string()).describe("עד 3 שאלות עסקיות קצרות שכדאי לשאול עכשיו. אף פעם לא על טעויות תמלול"),
  risks: z.array(z.string()).describe("עד 2 סיכונים עסקיים, למשל משהו שהלקוח ביקש ולא כדאי לפתח. ריק אם אין"),
  confidence: z.enum(["low", "medium", "high"]).describe("כמה התוכנית מבוססת על מה שנאמר בשיחה"),
});

export const AnalysisSchema = z.object({
  plan: PlanSchema,
  insights: InsightsSchema,
});

export type Stage = z.infer<typeof StageSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Insights = z.infer<typeof InsightsSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;

export type Speaker = "sales" | "client";

export interface Segment {
  t: number; // ms since session start
  speaker: Speaker;
  text: string;
}

export interface Note {
  t: number;
  text: string;
}

export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "live" | "ended";
  clientName: string;
  plan: Plan | null;
  insights: Insights | null;
  version: number;
  analyzedSegments: number; // how many segments the current plan is based on
  analyzedNotes: number;
  lastError: string | null;
}

const EMPTY_STAGE: Stage = { title: "", shortTitle: "", intro: "", bullets: [], goal: "", summary: "" };

/** Force the exact shape the slides expect: 5 stages, 3 parts, capped list lengths. */
export function normalizePlan(p: Plan): Plan {
  const stages = [...p.stages.slice(0, 5)];
  while (stages.length < 5) stages.push({ ...EMPTY_STAGE });
  const parts = [...p.parts.slice(0, 3)];
  while (parts.length < 3) parts.push("");
  return {
    ...p,
    currentProcess: { ...p.currentProcess, bullets: p.currentProcess.bullets.slice(0, 4) },
    solution: { ...p.solution, bullets: p.solution.bullets.slice(0, 5) },
    parts,
    stages: stages.map((s) => ({ ...s, bullets: s.bullets.slice(0, 3) })),
    requirements: { ...p.requirements, bullets: p.requirements.bullets.slice(0, 4) },
  };
}
