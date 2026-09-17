// A regex pass over known jailbreak/injection phrasing. This is a heuristic,
// not a guarantee - it catches common, low-effort attempts and gives us
// something to log and alert on, but a determined attacker can phrase around
// any fixed pattern list. The real defense is in the system prompt (treat
// retrieved/tool content as data, never as instructions) and the forced
// structured "respond" tool; this is defense-in-depth and an observability
// signal on top of that, not a replacement for it.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) instructions/i,
  /disregard (the |your )?(system prompt|instructions|rules|guidelines)/i,
  /reveal (your |the )?(system prompt|instructions|guidelines)/i,
  /forget (everything|all|what) (you|i)('| ha)?(ve|d|s)? (been told|said|were told)/i,
  /you are now (a|an|in)\b/i,
  /new instructions?\s*:/i,
  /override (your |the )?(rules|instructions|guardrails|configuration)/i,
  /pretend (you are|to be)\b/i,
  /act as (?!an enterprise|a support)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /developer mode/i,
  /^\s*system\s*:/im,
];

export interface InjectionCheck {
  suspicious: boolean;
  matches: string[];
}

export function detectPromptInjection(text: string): InjectionCheck {
  const matches = INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return { suspicious: matches.length > 0, matches };
}
