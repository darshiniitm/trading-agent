// Seeds a throwaway database for the P5 visual check: PS_DB_PATH=/tmp/ps-demo.db npx tsx scripts/seed-ui-demo.ts
import { db } from "../src/server/db/client";
import { seedUiDemo } from "../src/server/db/seed";

if (!process.env.PS_DB_PATH) throw new Error("set PS_DB_PATH to a throwaway file; refusing to seed data/app.db");
seedUiDemo(db());
console.log("seeded", process.env.PS_DB_PATH);
