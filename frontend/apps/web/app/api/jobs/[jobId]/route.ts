import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getJobForUser } from "@/server/jobQueue";

export const dynamic = "force-dynamic";

// Poll target for a long draft request that was handed to a background function (docs/netlify-production-plan.md §6.2).
// Another user's job looks exactly like a missing one.
export async function GET(req: Request, { params }: { params: { jobId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.jobId);
    const job = Number.isInteger(id) && id > 0 ? await getJobForUser(raw, id, user.userId) : null;
    if (!job) return Response.json({ error: "job not found" }, { status: 404 });
    return Response.json(job, { headers: { "cache-control": "no-store" } });
  });
}
