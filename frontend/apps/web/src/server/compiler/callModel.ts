import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_COMPILER_MODEL = process.env.ANTHROPIC_COMPILER_MODEL ?? "claude-sonnet-5";

export async function callClaude(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — the prompt compiler needs it to call Claude");

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: DEFAULT_COMPILER_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") throw new Error("compiler model returned a non-text response");
  return block.text;
}
