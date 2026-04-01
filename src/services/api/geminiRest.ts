import { spawn } from 'child_process'

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_TIMEOUT_MS = 20000
const PYTHON_BINARIES = ['python3', 'python'] as const

type PythonHelperPayload = {
  operation: 'list_models' | 'generate_content'
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  model?: string
  body?: Record<string, unknown>
}

const PYTHON_HELPER = `
import json
import sys
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"

def build_url(base_url: str, path: str, api_key: str) -> str:
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    return f"{base}{path}?{urllib.parse.urlencode({'key': api_key})}"

def http_json_request(url: str, method: str, body, timeout_sec: float):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}

def normalize_model(model: str) -> str:
    if model.startswith("models/"):
        return model
    return f"models/{model}"

def main():
    payload = json.load(sys.stdin)
    op = payload["operation"]
    api_key = payload["apiKey"]
    base_url = payload.get("baseUrl") or DEFAULT_BASE_URL
    timeout_sec = max(float(payload.get("timeoutMs", 20000)) / 1000.0, 1.0)

    if op == "list_models":
        result = http_json_request(
            build_url(base_url, "/v1beta/models", api_key),
            "GET",
            None,
            timeout_sec,
        )
        json.dump(result, sys.stdout)
        return

    if op == "generate_content":
        model = normalize_model(payload["model"])
        body = payload.get("body") or {}
        result = http_json_request(
            build_url(base_url, f"/v1beta/{model}:generateContent", api_key),
            "POST",
            body,
            timeout_sec,
        )
        json.dump(result, sys.stdout)
        return

    raise RuntimeError(f"Unsupported Gemini helper operation: {op}")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
`.trim()

function normalizeGeminiBaseUrl(baseUrl?: string): string {
  const normalized = DEFAULT_GEMINI_BASE_URL
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function runPythonHelperWithBinary(
  binary: string,
  payload: PythonHelperPayload,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-c', PYTHON_HELPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`Gemini Python helper timed out after ${timeoutMs}ms`))
    }, timeoutMs + 1000)

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Gemini Python helper exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>)
      } catch (error) {
        reject(
          new Error(
            `Gemini Python helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

async function runPythonGeminiHelper(
  payload: PythonHelperPayload,
): Promise<Record<string, unknown>> {
  let lastError: unknown
  for (const binary of PYTHON_BINARIES) {
    try {
      return await runPythonHelperWithBinary(binary, payload)
    } catch (error) {
      lastError = error
      if (
        error instanceof Error &&
        /ENOENT|not found|can't open file/i.test(error.message)
      ) {
        continue
      }
      throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('No usable Python interpreter found for Gemini fallback')
}

export async function listGeminiModelsViaPython({
  apiKey,
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
}): Promise<Record<string, unknown>> {
  return runPythonGeminiHelper({
    operation: 'list_models',
    apiKey,
    baseUrl: normalizeGeminiBaseUrl(baseUrl),
    timeoutMs,
  })
}

export async function generateGeminiContentViaPython({
  apiKey,
  baseUrl,
  model,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  apiKey: string
  baseUrl?: string
  model: string
  body: Record<string, unknown>
  timeoutMs?: number
}): Promise<Record<string, unknown>> {
  return runPythonGeminiHelper({
    operation: 'generate_content',
    apiKey,
    baseUrl: normalizeGeminiBaseUrl(baseUrl),
    model,
    body,
    timeoutMs,
  })
}

