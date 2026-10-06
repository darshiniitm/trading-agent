import { db } from "@/server/db/client";
import { runCatchUp } from "@/server/catchUp";

async function main() {
  const raw = db();
  const prompts = raw.prepare("SELECT prompt_id, title FROM prompts WHERE status = 'confirmed'").all() as { prompt_id: number; title: string }[];

  for (const prompt of prompts) {
    try {
      const { weeksRun } = await runCatchUp(raw, { promptId: prompt.prompt_id });
      console.log(
        weeksRun.length > 0
          ? `Prompt ${prompt.prompt_id} (${prompt.title}): caught up ${weeksRun.join(", ")}`
          : `Prompt ${prompt.prompt_id} (${prompt.title}): up to date`
      );
    } catch (err) {
      console.error(`Prompt ${prompt.prompt_id} (${prompt.title}): FAILED — ${(err as Error).message}`);
    }
  }
}

main();
