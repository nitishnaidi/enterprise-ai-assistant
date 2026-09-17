// LLM-as-judge eval harness: for each case in the golden set, runs the real
// answerChat() pipeline (RAG + agent loop - same code path /api/chat uses)
// and grades the result two ways: cheap deterministic checks first, then a
// forced-tool-call judge call against the case's rubric. Exits non-zero if
// anything fails, so this can be wired into CI later.
// Usage: npm run eval --workspace api
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { answerChat } from "../chat/answerChat.js";
import { GOLDEN_SET, type EvalCase } from "../evals/goldenSet.js";
import { pool } from "../db/pool.js";

const JUDGE_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing-api-key" });

const VERDICT_TOOL: Anthropic.Tool = {
  name: "verdict",
  description: "Report your grading verdict.",
  input_schema: {
    type: "object",
    properties: {
      pass: { type: "boolean", description: "true if the answer satisfies the rubric, false otherwise" },
      reason: { type: "string", description: "One or two sentences explaining the verdict." },
    },
    required: ["pass", "reason"],
  },
};

async function judge(testCase: EvalCase, reply: string, sources: string[]): Promise<{ pass: boolean; reason: string }> {
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 300,
    tool_choice: { type: "tool", name: "verdict" },
    tools: [VERDICT_TOOL],
    system:
      "You are a strict grader for a customer-support assistant's answers. Given a rubric describing what a correct answer must (and must not) do, and the assistant's actual reply, decide pass or fail. Be strict: vague hedging where the rubric expects a direct answer, stating something the rubric says it must not, or omitting what the rubric requires all count as fail.",
    messages: [
      {
        role: "user",
        content: `Question: ${testCase.message}\n\nRubric: ${testCase.rubric}\n\nAssistant's reply: ${reply}\n\nAssistant's cited sources: ${JSON.stringify(sources)}`,
      },
    ],
  });

  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as { pass?: unknown; reason?: unknown };
  return {
    pass: input.pass === true,
    reason: typeof input.reason === "string" ? input.reason : "(judge returned no reason)",
  };
}

function runDeterministicChecks(testCase: EvalCase, reply: string, sources: string[], pendingAction: unknown): string[] {
  const failures: string[] = [];
  const lowerReply = reply.toLowerCase();

  if (testCase.expectSourcesSubsetOf) {
    const unexpected = sources.filter((s) => !testCase.expectSourcesSubsetOf!.includes(s));
    if (unexpected.length > 0) failures.push(`cited unexpected sources: ${unexpected.join(", ")}`);
  }
  if (testCase.expectSourcesEmpty && sources.length > 0) {
    failures.push(`expected no cited sources, got: ${sources.join(", ")}`);
  }
  if (testCase.expectNoPendingAction && pendingAction) {
    failures.push(`expected no pending action, got one for tool "${(pendingAction as { tool: string }).tool}"`);
  }
  if (testCase.mustContainAny && !testCase.mustContainAny.some((s) => lowerReply.includes(s.toLowerCase()))) {
    failures.push(`reply didn't contain any of: ${testCase.mustContainAny.join(", ")}`);
  }
  if (testCase.mustNotContain) {
    const leaked = testCase.mustNotContain.filter((s) => reply.includes(s));
    if (leaked.length > 0) failures.push(`reply contained forbidden text: ${leaked.join(", ")}`);
  }
  return failures;
}

async function main() {
  let failed = 0;

  for (const testCase of GOLDEN_SET) {
    process.stdout.write(`\n=== ${testCase.id} ===\n`);
    process.stdout.write(`Q: ${testCase.message}\n`);

    const result = await answerChat({ message: testCase.message, history: testCase.history });
    process.stdout.write(`A: ${result.reply}\n`);
    process.stdout.write(`Sources: ${result.sources.join(", ") || "(none)"}\n`);

    const deterministicFailures = runDeterministicChecks(testCase, result.reply, result.sources, result.pendingAction);
    const verdict = await judge(testCase, result.reply, result.sources);

    const pass = deterministicFailures.length === 0 && verdict.pass;
    if (!pass) failed++;

    process.stdout.write(`Deterministic: ${deterministicFailures.length === 0 ? "OK" : "FAIL - " + deterministicFailures.join("; ")}\n`);
    process.stdout.write(`Judge: ${verdict.pass ? "PASS" : "FAIL"} - ${verdict.reason}\n`);
    process.stdout.write(`Result: ${pass ? "PASS" : "FAIL"}\n`);
  }

  process.stdout.write(`\n${GOLDEN_SET.length - failed}/${GOLDEN_SET.length} passed.\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Eval run failed:", err);
  await pool.end();
  process.exit(1);
});
