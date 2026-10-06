import { db } from "@/server/db/client";
import { retirePrompt } from "@/server/prompts";

export async function POST(_req: Request, { params }: { params: { promptId: string } }) {
  const promptId = Number(params.promptId);
  try {
    const { warning } = await retirePrompt(db(), promptId);
    return Response.json({ prompt_id: promptId, status: "retired", warning });
  } catch (err) {
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
