import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
process.env.NEXT_PUBLIC_SUPABASE_URL = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]?.trim()!;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]?.trim()!;

import { getDashboardState, upsertItems, personalizeItems, addSource } from "./lib/store";
import { fetchFeed } from "./lib/rss";
import { scoreCandidate } from "./lib/domain";

const ownerId = "anurag.jay1002@gmail.com";

async function run() {
  const state = await getDashboardState(ownerId);
  console.log(`Loaded state: ${state.sources.length} sources, ${state.items.length} items`);
  
  const sourceHasContent = new Set<string>();
  for (const i of state.items) {
    if (i.sourceId && i.summary && i.summary.trim().length > 0) {
      sourceHasContent.add(i.sourceId);
    }
  }

  const emptySources = state.sources.filter(s => !sourceHasContent.has(s.id) && (s.type === 'rss' || s.type === 'atom'));
  console.log(`Found ${emptySources.length} empty RSS/Atom sources to fetch.`);

  for (const source of emptySources) {
    console.log(`Fetching feed: ${source.name} (${source.url})`);
    try {
      const parsed = await fetchFeed(source.url);
      const items = await personalizeItems(ownerId, parsed.items.map((candidate) => scoreCandidate({ ...candidate, sourceId: source.id, sourceName: source.name }, state.interests)));
      await upsertItems(ownerId, items);
      await addSource(ownerId, { ...source, lastSuccessfulFetch: new Date().toISOString() });
      console.log(`  -> Saved ${items.length} items for ${source.name}`);
    } catch (e: any) {
      console.error(`  -> Error fetching ${source.name}: ${e.message}`);
    }
  }
}
run();
