import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]?.trim()!;
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]?.trim()!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const updates = [
    { name: "Anthropic News & Engineering", url: "https://raw.githubusercontent.com/0xSMW/rss-feeds/main/feeds/feed_anthropic_news.xml" },
    { name: "Meta AI", url: "https://rsshub.app/meta/ai/global-search/content_types=blog" },
    { name: "ElevenLabs", url: "https://releases.sh/elevenlabs/elevenlabs-changelog.atom" },
    { name: "xAI", url: "https://releases.sh/xai.atom" },
    { name: "Cursor", url: "https://any-feeds.com/api/feeds/custom/cmkoaiogm0000lf04qmtirq2g/rss.xml" }
  ];

  for (const up of updates) {
    const { data, error } = await supabase.from("sources").update({ url: up.url }).eq("name", up.name);
    if (error) console.error(`Error updating ${up.name}:`, error);
    else console.log(`Updated ${up.name} -> ${up.url}`);
  }
}
check();
