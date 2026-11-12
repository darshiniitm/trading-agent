import { z } from "zod";
import { rateLimited } from "@/server/rateLimit";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";
import { editChip, editProgramClause, setAddon } from "@/server/compileProgramDraft";

// Nothing here is an answer to a question: {path, value} replaces one assumed value (a chip), {liquidity} /
// {min_price} switch an optional add-on on or off, {edit} rewrites one line of the prompt.
const Body = z.union([
  z.object({ path: z.string().min(1), value: z.any() }).strict(),
  z.object({ liquidity: z.union([z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("floor"), cr: z.number().finite() }).strict()]) }).strict(),
  z.object({ min_price: z.union([z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("floor"), price: z.number().finite() }).strict()]) }).strict(),
  z.object({ edit: z.object({ clause_id: z.string().min(1), text: z.string().min(1).max(500) }).strict() }).strict(),
]);

async function handle(req: Request, { params }: { params: { draftId: string } }) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "request body must be JSON" }, { status: 400 }); }
  const body = Body.safeParse(json);
  if (!body.success) return Response.json({ error: "body must be {path, value}, {liquidity: {mode, cr?}}, {min_price: {mode, price?}} or {edit: {clause_id, text}}" }, { status: 400 });
  try {
    const id = Number(params.draftId);
    const d = body.data;
    const view = "edit" in d ? await editProgramClause(db(), id, d.edit.clause_id, d.edit.text)
      : "liquidity" in d ? await setAddon(db(), id, { liquidity: d.liquidity })
      : "min_price" in d ? await setAddon(db(), id, { min_price: d.min_price })
      : await editChip(db(), id, d.path, d.value);
    return Response.json(view);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request, ctx: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    if (!(await ownsDraft(raw, user.userId, Number(ctx.params.draftId)))) return Response.json({ error: "draft not found" }, { status: 404 });
    return rateLimited(user.userId, "model") ?? handle(req, ctx);
  });
}
