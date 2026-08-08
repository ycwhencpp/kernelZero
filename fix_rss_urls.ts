import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { JSDOM } from "jsdom";
import { fetchFeed } from "./lib/rss";

const env = fs.readFileSync(".env.local", "utf8");
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]?.trim()!;
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]?.trim()!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data: sources, error } = await supabase.from("sources").select("id, name, url, type");
  if (error) {
    console.error(error);
    return;
  }
  
  for (const source of sources) {
    if (source.type !== 'rss' && source.type !== 'atom') continue;
    
    let isWorking = false;
    try {
      await fetchFeed(source.url);
      isWorking = true;
    } catch (e: any) {
      if (e.message.includes("larger than the 2 MB") || e.message.includes("429")) {
        isWorking = true; // URL is correct, just rate limited or too large
      }
    }
    
    if (!isWorking) {
      console.log(`Fixing: ${source.name} (${source.url})`);
      try {
        // Try to get the base URL
        const urlObj = new URL(source.url);
        // Usually the blog homepage is the path without rss.xml etc
        const basePath = source.url.replace(/\/(rss|feed|index|rss\.xml|feed\.xml|index\.xml|feed\/)$/i, "") || urlObj.origin;
        const testUrls = new Set<string>();
        
        // Try to fetch the base path and look for <link rel="alternate">
        try {
          const res = await fetch(basePath, {
             headers: { "User-Agent": "Mozilla/5.0 (compatible; KernelZero/1.0)" }
          });
          if (res.ok) {
            const html = await res.text();
            const doc = new JSDOM(html, { url: basePath });
            const links = doc.window.document.querySelectorAll('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]');
            for (const link of links) {
               testUrls.add((link as any).href);
            }
          }
        } catch (e) {}

        // Add some common fallbacks
        testUrls.add(urlObj.origin + "/rss");
        testUrls.add(urlObj.origin + "/feed");
        testUrls.add(urlObj.origin + "/rss.xml");
        testUrls.add(urlObj.origin + "/feed.xml");
        testUrls.add(urlObj.origin + "/blog/rss.xml");
        testUrls.add(urlObj.origin + "/blog/feed");
        testUrls.add(urlObj.origin + "/index.xml");
        
        // If it's a medium URL
        if (urlObj.hostname.includes("medium.com")) {
           const pathParts = urlObj.pathname.split('/').filter(Boolean);
           if (pathParts.length > 0) {
              const name = pathParts[0].replace('feed', '').replace('@', '');
              if (name) {
                 testUrls.add(`https://medium.com/feed/@${name}`);
                 testUrls.add(`https://medium.com/feed/${name}`);
              }
           }
        }

        let found = false;
        for (const testUrl of testUrls) {
           if (!testUrl || testUrl === source.url) continue;
           try {
              await fetchFeed(testUrl);
              console.log(`  -> Found valid feed: ${testUrl}`);
              await supabase.from("sources").update({ url: testUrl }).eq("id", source.id);
              found = true;
              break;
           } catch (e: any) {
              // Ignore
           }
        }
        if (!found) {
           console.log(`  -> Could not find valid feed.`);
        }
      } catch (e) {
         console.log(`  -> Error fixing: ${e}`);
      }
    }
  }
}
check();
