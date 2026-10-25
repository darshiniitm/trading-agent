import { rateLimited } from "@/server/rateLimit";
import { db } from "@/server/db/client";
import { compileProgramDraft, viewOf } from "@/server/compileProgramDraft";
import { getDraft } from "@/server/drafts";
import { getUserDefaults } from "@/server/userDefaults";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";

const notFound = () => Response.json({ error: "draft not found" }, { status: 404 });

export async function GET(req: Request, { params }: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.draftId);
    const draft = (await ownsDraft(raw, user.userId, id)) ? await getDraft(raw, id) : null;
    if (!draft) return notFound();
    if (!draft.program) return Response.json({ error: "no program compiled yet" }, { status: 404 });
    return Response.json(viewOf(draft, await getUserDefaults(raw, draft.userId)));
  });
}

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.draftId);
    if (!(await ownsDraft(raw, user.userId, id))) return notFound();
    const limited = rateLimited(user.userId, "model");
    if (limited) return limited;
    try {
      return Response.json(await compileProgramDraft(raw, id));
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  });
}
