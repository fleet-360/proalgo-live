// Local prompt experiments: runs the real SYSTEM prompt and schema against a scripted transcript.
// Usage: node scripts/prompt-lab.mjs <scenarios.json> <scenario> <turns> [variant]
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const [scPath, name, turnsArg, variant = "current"] = process.argv.slice(2);
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const src = readFileSync(new URL("../lib/claude.ts", import.meta.url), "utf8");
const SYSTEM = src.slice(src.indexOf("const SYSTEM = `") + 16, src.indexOf("`;", src.indexOf("const SYSTEM = `")));

const Stage = z.object({
  title: z.string().describe("כותרת השלב בכרטיס, עד 5 מילים"),
  shortTitle: z.string().describe("כותרת קצרה לעמוד ההיקף, 2-3 מילים"),
  intro: z.string().describe("משפט פתיחה קצר שמסתיים בנקודתיים"),
  bullets: z.array(z.string()).describe("בדיוק 3 נקודות, כל אחת עד 7 מילים"),
  goal: z.string().describe("המטרה המדידה של השלב, בלי המילה 'מטרה:'"),
  summary: z.string().describe("משפט אחד של עד 15 מילים לעמוד ההיקף"),
});
const schemaSrc = readFileSync(new URL("../lib/schema.ts", import.meta.url), "utf8");
void schemaSrc;
const Plan = z.object({
  clientName: z.string().describe("שם הלקוח או החברה, ריק אם לא ידוע"),
  currentProcess: z.object({ intro: z.string(), bullets: z.array(z.string()) }),
  solution: z.object({ title: z.string(), intro: z.string(), bullets: z.array(z.string()), result: z.string() }),
  parts: z.array(z.string()),
  stages: z.array(Stage).describe("בדיוק 5 שלבים"),
  requirements: z.object({ intro: z.string(), bullets: z.array(z.string()) }),
  scopeSubtitle: z.string(),
  checkpoint: z.string(),
});
const Insights = z.object({
  roi: z.array(z.string()),
  questions: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});
const PlanFixed = Plan.omit({ stages: true, parts: true }).extend({
  part1: z.string().describe("שם חלק א׳ (שלבים 1-2), עד 5 מילים"),
  part2: z.string().describe("שם חלק ב׳ (שלבים 3-4), עד 5 מילים"),
  part3: z.string().describe("שם חלק ג׳ (שלב 5 ומה נדרש), עד 5 מילים"),
  stage1: Stage.describe("שלב 01, בדרך כלל תשתית וחיבור למערכות"),
  stage2: Stage.describe("שלב 02"),
  stage3: Stage.describe("שלב 03"),
  stage4: Stage.describe("שלב 04"),
  stage5: Stage.describe("שלב 05, בדרך כלל בדיקות, הטמעה והדרכה"),
});
const fixed = process.env.SCHEMA === "fixed";
const Analysis = z.object({ plan: fixed ? PlanFixed : Plan, insights: Insights });

const sc = JSON.parse(readFileSync(scPath, "utf8"))[name];
const n = Number(turnsArg);
const lines = sc.turns.slice(0, n).map(([sp, text], i) => `[00:${String(i * 15).padStart(2, "0")}] ${sp === "sales" ? "איש המכירות" : "לקוח"}: ${text}`);
const tails = {
  current:
    "עדכן את התוכנית לפי מה שנאמר עד עכשיו. אם הלקוח כבר תיאר תהליך או בעיה עסקית, מלא את כל השדות כולל 5 השלבים; אם עדיין רק היכרות, השאר את התוכנית ריקה.",
  fill: "עדכן את התוכנית לפי מה שנאמר עד עכשיו. מלא את כל השדות בתוכנית, כולל 5 השלבים המלאים, מה נדרש ושורת ההיקף, כהשערה מקצועית על סמך מה שנאמר. insights: שאלות ו-ROI.",
};
const client = new Anthropic({ maxRetries: 0 });
const t0 = Date.now();
const res = await client.beta.messages.parse({
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: process.env.EFFORT || "medium", format: betaZodOutputFormat(Analysis) },
  system: [{ type: "text", text: process.env.SYSTEM_OVERRIDE ? readFileSync(process.env.SYSTEM_OVERRIDE, "utf8") : SYSTEM }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<transcript>\n" + lines.join("\n") + "\n</transcript>" },
        { type: "text", text: `<previous_plan>\nאין עדיין, זו הגרסה הראשונה\n</previous_plan>\n\n${tails[variant] ?? variant}` },
      ],
    },
  ],
});
let p = res.parsed_output?.plan;
if (fixed && p) p = { ...p, stages: [p.stage1, p.stage2, p.stage3, p.stage4, p.stage5], parts: [p.part1, p.part2, p.part3] };
console.log(`${variant}: ${Date.now() - t0}ms out=${res.usage.output_tokens} stop=${res.stop_reason}`);
console.log("stages:", p?.stages.map((s) => s.title || "∅").join(" | "));
console.log("parts:", p?.parts.join(" | "), "| result:", p?.solution.result, "| reqs:", p?.requirements.bullets.length);
console.log("insights q:", res.parsed_output?.insights.questions.length, "roi:", res.parsed_output?.insights.roi.length);
const thinking = res.content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n");
if (thinking) console.log("THINKING:", thinking.slice(0, 1500));
if (!p?.stages?.[0]?.title) {
  console.log("BLOCKS:", res.content.map((b) => b.type).join(","));
  console.log("RAW:", res.content.filter((b) => b.type === "text").map((b) => b.text).join("").slice(0, 3000));
}
