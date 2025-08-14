# flask_gemini_explainer_json_clean.py
import json
import re
from flask import Flask, request, jsonify, render_template_string
from google import genai

# ===============================
# 🔑 API key here
API_KEY = "AIzaSyC7udddGKz1Doy7cLZMPfbfHl-OQzSrVsI"
# ===============================

app = Flask(__name__)
client = genai.Client(api_key=API_KEY)

CODE_TOKEN_RE = re.compile(
    r'\b(def|class|function|const|let|var|import|from|public|private|if\s*\(|for\s*\(|while\s*\(|=>|console\.log|print\(|println\()',
    re.IGNORECASE
)

def normalize_code(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(str(x) for x in value if isinstance(x, (str, int, float)))
    return str(value)

def extract_code_from_json(obj):
    """Extract the most likely code snippet from JSON."""
    candidates = []

    def walk(o, path_tokens):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, path_tokens + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, path_tokens + [f"[{i}]"])
        elif isinstance(o, str):
            s = o.strip()
            if len(s) < 10:
                return
            score = s.count("\n") * 10 + (20 if CODE_TOKEN_RE.search(s) else 0)
            candidates.append((score, s, path_tokens.copy()))

    walk(obj, [])
    if not candidates:
        return None, None
    candidates.sort(key=lambda x: x[0], reverse=True)
    _, code, path_tokens = candidates[0]
    path_str = ".".join(path_tokens)
    return code, path_str

INDEX_HTML = """
<!doctype html>
<title>JSON → Gemini Explainer</title>
<h2>Paste JSON (model output) below</h2>
<textarea id="jsonInput" style="width:95%;height:260px;font-family:monospace;"></textarea>
<br/>
<input id="codePath" placeholder="Optional code path" style="width:60%;"/>
<button id="explainBtn">Explain</button>
<pre id="status" style="white-space:pre-wrap;background:#f5f5f5;padding:10px;margin-top:10px;"></pre>
<script>
document.getElementById('explainBtn').onclick = async () => {
    const jtext = document.getElementById('jsonInput').value;
    let parsed;
    try { parsed = JSON.parse(jtext); } catch(e) { document.getElementById('status').textContent = 'Invalid JSON: ' + e; return; }
    const code_path = document.getElementById('codePath').value.trim() || null;
    document.getElementById('status').textContent = 'Sending to server...';
    try {
        const resp = await fetch('/explain_json', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({payload: parsed, code_path: code_path})
        });
        const data = await resp.json();
        if (resp.ok) {
            let out = 'Extracted code path: ' + (data.extracted_path || 'auto-detected') + '\\n\\n';
            out += '--- Extracted code (preview) ---\\n' + (data.extracted_preview || '') + '\\n\\n';
            out += '--- Explanation from model ---\\n' + (data.explanation || '');
            document.getElementById('status').textContent = out;
        } else {
            document.getElementById('status').textContent = 'Error: ' + (data.error || JSON.stringify(data));
        }
    } catch (err) {
        document.getElementById('status').textContent = 'Network / server error: ' + err;
    }
}
</script>
"""

@app.route("/", methods=["GET"])
def index():
    return render_template_string(INDEX_HTML)

@app.route("/explain_json", methods=["POST"])
def explain_json_route():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid request"}), 400

    payload = body.get("payload", body)
    code_path = body.get("code_path") or None

    # Try explicit path
    code_value = None
    used_path = None
    if code_path:
        parts = code_path.split(".")
        cur = payload
        try:
            for p in parts:
                if p.startswith("[") and p.endswith("]"):
                    cur = cur[int(p[1:-1])]
                else:
                    cur = cur.get(p)
            code_value = normalize_code(cur)
            used_path = code_path
        except Exception:
            code_value = None

    # Try common fields
    if not code_value:
        for common in ("code", "source", "snippet", "text"):
            cur = payload.get(common)
            if cur:
                code_value = normalize_code(cur)
                used_path = common
                break

    # Auto-extract
    if not code_value:
        code_value, auto_path = extract_code_from_json(payload)
        if code_value:
            used_path = auto_path

    if not code_value:
        return jsonify({"error": "No code found"}), 400

    language = body.get("language") or "unspecified"

    prompt = f"""
You are an expert programming tutor.
Explain the following {language} code line by line in simple terms.
Return a readable text format like:
Line 1: <code>
Explanation: <explanation>

Here is the code:
{code_value}
"""

    # Send to Gemini AI
    resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
    explanation = ""
    try:
        if hasattr(resp, 'text') and resp.text:
            explanation = resp.text
        elif hasattr(resp, 'outputs'):
            first = resp.outputs[0]
            if isinstance(first, dict) and 'content' in first:
                explanation = ''.join(c.get('text','') if isinstance(c, dict) else str(c) for c in first['content'])
            elif isinstance(first, dict) and 'text' in first:
                explanation = first['text']
    except Exception:
        explanation = str(resp)

    # Print explanation to console
    print("\n=== Gemini Explanation ===")
    print(explanation)
    print("=== End of Explanation ===\n")

    preview = code_value if len(code_value) <= 2000 else code_value[:2000] + "\n... (truncated)"
    return jsonify({
        "extracted_path": used_path,
        "extracted_preview": preview,
        "language": language,
        "explanation": explanation
    })

if __name__ == "_main_":
    app.run(debug=True, host="0.0.0.0", port=5000)