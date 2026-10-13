import { db } from "@/server/db/client";
import { getMe } from "@/server/auth/currentUser";

export const dynamic = "force-dynamic";
export async function GET(req: Request) { return Response.json(await getMe(db(), req)); }
