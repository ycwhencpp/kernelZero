import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const env = fs.readFileSync(".env.local", "utf8");
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]?.trim()!;
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]?.trim()!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabase
    .from("content_items")
    .select("id, title, canonical_url, summary")
  if (error) {
    console.error(error);
    return;
  }
  const empty = data.filter(i => !i.summary || i.summary.trim().length < 50);
  console.log(`Found ${empty.length} items to fetch.`);

  for (const item of empty) {
    try {
      console.log(`Fetching ${item.canonical_url}...`);
      const res = await fetch(item.canonical_url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KernelZero/1.0)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`  -> Failed: HTTP ${res.status}`);
        continue;
      }
      
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/pdf")) {
         console.log(`  -> Skipping PDF`);
         continue;
      }

      const html = await res.text();
      const doc = new JSDOM(html, { url: item.canonical_url });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();
      
      const content = article?.textContent?.trim() || article?.excerpt?.trim() || "";
      
      if (content && content.length > 50) {
        const { error: upErr } = await supabase
          .from("content_items")
          .update({ summary: content })
          .eq("id", item.id);
        if (upErr) console.error(`  -> DB Update Failed:`, upErr);
        else console.log(`  -> Updated! (${content.length} chars)`);
      } else {
         console.log(`  -> No readable content extracted`);
      }
    } catch (err: any) {
      console.error(`  -> Error: ${err.message}`);
    }
  }
}
check();
