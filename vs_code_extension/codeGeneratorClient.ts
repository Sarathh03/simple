// src/codeGeneratorClient.ts
import axios from 'axios';
import { Readable } from 'stream';

export interface CodeGenResult {
  code: string;
}

/**
 * Generate code for a programming problem using Ollama.
 * Uses the same model as your analyzer: llama3.1:8b.
 * Stream-compatible but defaults to non-stream for simplicity.
 */
export async function generateCodeWithOllama(
  problemStatement: string,
  model = 'llama3.1:8b',
  stream = false
): Promise<CodeGenResult> {
  const prompt = `You are an expert programmer. Write ONLY working code (no explanations) for the following problem:

Problem:
${problemStatement}
`;

  try {
    const resp = await axios({
      method: 'post',
      url: 'http://localhost:11434/api/generate',
      data: { model, prompt, stream },
      responseType: stream ? 'stream' : 'json',
      timeout: 180000 // allow big problems
    });

    if (!stream) {
      const output = resp.data?.response || '';
      const code = extractCodeBlock(output) || output;
      return { code: code.trim() };
    }

    // Collect streamed data
    let collected = '';
    return await new Promise<CodeGenResult>((resolve, reject) => {
      (resp.data as Readable)
        .on('data', (chunk) => {
          collected += chunk.toString();
        })
        .on('end', () => {
          const code = extractCodeBlock(collected) || collected;
          resolve({ code: code.trim() });
        })
        .on('error', reject);
    });
  } catch (err: any) {
    console.error('Code generation error:', err?.message ?? err);
    throw new Error('Failed to generate code');
  }
}

/** Extract first fenced code block from any text. */
function extractCodeBlock(text: string): string {
  if (!text) return '';
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : '';
}
