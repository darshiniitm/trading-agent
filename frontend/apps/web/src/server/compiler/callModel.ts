export const DEFAULT_COMPILER_MODEL = process.env.OLLAMA_COMPILER_MODEL ?? process.env.OLLAMA_MODEL ?? "mistral:latest";
export const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

type OllamaResponse = { message?: { content?: string }; error?: string };

// `format` is a JSON Schema: Ollama constrains decoding to it (structured outputs), so a
// missing key can't happen. Without one it falls back to plain valid-JSON mode.
export async function callOllama(system: string, user: string, format?: object, fetchFn: typeof fetch = fetch, model: string = DEFAULT_COMPILER_MODEL): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: format ?? "json",
        options: { temperature: 0 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
  } catch (error) {
    throw new Error(`Ollama is not reachable at ${DEFAULT_OLLAMA_BASE_URL}. Start Ollama and pull ${model}: ${(error as Error).message}`);
  }

  const body = await response.json() as OllamaResponse;
  if (!response.ok) throw new Error(`Ollama compiler request failed (${response.status}): ${body.error ?? "unknown error"}`);
  const content = body.message?.content;
  if (!content) throw new Error("Ollama compiler returned no text content");
  return content;
}

// Keep the existing compiler seam name so the rest of the app and injected test
// call models remain unchanged. It now delegates exclusively to local Ollama.
export const callClaude = callOllama;

// A call model bound to a specific local model (used by the compiler-model evaluation).
export const ollamaFor = (model: string) => (system: string, user: string, format?: object) => callOllama(system, user, format, fetch, model);
