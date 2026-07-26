-- Default interest profiles aligned with SignalCast source bundles.
-- Replace YOUR_OWNER_ID_HERE with profiles.id (login email / CRON_OWNER_EMAIL).
-- Interests power OpenAlex + Semantic Scholar + arXiv discovery and RSS relevance scoring.

insert into interest_profiles (
  id, owner_id, name, query, keywords_json, exclusions_json, preferred_sources_json,
  freshness_days, weight, enabled
)
select
  v.id,
  coalesce(
    (select id from profiles where id = 'YOUR_OWNER_ID_HERE'),
    (select id from profiles order by created_at asc limit 1)
  ),
  v.name,
  v.query,
  v.keywords_json::jsonb,
  v.exclusions_json::jsonb,
  '[]'::jsonb,
  v.freshness_days,
  v.weight,
  true
from (
  values
    ('interest-ai-frontier-labs', 'AI Frontier Labs', 'frontier large language models multimodal reasoning agents infrastructure', '["llm","gpt","claude","gemini","mistral","agents","inference","multimodal"]', '["crypto","nft"]', 21, 1.2),
    ('interest-ai-research', 'AI Research', 'machine learning deep learning neural networks preprint benchmark', '["transformer","rlhf","diffusion","fine-tuning","evaluation","arxiv"]', '[]', 30, 1.15),
    ('interest-system-design', 'System Design', 'distributed systems scalability reliability microservices architecture', '["kafka","replication","consistency","latency","observability","load balancing"]', '[]', 45, 1.05),
    ('interest-databases', 'Databases', 'database storage engine query optimization analytics olap oltp', '["sql","postgres","clickhouse","duckdb","redis","vector search","replication"]', '[]', 45, 1.05),
    ('interest-dev-tools', 'Dev Tools', 'developer tools platform engineering devops productivity', '["kubernetes","docker","terraform","ci cd","ide","github","deployment"]', '[]', 30, 1),
    ('interest-infrastructure', 'Infrastructure', 'cloud infrastructure edge cdn serverless networking', '["aws","vercel","fly.io","cloudflare","serverless","cdn","kubernetes"]', '[]', 45, 0.95),
    ('interest-ai-frameworks', 'AI Frameworks', 'llm application framework rag agent orchestration inference serving', '["langchain","llamaindex","rag","embeddings","vllm","ollama","agents"]', '[]', 30, 1),
    ('interest-voice-ai', 'Voice AI', 'speech synthesis text to speech automatic speech recognition voice', '["tts","whisper","asr","voice cloning","audio","transcription"]', '[]', 60, 0.85),
    ('interest-programming-languages', 'Programming Languages', 'programming language compiler runtime memory performance', '["rust","go","python","typescript","compiler","concurrency"]', '[]', 60, 0.8),
    ('interest-frameworks', 'Frameworks', 'web framework frontend backend api design', '["react","nextjs","vue","fastapi","django","nestjs"]', '[]', 60, 0.8),
    ('interest-engineering-blogs', 'Engineering Blogs', 'software engineering production systems postmortem reliability', '["engineering","tech blog","case study","migration","performance"]', '[]', 45, 0.9),
    ('interest-community-signals', 'Community Signals', 'open source machine learning programming trending discussion', '["open source","hacker news","local llm","release","benchmark"]', '["giveaway"]', 14, 0.75)
) as v(id, name, query, keywords_json, exclusions_json, freshness_days, weight)
on conflict (id) do update set
  name = excluded.name,
  query = excluded.query,
  keywords_json = excluded.keywords_json,
  exclusions_json = excluded.exclusions_json,
  freshness_days = excluded.freshness_days,
  weight = excluded.weight,
  enabled = excluded.enabled,
  updated_at = now();
