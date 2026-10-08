import { db } from "@/server/db/client";
import { getMe } from "@/server/auth/currentUser";

export async function GET(req: Request) { return Response.json(getMe(db(), req)); }
