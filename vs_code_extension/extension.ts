// src/extension.ts
import * as vscode from 'vscode';
import axios from 'axios';
import { analyzeCodeWithOllama, OllamaResult } from './ollamaClient';
import { generateCodeWithOllama } from './codeGeneratorClient'; // <-- import code generator

let panel: vscode.WebviewPanel | undefined;

// --- Hardcoded IPs ---
const REMOTE1 = 'http://192.168.161.63:5000/explain_json';
const REMOTE2 = 'http://192.168.161.13:8080/receive-code';

export function activate(context: vscode.ExtensionContext) {
  console.log('bugbot-ai: activated');

  const diagCollection = vscode.languages.createDiagnosticCollection('bugbot-ai');
  context.subscriptions.push(diagCollection);

  // Main command
  const analyzeCmd = vscode.commands.registerCommand('bugbot-ai.analyzeCode', async () => {
    runAnalysis(context, diagCollection);
  });
  context.subscriptions.push(analyzeCmd);

  // Re-run analysis on save if panel is visible
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!panel || !panel.visible) return;
    if (['python', 'javascript'].includes(doc.languageId)) {
      runAnalysis(context, diagCollection);
    }
  });
  context.subscriptions.push(saveListener);
}

// --- Send to Remote 1 ---
async function sendCodeToRemoteBackend(code: string, fileName?: string, language?: string) {
  try {
    const resp = await axios.post(REMOTE1, { code, fileName, language }, { timeout: 120000 });
    vscode.window.showInformationMessage('BugBot AI: code sent to Remote 1 successfully.');
    panel?.webview.postMessage({ command: 'remoteStatus', status: 'sent', response: resp.data });
  } catch (err: any) {
    vscode.window.showWarningMessage('BugBot AI: failed to send code to Remote 1.');
    console.error('Remote 1 error:', err.response?.data ?? err.message);
    panel?.webview.postMessage({ command: 'remoteStatus', status: 'error', error: err.message });
  }
}

// --- Send to Remote 2 and open local page ---
async function sendCodeToRemoteBackend2(code: string, fileName?: string, language?: string) {
  try {
    const resp = await axios.post(REMOTE2, { code, fileName, language }, { timeout: 120000 });
    vscode.window.showInformationMessage('BugBot AI: code sent to Remote 2 successfully.');
    panel?.webview.postMessage({ command: 'remoteStatus2', status: 'sent', response: resp.data });

    // --- Open local page automatically ---
    const localUrl = 'http://localhost:5173/'; // <-- change this to your URL
    vscode.env.openExternal(vscode.Uri.parse(localUrl));

  } catch (err: any) {
    vscode.window.showWarningMessage('BugBot AI: failed to send code to Remote 2.');
    console.error('Remote 2 error:', err.response?.data ?? err.message);
    panel?.webview.postMessage({ command: 'remoteStatus2', status: 'error', error: err.message });
  }
}

// --- Run Analysis ---
async function runAnalysis(
  context: vscode.ExtensionContext,
  diagCollection: vscode.DiagnosticCollection
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a Python or JavaScript file to analyze.');
    return;
  }

  const doc = editor.document;
  const selection = editor.selection;
  const code = selection.isEmpty ? doc.getText() : doc.getText(selection);

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'bugbotAi',
      'BugBot AI — Analysis',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.onDidDispose(() => {
      panel = undefined;
    });

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.command === 'apply') {
          const newCode: string = msg.code ?? '';
          const edit = new vscode.WorkspaceEdit();
          const range = selection.isEmpty
            ? new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end)
            : new vscode.Range(selection.start, selection.end);
          edit.replace(doc.uri, range, newCode);
          const ok = await vscode.workspace.applyEdit(edit);
          if (ok) {
            await doc.save();
            vscode.window.showInformationMessage('BugBot AI: fix applied.');
          } else {
            vscode.window.showErrorMessage('BugBot AI: failed to apply fix.');
          }
        }

        if (msg.command === 'sendRemote') {
          await sendCodeToRemoteBackend(code, doc.fileName, doc.languageId);
        }

        if (msg.command === 'sendRemote2') {
          await sendCodeToRemoteBackend2(code, doc.fileName, doc.languageId);
        }

        // --- NEW: Generate code from input ---
        if (msg.command === 'generateCode') {
          const problem = msg.problem ?? '';
          if (!problem.trim()) {
            vscode.window.showWarningMessage('Please enter a problem statement.');
            return;
          }
          panel.webview.postMessage({ command: 'updateStatus', status: 'Generating code...' });
          try {
            const genResult = await generateCodeWithOllama(problem);
            panel.webview.postMessage({
              command: 'updateCode',
              code: genResult.code
            });

            const analysisResult: OllamaResult = await analyzeCodeWithOllama(genResult.code);
            panel.webview.postMessage({
              command: 'updateExplanation',
              explanation: analysisResult.explanation || ''
            });

            setQuickDiagnostic(doc, analysisResult.explanation ?? '', diagCollection);
          } catch (err: any) {
            vscode.window.showErrorMessage('Failed to generate code: ' + (err.message ?? String(err)));
            console.error('Code generation error', err);
          }
        }

        // --- NEW: Open website ---
        if (msg.command === 'openWebsite') {
          vscode.env.openExternal(vscode.Uri.parse('http://192.168.112.223:8501'));
        }
      },
      undefined,
      context.subscriptions
    );
  }

  panel.webview.html = getWebviewContent('Analyzing... please wait', '');
  try {
    const result: OllamaResult = await analyzeCodeWithOllama(code);
    panel.webview.html = getWebviewContent(
      result.explanation || 'No explanation provided.',
      result.fixedCode || code
    );
    setQuickDiagnostic(doc, result.explanation ?? '', diagCollection);
  } catch (err: any) {
    panel.webview.html = getWebviewContent('Error calling Ollama: ' + (err.message ?? String(err)), '');
    console.error('Ollama error', err);
  }
}

// --- Diagnostics ---
function setQuickDiagnostic(doc: vscode.TextDocument, message: string, collection: vscode.DiagnosticCollection) {
  if (!message) {
    collection.set(doc.uri, []);
    return;
  }
  const firstLine = 0;
  const maxCol = Math.min(80, doc.lineAt(firstLine).range.end.character || 1);
  const range = new vscode.Range(new vscode.Position(firstLine, 0), new vscode.Position(firstLine, maxCol));
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  collection.set(doc.uri, [diagnostic]);
}

// --- HTML Escape ---
function escapeHtml(s?: string) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Webview ---
function getWebviewContent(explanation: string, fixedCode: string) {
  const exp = escapeHtml(explanation);
  const code = escapeHtml(fixedCode);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 10px; }
    #explanation { background:#f5f5f5; padding:8px; border-radius:6px; white-space:pre-wrap; margin-bottom:10px; color: #000; }
    textarea { width:100%; height:300px; font-family: monospace; font-size:13px; white-space:pre; color: #000; }
    input[type="text"] { width: calc(100% - 100px); padding:6px; font-size:13px; margin-bottom:6px; }
    button { margin-top:6px; padding:6px 10px; }
    #remoteStatus, #remoteStatus2 { margin-top:8px; padding:6px; border-radius:4px; background:#f0f4ff; border:1px solid #d0e0ff; color: #000; }
  </style>
</head>
<body>
  <h3>AI Explanation</h3>
  <div id="explanation">${exp}</div>

  <h3>Code Sugession</h3>
  <textarea id="code">${code}</textarea>

  <h3>Generate Code</h3>
  <input type="text" id="problemInput" placeholder="Enter problem statement here..." />
  <button id="generateCode">Generate Code</button>
  <div id="generationStatus"></div>

  <div>
    <button id="apply">Apply Fix</button>
    <button id="sendRemote" style="margin-left:8px;">Send to Remote 1</button>
    <button id="sendRemote2" style="margin-left:8px;">Send to Remote 2</button>
    <button id="openWebsite" style="margin-left:8px;">Open Website</button>
  </div>
  <div id="remoteStatus">Explain: <span id="remoteText">idle</span></div>
  <div id="remoteStatus2">Optimize: <span id="remoteText2">idle</span></div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('apply').addEventListener('click', () => {
      const code = document.getElementById('code').value;
      vscode.postMessage({ command: 'apply', code });
    });

    document.getElementById('sendRemote').addEventListener('click', () => {
      vscode.postMessage({ command: 'sendRemote' });
      document.getElementById('remoteText').textContent = 'sending...';
    });

    document.getElementById('sendRemote2').addEventListener('click', () => {
      vscode.postMessage({ command: 'sendRemote2' });
      document.getElementById('remoteText2').textContent = 'sending...';
    });

    document.getElementById('generateCode').addEventListener('click', () => {
      const problem = document.getElementById('problemInput').value;
      vscode.postMessage({ command: 'generateCode', problem });
      document.getElementById('generationStatus').textContent = 'Generating...';
    });

    document.getElementById('openWebsite').addEventListener('click', () => {
      vscode.postMessage({ command: 'openWebsite' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'remoteStatus') {
        document.getElementById('remoteText').textContent = msg.status === 'sent' ? 'sent' : 'error';
      }
      if (msg.command === 'remoteStatus2') {
        document.getElementById('remoteText2').textContent = msg.status === 'sent' ? 'sent' : 'error';
      }
      if (msg.command === 'updateCode') {
        document.getElementById('code').value = msg.code;
        document.getElementById('generationStatus').textContent = 'Code generated.';
      }
      if (msg.command === 'updateExplanation') {
        document.getElementById('explanation').textContent = msg.explanation;
      }
      if (msg.command === 'updateStatus') {
        document.getElementById('generationStatus').textContent = msg.status;
      }
    });
  </script>
</body>
</html>`;
}  

export function deactivate() {}
