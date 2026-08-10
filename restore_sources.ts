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

const ownerId = "anurag.jay1002@gmail.com";

const sourcesToRestore = [
  { name: "Actix", url: "https://actix.rs/blog/rss.xml" },
  { name: "Airbnb Engineering", url: "https://medium.com/airbnb-engineering/feed" },
  { name: "Anthropic News & Engineering", url: "https://raw.githubusercontent.com/0xSMW/rss-feeds/main/feeds/feed_anthropic_news.xml" },
  { name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI" },
  { name: "arXiv cs.CL", url: "https://rss.arxiv.org/rss/cs.CL" },
  { name: "arXiv cs.CV", url: "https://rss.arxiv.org/rss/cs.CV" },
  { name: "arXiv cs.DC", url: "https://rss.arxiv.org/rss/cs.DC" },
  { name: "arXiv cs.LG", url: "https://rss.arxiv.org/rss/cs.LG" },
  { name: "arXiv cs.NE", url: "https://rss.arxiv.org/rss/cs.NE" },
  { name: "arXiv cs.SE", url: "https://rss.arxiv.org/rss/cs.SE" },
  { name: "arXiv stat.ML", url: "https://rss.arxiv.org/rss/stat.ML" },
  { name: "AssemblyAI", url: "https://www.assemblyai.com/blog/rss/" },
  { name: "AutoGen", url: "https://microsoft.github.io/autogen/blog/rss.xml" },
  { name: "ClickHouse", url: "https://clickhouse.com/blog/rss.xml" },
  { name: "CockroachDB", url: "https://www.cockroachlabs.com/blog/feed/" },
  { name: "Cohere", url: "https://cohere.com/blog/rss.xml" },
  { name: "CrewAI", url: "https://www.crewai.com/blog/rss.xml" },
  { name: "CS.AI", url: "https://export.arxiv.org/rss/cs.AI" },
  { name: "CS.LG", url: "https://export.arxiv.org/rss/cs.LG" },
  { name: "Cursor", url: "https://any-feeds.com/api/feeds/custom/cmkoaiogm0000lf04qmtirq2g/rss.xml" },
  { name: "Datadog Engineering", url: "https://www.datadoghq.com/blog/feed/" },
  { name: "DigitalOcean", url: "https://www.digitalocean.com/blog/rss.xml" },
  { name: "DragonflyDB", url: "https://www.dragonflydb.io/blog/rss.xml" },
  { name: "DSPy", url: "https://dspy.ai/blog/rss.xml" },
  { name: "ElevenLabs", url: "https://releases.sh/elevenlabs/elevenlabs-changelog.atom" },
  { name: "FastAPI", url: "https://fastapi.tiangolo.com/blog/rss/" },
  { name: "Fastly", url: "https://www.fastly.com/blog/rss.xml" },
  { name: "Fiber", url: "https://gofiber.io/blog/rss.xml" },
  { name: "Fireworks AI", url: "https://fireworks.ai/blog/rss.xml" },
  { name: "Fly.io", url: "https://fly.io/blog/feed/" },
  { name: "Gin", url: "https://gin-gonic.com/index.xml" },
  { name: "GitHub Trending", url: "https://rsshub.app/github/trending/daily/any" },
  { name: "Google Cloud Blog", url: "https://cloud.google.com/blog/feeds/cloud.xml" },
  { name: "Haystack", url: "https://haystack.deepset.ai/blog/rss.xml" },
  { name: "High Scalability", url: "https://highscalability.com/rss/" },
  { name: "LangChain", url: "https://blog.langchain.dev/rss.xml" },
  { name: "LinkedIn Engineering", url: "https://www.linkedin.com/blog/engineering/feed" },
  { name: "LlamaIndex", url: "https://www.llamaindex.ai/blog/rss.xml" },
  { name: "Martin Fowler", url: "https://martinfowler.com/feeds.atom" },
  { name: "Meta AI", url: "https://rsshub.app/meta/ai/global-search/content_types=blog" },
  { name: "Milvus", url: "https://milvus.io/blog/rss.xml" },
  { name: "Mistral AI", url: "https://mistral.ai/news/rss" },
  { name: "MLX", url: "https://ml-explore.github.io/mlx/build/html/_static/rss.xml" },
  { name: "MongoDB", url: "https://www.mongodb.com/blog/feed" },
  { name: "NestJS", url: "https://nestjs.com/feed.xml" },
  { name: "Netlify", url: "https://www.netlify.com/blog/rss.xml" },
  { name: "Perplexity", url: "https://www.perplexity.ai/hub/blog/rss.xml" },
  { name: "Pinterest Engineering", url: "https://medium.com/pinterest-engineering/feed" },
  { name: "PlanetScale", url: "https://planetscale.com/blog/feed.xml" },
  { name: "Podman", url: "https://podman.io/blog/rss.xml" },
  { name: "Pulumi", url: "https://www.pulumi.com/blog/rss.xml" },
  { name: "Qdrant", url: "https://qdrant.tech/blog/rss.xml" },
  { name: "Qwen TTS", url: "https://github.com/QwenLM/Qwen/releases.atom" },
  { name: "Railway", url: "https://blog.railway.app/rss.xml" },
  { name: "Reddit r/LocalLLaMA", url: "https://www.reddit.com/r/LocalLLaMA/.rss" },
  { name: "Reddit r/MachineLearning", url: "https://www.reddit.com/r/MachineLearning/.rss" },
  { name: "Reddit r/programming", url: "https://www.reddit.com/r/programming/.rss" },
  { name: "Redis", url: "https://redis.io/feed" },
  { name: "Render", url: "https://render.com/blog/rss.xml" },
  { name: "Sebastian Raschka", url: "https://sebastianraschka.com/rss/" },
  { name: "SGLang", url: "https://lmsys.org/blog/rss.xml" },
  { name: "Shopify Engineering", url: "https://shopify.engineering/feed.xml" },
  { name: "Supabase", url: "https://supabase.com/blog/rss.xml" },
  { name: "Svelte", url: "https://svelte.dev/blog/rss.xml" },
  { name: "Swift Blog", url: "https://developer.apple.com/swift/blog/rss.xml" },
  { name: "Terraform", url: "https://www.hashicorp.com/blog/products/terraform/feed.xml" },
  { name: "Turso", url: "https://turso.tech/blog/rss.xml" },
  { name: "Uber Engineering", url: "https://eng.uber.com/feed/" },
  { name: "Valkey", url: "https://valkey.io/atom.xml" },
  { name: "Vercel", url: "https://vercel.com/blog/rss.xml" },
  { name: "vLLM", url: "https://vllm.ai/blog/rss.xml" },
  { name: "Vue", url: "https://blog.vuejs.org/rss.xml" },
  { name: "Windsurf", url: "https://devin.ai/rss.xml" },
  { name: "xAI", url: "https://releases.sh/xai.atom" },
  { name: "Zig", url: "https://ziglang.org/index.xml" }
];

// Helper for hash mapping (used in app)
export function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function run() {
  const { data: existingSources, error: e1 } = await supabase.from("sources").select("name");
  if (e1) throw e1;
  const existingNames = new Set(existingSources?.map(s => s.name) || []);

  const toInsert = [];
  for (const s of sourcesToRestore) {
    if (!existingNames.has(s.name)) {
      toInsert.push({
        id: `source-${simpleHash(s.name)}`,
        owner_id: ownerId,
        name: s.name,
        type: s.name.includes("GitHub") ? "atom" : "rss", // mostly rss
        url: s.url,
        trust_level: 0.8,
        rights_mode: "fair_use",
        enabled: true,
        updated_at: new Date().toISOString()
      });
    }
  }

  if (toInsert.length > 0) {
    console.log(`Restoring ${toInsert.length} sources...`);
    const { error } = await supabase.from("sources").insert(toInsert);
    if (error) console.error(error);
    else console.log("Done restoring!");
  } else {
    console.log("No sources needed restoring.");
  }
}
run();
