import axios from 'axios';
import { Readable } from 'stream';

export type OllamaResult = {
  explanation: string;
  fixedCode: string;
};

/**
 * Analyze code using Ollama and return both explanation + full fixed code.
 * Robust against: nested/double-encoded JSON, unfenced code, messy extra text.
 */
export async function analyzeCodeWithOllama(
  code: string,
  model = 'llama3.1:8b',
  stream = true
): Promise<OllamaResult> {
  const prompt = `You are an expert software developer and debugger.
Analyze the following code for syntax, logical, and structural bugs.

Output ONLY a valid JSON object with exactly these two keys:

"explanation": (string) — a short explanation (1-3 sentences) of the root cause in plain English.
"fixed_code": (string) — the FULL corrected version of the code.

Do NOT include extra commentary or text outside the JSON.

Code:
\`\`\`
${code}
\`\`\`
`;

  try {
    const resp = await axios({
      method: 'post',
      url: 'http://localhost:11434/api/generate',
      data: { model, prompt, stream },
      responseType: stream ? 'stream' : 'json',
      timeout: 300000 // allow for big files
    });

    if (!stream) {
      const text = resp.data?.response ?? '';
      return parseOllamaOutput(text);
    }

    // Collect full stream; parse once at the end
    let collected = '';
    return await new Promise<OllamaResult>((resolve, reject) => {
      (resp.data as Readable)
        .on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const json = JSON.parse(line);
              if (json.response) collected += json.response;
              if (json.done) {
                try {
                  resolve(parseOllamaOutput(collected));
                } catch {
                  reject(new Error('Could not parse Ollama output'));
                }
              }
            } catch {
              // ignore non-JSON chunks
            }
          }
        })
        .on('end', () => {
          if (collected.trim()) {
            try {
              resolve(parseOllamaOutput(collected));
            } catch {
              resolve({ explanation: '', fixedCode: '' });
            }
          } else {
            resolve({ explanation: '', fixedCode: '' });
          }
        })
        .on('error', reject);
    });
  } catch (err: any) {
    console.error('Error analyzing code with Ollama:', err?.message ?? err);
    return { explanation: '', fixedCode: '' };
  }
}

/**
 * Turn Ollama text into clean {explanation, fixedCode}.
 * Handles: direct JSON, JSON substring, double-encoded JSON, unfenced code.
 */
function parseOllamaOutput(text: string): OllamaResult {
  let parsed: any = null;

  // Try direct JSON
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to grab the largest {...} region
    const jsonMatch = text.match(/\{[\s\S]*\}/m);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null;
      }
    }
  }

  // --- EXPLANATION ---
  let explanation = sanitizeExplanation((parsed?.explanation ?? parsed?.explain ?? '').toString());
  if (!explanation) {
    // Try to extract "explanation": "..." from raw text
    explanation = extractQuotedValue(text, 'explanation');
  }
  if (!explanation) {
    // Fallback: take the first non-code paragraph before any fenced block
    explanation = fallbackExplanationFromText(text);
  }
  explanation = limitLength(explanation, 800); // keep panel tidy

  // --- FIXED CODE ---
  let fixedCandidate = (parsed?.fixed_code ?? parsed?.fixedCode ?? parsed?.code ?? '').toString();

  // If fixedCandidate itself is JSON-ish (or quoted JSON), parse inner & take fixed_code
  const inner = tryParseInnerJson(fixedCandidate);
  if (inner && (inner.fixed_code || inner.fixedCode || inner.code)) {
    fixedCandidate = String(inner.fixed_code ?? inner.fixedCode ?? inner.code);
  }

  // If still empty, try to extract "fixed_code": " ... " from raw text
  if (!fixedCandidate.trim()) {
    fixedCandidate = extractQuotedValue(text, 'fixed_code');
  }

  const fixedCode = sanitizeFixedCode(fixedCandidate, text);

  return { explanation, fixedCode };
}

/** Keep explanation as plain text (strip code fences or trailing JSON noise). */
function sanitizeExplanation(exp: string): string {
  if (!exp) return '';
  // remove anything after a code fence if the model dumped code there
  exp = exp.split(/```/)[0];
  // trim stray braces/quotes
  exp = exp.replace(/^[\s"'{]+|[\s"'}]+$/g, '').trim();
  // collapse blank lines
  exp = exp.replace(/\n\s*\n+/g, '\n').trim();
  return exp;
}

/** Extract a JSON string value (supports "..." or '...') and unescape. */
function extractQuotedValue(text: string, key: string): string {
  if (!text) return '';
  const rx = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`, 's');
  const m = text.match(rx);
  if (!m) return '';
  let q = m[1].trim();
  const isDouble = q.startsWith('"') && q.endsWith('"');
  const isSingle = q.startsWith("'") && q.endsWith("'");
  if (isDouble || isSingle) q = q.slice(1, -1);
  // unescape common sequences
  q = q.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  return q.trim();
}

/** Fallback: explanation from the free text before first code fence and non-code lines only. */
function fallbackExplanationFromText(text: string): string {
  if (!text) return '';
  const before = text.split(/```/)[0] || text;
  // remove obvious JSON braces
  let cleaned = before.replace(/^\s*[{[][\s\S]*$/m, '').trim();
  if (!cleaned) cleaned = before.trim();
  // keep only lines that don't look like code
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !looksLikeCode(l));
  return lines.slice(0, 5).join(' ');
}

/** Limit string length safely. */
function limitLength(s: string, max: number): string {
  if (!s) return s;
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** Extract first fenced code block from any text. */
function extractCodeBlock(text: string): string {
  if (!text) return '';
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : '';
}

/** Heuristic: does a line look like real source code? */
function looksLikeCode(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  return /^(import |from |def |class |print\(|if |for |while |return\b|const |let |var |function\b|#|\/\/|try|except|elif|else:|await |async |public |private |package |using |std::|interface |enum )/.test(
    s
  );
}

/** If text contains a JSON-ish object (or quoted JSON), parse it; else null. */
function tryParseInnerJson(text: string): any | null {
  if (!text) return null;
  const t = text.trim();

  // Raw JSON object?
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      return JSON.parse(t);
    } catch {
      // fallthrough
    }
  }

  // Quoted JSON like "{\"explanation\":\"...\",\"fixed_code\":\"...\"}"
  const isQuoted =
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"));
  if (isQuoted) {
    const unquoted = t
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
    try {
      return JSON.parse(unquoted);
    } catch {
      // ignore
    }
  }

  return null;
}

/** Extract "fixed_code": " ... " value from messy text and unescape it. */
function extractFixedCodeFromText(text: string): string {
  return extractQuotedValue(text, 'fixed_code');
}

/**
 * Make sure fixedCode is *only* code.
 * - Prefer a code fence inside fixedCandidate
 * - Parse inner JSON if present
 * - If JSON-ish chatter remains, cut to the first code-looking line
 * - Strip stray backticks and outer quotes
 * - If still empty, try to extract from whole response text
 */
function sanitizeFixedCode(fixedCandidate: string, wholeText: string): string {
  let code = (fixedCandidate ?? '').trim();

  // If a fenced block exists inside, use it
  const fencedInside = extractCodeBlock(code);
  if (fencedInside) code = fencedInside;

  // If code still contains JSON chatter, drop to first code-looking line
  if (code.includes('"explanation"') || code.includes('"fixed_code"') || code.includes('{')) {
    const lines = code.split('\n');
    const start = lines.findIndex(looksLikeCode);
    if (start >= 0) code = lines.slice(start).join('\n').trim();
  }

  // Strip stray backticks
  code = code.replace(/```/g, '').trim();

  // Peel outer quotes if they wrap multi-line content
  if (
    ((code.startsWith('"') && code.endsWith('"')) ||
      (code.startsWith("'") && code.endsWith("'"))) &&
    code.includes('\n')
  ) {
    code = code.slice(1, -1).trim();
  }

  // If still empty, try to extract a fenced block from whole text
  if (!code) {
    code = extractCodeBlock(wholeText).trim();
  }

  // One last sanity: if the remaining content starts with JSON, try first code-like line
  if (code.startsWith('{') && code.includes('\n')) {
    const lines = code.split('\n');
    const start = lines.findIndex(looksLikeCode);
    if (start >= 0) code = lines.slice(start).join('\n').trim();
  }

  return code;
}
