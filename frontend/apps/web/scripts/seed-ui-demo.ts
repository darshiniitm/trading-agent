// Seeds a throwaway Postgres for the P5 visual check:
//   APP_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/ps_demo npx tsx scripts/seed-ui-demo.ts
import { closeDb, db } from "../src/server/db/client";
import { seedUiDemo } from "../src/server/db/seed";

const url = process.env.APP_DB_URL ?? "";
if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) throw new Error("APP_DB_URL must point at a local throwaway Postgres; refusing to seed anything else");
seedUiDemo(db()).then(() => closeDb()).then(() => console.log("seeded", url.replace(/:[^:@/]*@/, ":***@")));
