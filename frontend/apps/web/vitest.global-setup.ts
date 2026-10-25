import { ensureTemplate } from "./src/server/db/test-db";

// Build the Postgres test template once, before any worker starts, so workers do not each rebuild it.
export default async function setup() {
  await ensureTemplate();
}
