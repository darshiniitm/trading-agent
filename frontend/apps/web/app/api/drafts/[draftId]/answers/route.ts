import { z } from "zod";
import { db } from "@/server/db/client";
import { applyAnswer } from "@/server/mergeAnswer";

const AnswerBodySchema = z
  .object({
    path: z.string().min(1),
    value: z.union([z.number().finite(), z.string().min(1)]),
  })
  .strict();

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "request body must be JSON: {path: string, value: number | string}" }, { status: 400 });
  }
  const body = AnswerBodySchema.safeParse(json);
  if (!body.success) {
    return Response.json(
      { error: `request body must be {path: string, value: number | string}: ${body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` },
      { status: 400 }
    );
  }
  try {
    const draft = applyAnswer(db(), Number(params.draftId), body.data);
    return Response.json({ spec: draft.spec, needs_input: draft.needsInput });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
