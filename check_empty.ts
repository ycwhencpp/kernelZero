import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]?.trim()!;
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]?.trim()!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data: sources, error: sError } = await supabase.from("sources").select("id, name");
  const { data: items, error: iError } = await supabase.from("content_items").select("id, source_id, summary");
  
  const sourceHasContent = new Map<string, boolean>();
  for (const s of sources!) sourceHasContent.set(s.id, false);
  
  for (const i of items!) {
    if (i.source_id && i.summary && i.summary.trim().length > 0) {
      sourceHasContent.set(i.source_id, true);
    }
  }
  
  console.log("Sources without content:");
  for (const s of sources!) {
    if (!sourceHasContent.get(s.id)) {
      console.log(`- ${s.name} (${s.id})`);
    }
  }
}
check();
