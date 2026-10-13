// Screenshots every route at 1440 and 390 px and runs axe on each.
//   PS_DB_PATH=<throwaway> npx tsx scripts/seed-ui-demo.ts
//   PS_DB_PATH=<throwaway> npx next start -H 127.0.0.1 -p 3100 &   (after npm run build)
//   BASE=http://127.0.0.1:3100 npx tsx scripts/ui-screens.ts
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const OUT = "results/ui-screens";
const ROUTES: [string, string][] = [
  ["watchlist", "/watchlists/1?entry=1"], ["watchlist-follower-pending", "/watchlists/1?entry=2"], ["watchlist-shadow", "/watchlists/1?entry=3"],
  ["entry", "/watchlists/1/entries/1"], ["prompts", "/prompts"], ["new-prompt", "/drafts/58"], ["explore", "/explore"], ["data-health", "/data-health"], ["login", "/login"], ["signup", "/signup"],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  let serious = 0;
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]] as const) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    for (const [name, route] of ROUTES) {
      await page.goto(BASE + route, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const res = await new AxeBuilder({ page }).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      serious += bad.length;
      console.log(`${tag} ${name}: overflow=${overflow}px axe serious/critical=${bad.length}`);
      for (const v of bad) console.log(`   - ${v.id} (${v.impact}): ${v.help} [${v.nodes.length} nodes] e.g. ${v.nodes[0]?.target}`);
    }
  }
  await browser.close();
  process.exit(serious ? 1 : 0);
})();
