import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");

function requireEnvValue(name: string): string {
  const value = env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

const supabaseUrl = requireEnvValue("NEXT_PUBLIC_SUPABASE_URL");
const supabaseKey = requireEnvValue("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: sources, error: sError } = await supabase.from("sources").select("id, name, type");
  const { data: items, error: iError } = await supabase.from("content_items").select("source_id, summary");
  
  if (sError || iError) {
    console.error(sError || iError);
    return;
  }
  
  const sourceHasContent = new Set<string>();
  for (const i of items) {
    if (i.source_id && i.summary && i.summary.trim().length > 0) {
      sourceHasContent.add(i.source_id);
    }
  }
  
  const emptySources = sources.filter(s => !sourceHasContent.has(s.id) && (s.type === 'rss' || s.type === 'atom'));
  console.log(`Found ${emptySources.length} sources with no content. Removing...`);
  
  for (const source of emptySources) {
    const { error } = await supabase.from("sources").delete().eq("id", source.id);
    if (error) {
      console.error(`Error deleting ${source.name}:`, error);
    } else {
      console.log(`Removed: ${source.name}`);
    }
  }
}
run();
