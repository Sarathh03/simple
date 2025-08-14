import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';

type AnalysisResult = {
  optimality?: string;
  complexity?: string;
  feedback?: string;
};

export async function analyseCode(
  code: string,
  language = 'python',
  model = 'llama3.1:8b'
): Promise<AnalysisResult | null> {
  const prompt = buildPrompt(code, language);

  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        temperature: 0,
        max_tokens: 2048,
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error('HTTP error:', response.status, response.statusText);
      console.error('Response body:', text);  // log full body for debugging
      return null;
    }

    // attempt to parse JSON safely
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    let combinedResponse = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        combinedResponse += obj.response ?? '';
      } catch {
        // ignore parse errors
      }
    }

    combinedResponse = combinedResponse.replace(/```json|```/g, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(combinedResponse);
    } catch (parseErr) {
      console.error('Failed to parse model JSON:', parseErr);
      console.error('Raw combined response:', combinedResponse);
      return null; // gracefully return null if JSON invalid
    }

    return {
      optimality: parsed.optimality ?? null,
      complexity:
        typeof parsed.complexity === 'object'
          ? JSON.stringify(parsed.complexity)
          : parsed.complexity ?? null,
      feedback: parsed.feedback ?? null,
    };
  } catch (err) {
    console.error('Error analysing code:', err);
    return null;
  }
}

function buildPrompt(code: string, language: string): string {
  return `You are an expert ${language} developer and code analyzer.
Analyze the following ${language} code and provide a JSON object with:
- "optimality": Short explanation about efficiency and best practices for more than two lines 
- "complexity": Time and space complexity
- "feedback": Feedback on improvements or potential issues

Output ONLY valid JSON.

Here is the code:
\`\`\`${language}
${code}
\`\`\``;
}

export async function getCodeAndLanguage(filePath: string) {
  const extToLang: Record<string, string> = {
    '.py': 'python',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.java': 'java',
    '.c': 'c',
    '.r': 'r',
  };

  const ext = path.extname(filePath).toLowerCase();
  const language = extToLang[ext] ?? 'python';
  const code = await fs.readFile(filePath, 'utf-8');

  return { code, language };
}
