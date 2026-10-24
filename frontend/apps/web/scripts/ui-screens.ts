// Screenshots every route at 1440 and 390 px and runs axe on each. After the page loads, the watchlist is also
// captured in each P6 view (Price · Financials · Performance · Risk · Technicals) by clicking the view switcher.
// Needs a signed-in session: pass a storage state file via STORAGE_STATE=<path> (the app has no auth bypass).
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
  ["watchlist-benchmark", "/watchlists/1?bench=%5ENSEI"], ["entry", "/watchlists/1/entries/1"], ["prompts", "/prompts"], ["new-prompt", "/drafts/58"], ["explore", "/explore"], ["data-health", "/data-health"], ["login", "/login"], ["signup", "/signup"],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  let serious = 0;
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]] as const) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, storageState: process.env.STORAGE_STATE })).newPage();
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
    // P6 views: one screenshot + axe + overflow per view of the demo watchlist
    await page.goto(`${BASE}/watchlists/1?entry=1`, { waitUntil: "networkidle" });
    for (const view of ["Price", "Financials", "Performance", "Risk", "Technicals"]) {
      await page.getByRole("group", { name: "Watchlist view" }).getByRole("button", { name: view, exact: true }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/watchlist-view-${view.toLowerCase()}-${tag}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const res = await new AxeBuilder({ page }).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      serious += bad.length;
      console.log(`${tag} view ${view}: overflow=${overflow}px axe serious/critical=${bad.length}`);
      for (const v of bad) console.log(`   - ${v.id} (${v.impact}): ${v.help} [${v.nodes.length} nodes] e.g. ${v.nodes[0]?.target}`);
    }
  }
  await browser.close();
  process.exit(serious ? 1 : 0);
})();
