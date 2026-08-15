import type {
  ContentItem,
  InterestProfile,
  NormalizedCandidate,
  RadarTopic,
  TrendBucket,
} from "./types";

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(a|an|the|of|for|and|in|on|with|to)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalIdentifier(
  item: Pick<ContentItem, "doi" | "arxivId" | "canonicalUrl" | "title">,
): string {
  if (item.doi) return `doi:${item.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, "")}`;
  if (item.arxivId) return `arxiv:${item.arxivId.toLowerCase().replace(/v\d+$/, "")}`;

  try {
    const url = new URL(item.canonicalUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "source") {
        url.searchParams.delete(key);
      }
    }
    return `url:${url.toString().replace(/\/$/, "")}`;
  } catch {
    return `title:${normalizeTitle(item.title)}`;
  }
}

export function deduplicateItems<T extends ContentItem>(items: T[]): T[] {
  const byIdentity = new Map<string, T>();
  const titleIndex = new Map<string, string>();

  for (const item of items) {
    const identity = canonicalIdentifier(item);
    const titleKey = normalizeTitle(item.title);
    const existingKey = byIdentity.has(identity) ? identity : titleIndex.get(titleKey);

    if (!existingKey) {
      byIdentity.set(identity, item);
      titleIndex.set(titleKey, identity);
      continue;
    }

    const existing = byIdentity.get(existingKey);
    if (!existing || item.score > existing.score) {
      byIdentity.set(existingKey, item);
    }
  }

  return [...byIdentity.values()];
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

export function lexicalRelevance(item: NormalizedCandidate, interest: InterestProfile): number {
  const document = tokenSet(
    `${item.title} ${item.summary} ${item.topics.join(" ")} ${item.authors.join(" ")}`,
  );
  const query = tokenSet(
    `${interest.query} ${interest.keywords.join(" ")} ${interest.name}`,
  );
  const exclusions = interest.exclusions.map((value) => value.toLowerCase());

  if (
    exclusions.some((excluded) =>
      `${item.title} ${item.summary}`.toLowerCase().includes(excluded),
    )
  ) {
    return 0;
  }

  let overlap = 0;
  for (const token of query) {
    if (document.has(token)) overlap += 1;
  }
  return query.size ? Math.min(1, overlap / Math.max(3, query.size * 0.45)) : 0.5;
}

export function classifyTrend(
  publishedAt: string,
  citationCount: number,
  velocity = 0,
): TrendBucket {
  const ageDays = Math.max(
    0,
    (Date.now() - new Date(publishedAt).getTime()) / 86_400_000,
  );
  if (velocity >= 0.7 || (ageDays < 120 && citationCount > 120)) return "rising";
  if (ageDays > 900 && citationCount > 500) return "foundational";
  return "latest";
}

export function scoreCandidate(
  item: NormalizedCandidate,
  interests: InterestProfile[],
  options: {
    citationVelocity?: number;
    novelty?: number;
    feedbackBoost?: number;
    now?: Date;
  } = {},
): ContentItem {
  const enabled = interests.filter((interest) => interest.enabled);
  const relevance =
    enabled.length === 0
      ? 0.5
      : Math.max(
          ...enabled.map(
            (interest) => lexicalRelevance(item, interest) * interest.weight,
          ),
        );
  const now = options.now ?? new Date();
  const ageDays = Math.max(
    0,
    (now.getTime() - new Date(item.publishedAt).getTime()) / 86_400_000,
  );
  const freshness = Math.max(0, 1 - ageDays / 365);
  const impact = Math.min(1, Math.log10(item.citationCount + 1) / 4);
  const velocity = Math.max(0, Math.min(1, options.citationVelocity ?? 0));
  const novelty = Math.max(0, Math.min(1, options.novelty ?? 0.7));
  const feedback = Math.max(-0.2, Math.min(0.2, options.feedbackBoost ?? 0));

  const score =
    relevance * 0.38 +
    freshness * 0.18 +
    item.sourceAuthority * 0.14 +
    impact * 0.12 +
    velocity * 0.1 +
    novelty * 0.08 +
    feedback;

  return {
    ...item,
    score: Math.round(Math.max(0, Math.min(1, score)) * 100),
    trend: classifyTrend(item.publishedAt, item.citationCount, velocity),
    saved: false,
    listened: false,
    processingState: "ready",
  };
}

export function selectDigestItems(items: ContentItem[], limit = 5): ContentItem[] {
  const selected: ContentItem[] = [];
  const sourceCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();

  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const sourceCount = sourceCounts.get(item.sourceName) ?? 0;
    if (sourceCount >= 2) continue;
    const primaryTopic = item.topics[0] ?? "General";
    const topicCount = topicCounts.get(primaryTopic) ?? 0;
    if (topicCount >= 2) continue;

    selected.push(item);
    sourceCounts.set(item.sourceName, sourceCount + 1);
    topicCounts.set(primaryTopic, topicCount + 1);
    if (selected.length >= limit) break;
  }

  return selected;
}

export function selectTopItemPerSource(
  items: ContentItem[],
  sourceIds: string[],
): ContentItem[] {
  const selectedSourceIds = new Set(sourceIds);
  const bestBySource = new Map<string, ContentItem>();

  for (const item of items) {
    if (!item.sourceId || !selectedSourceIds.has(item.sourceId)) continue;

    const current = bestBySource.get(item.sourceId);
    if (
      !current ||
      item.score > current.score ||
      (item.score === current.score &&
        item.publishedAt.localeCompare(current.publishedAt) > 0)
    ) {
      bestBySource.set(item.sourceId, item);
    }
  }

  return [...selectedSourceIds]
    .map((sourceId) => bestBySource.get(sourceId))
    .filter((item): item is ContentItem => Boolean(item));
}

export function sourceSelectionCoverage(
  items: ContentItem[],
  sourceIds: string[],
): {
  selectedItems: ContentItem[];
  selectedSourceCount: number;
  readySourceCount: number;
  unavailableSourceCount: number;
} {
  const uniqueSourceIds = [...new Set(sourceIds)];
  const selectedItems = selectTopItemPerSource(items, uniqueSourceIds);

  return {
    selectedItems,
    selectedSourceCount: uniqueSourceIds.length,
    readySourceCount: selectedItems.length,
    unavailableSourceCount: Math.max(
      0,
      uniqueSourceIds.length - selectedItems.length,
    ),
  };
}

export type BriefingTopicCard = {
  id: string;
  topic: string;
  items: ContentItem[];
  availableBlogCount: number;
  availableSourceCount: number;
};

const BRIEFING_TOPIC_ALIASES: Record<string, readonly string[]> = {
  ai: ["ai", "artificial intelligence", "machine learning", "generative ai"],
  backend: [
    "backend",
    "back end",
    "server side",
    "api",
    "database",
    "microservice",
    "microservices",
  ],
  claude: ["claude", "anthropic"],
  gpt: ["gpt", "chatgpt"],
  infrastructure: [
    "infrastructure",
    "infra",
    "cloud infrastructure",
    "distributed systems",
    "platform engineering",
    "cloud",
    "devops",
    "kubernetes",
    "observability",
  ],
  llm: ["llm", "llms", "large language model", "large language models"],
};

function normalizeBriefingTopic(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function briefingTopicId(topic: string): string {
  return `briefing-topic:${normalizeBriefingTopic(topic)}`;
}

function containsTopicPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function briefingTopicMatchScore(item: ContentItem, topic: string): number {
  const topicKey = normalizeBriefingTopic(topic);
  if (!topicKey) return 0;
  const variants = (BRIEFING_TOPIC_ALIASES[topicKey] ?? [topicKey])
    .map(normalizeBriefingTopic);
  const normalizedTopics = item.topics.map(normalizeBriefingTopic);
  const title = normalizeBriefingTopic(item.title);
  const summary = normalizeBriefingTopic(item.summary);
  const sourceName = normalizeBriefingTopic(item.sourceName);

  let relevance = 0;
  for (const variant of variants) {
    if (normalizedTopics.some((value) => value === variant)) {
      relevance = Math.max(relevance, 100);
    } else if (normalizedTopics.some((value) => containsTopicPhrase(value, variant))) {
      relevance = Math.max(relevance, 80);
    }
    if (containsTopicPhrase(title, variant)) relevance = Math.max(relevance, 65);
    if (containsTopicPhrase(summary, variant)) relevance = Math.max(relevance, 35);
    if (containsTopicPhrase(sourceName, variant)) relevance = Math.max(relevance, 20);
  }

  if (relevance === 0) {
    const queryTokens = topicKey.split(" ").filter((token) => token.length > 2);
    const document = `${title} ${summary} ${normalizedTopics.join(" ")} ${sourceName}`;
    if (
      queryTokens.length > 1 &&
      queryTokens.every((token) => containsTopicPhrase(document, token))
    ) {
      relevance = 15;
    }
  }

  return relevance;
}

export function buildBriefingTopicCards(
  items: readonly ContentItem[],
  preferredTopics: readonly string[] = [],
  options: {
    sourceIds?: readonly string[];
    limit?: number;
    includeInferredTopics?: boolean;
    requireFullCard?: boolean;
  } = {},
): BriefingTopicCard[] {
  const requestedLimit = options.limit ?? 5;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(5, Math.max(0, Math.floor(requestedLimit)))
    : 0;
  if (limit === 0) return [];

  const allowedSourceIds = options.sourceIds
    ? new Set(options.sourceIds)
    : null;
  const eligibleItems = items.filter((item) => {
    const sourceId = item.sourceId;
    return item.kind === "blog" &&
      item.processingState === "ready" &&
      typeof sourceId === "string" &&
      (!allowedSourceIds || allowedSourceIds.has(sourceId));
  });
  if (eligibleItems.length === 0) return [];

  const topics: string[] = [];
  const seenTopics = new Set<string>();
  const addTopic = (value: string) => {
    const topic = value.trim().replace(/\s+/g, " ");
    const key = normalizeBriefingTopic(topic);
    if (!key || seenTopics.has(key)) return;
    seenTopics.add(key);
    topics.push(topic);
  };
  preferredTopics.forEach(addTopic);
  const preferredTopicCount = topics.length;
  if (options.includeInferredTopics !== false) {
    eligibleItems.forEach((item) => item.topics.forEach(addTopic));
  }

  const cards: BriefingTopicCard[] = [];
  const seenItemSets = new Set<string>();
  for (const [topicIndex, topic] of topics.entries()) {
    const matches = eligibleItems
      .map((item) => ({ item, relevance: briefingTopicMatchScore(item, topic) }))
      .filter((candidate) => candidate.relevance > 0)
      .sort((a, b) =>
        b.relevance - a.relevance ||
        b.item.score - a.item.score ||
        b.item.publishedAt.localeCompare(a.item.publishedAt) ||
        a.item.id.localeCompare(b.item.id)
      );
    if (matches.length === 0) continue;

    const sourceIds = new Set<string>();
    const contentIds = new Set<string>();
    const selectedItems: ContentItem[] = [];
    for (const { item } of matches) {
      const contentId = canonicalIdentifier(item);
      if (
        !item.sourceId ||
        sourceIds.has(item.sourceId) ||
        contentIds.has(contentId)
      ) continue;
      sourceIds.add(item.sourceId);
      contentIds.add(contentId);
      selectedItems.push(item);
      if (selectedItems.length === limit) break;
    }
    if (
      selectedItems.length === 0 ||
      (options.requireFullCard && selectedItems.length !== limit)
    ) continue;

    const itemSetKey = selectedItems.map((item) => item.id).sort().join("\u0000");
    if (topicIndex >= preferredTopicCount && seenItemSets.has(itemSetKey)) continue;
    seenItemSets.add(itemSetKey);

    cards.push({
      id: briefingTopicId(topic),
      topic,
      items: selectedItems,
      availableBlogCount: matches.length,
      availableSourceCount: new Set(
        matches.flatMap(({ item }) => item.sourceId ? [item.sourceId] : []),
      ).size,
    });
  }

  return cards;
}

export function hasBudgetForGeneration(
  spentUsd: number,
  budgetUsd: number,
  estimatedCostUsd: number,
): boolean {
  if (estimatedCostUsd <= 0) return true;
  return spentUsd + estimatedCostUsd <= budgetUsd;
}

export function buildTechRadar(
  items: ContentItem[],
  now = new Date(),
): RadarTopic[] {
  const topics = new Map<
    string,
    {
      name: string;
      recent: number;
      previous: number;
      sources: Set<string>;
      kinds: Set<ContentItem["kind"]>;
    }
  >();

  for (const item of items) {
    const ageDays = Math.max(
      0,
      (now.getTime() - new Date(item.publishedAt).getTime()) / 86_400_000,
    );
    if (ageDays > 180) continue;
    for (const topic of item.topics) {
      const key = normalizeTitle(topic);
      const aggregate = topics.get(key) ?? {
        name: topic,
        recent: 0,
        previous: 0,
        sources: new Set<string>(),
        kinds: new Set<ContentItem["kind"]>(),
      };
      if (ageDays <= 30) aggregate.recent += 1;
      else aggregate.previous += 1;
      aggregate.sources.add(item.sourceName);
      aggregate.kinds.add(item.kind);
      topics.set(key, aggregate);
    }
  }

  return [...topics.entries()]
    .map(([key, aggregate]): RadarTopic => {
      const change =
        aggregate.previous > 0
          ? Math.round(
              ((aggregate.recent - aggregate.previous / 5) /
                Math.max(1, aggregate.previous / 5)) *
                100,
            )
          : aggregate.recent * 18;
      const velocity = Math.max(8, Math.min(98, 50 + Math.round(change / 2)));
      const mentionCount = aggregate.recent + aggregate.previous;
      const volume = Math.max(28, Math.min(96, 30 + mentionCount * 9));
      const confidence = Math.max(
        35,
        Math.min(
          98,
          42 +
            aggregate.sources.size * 12 +
            (aggregate.kinds.size > 1 ? 10 : 0),
        ),
      );
      const lowerName = aggregate.name.toLowerCase();
      const category = /robot|embodied|vision-language-action/.test(lowerName)
        ? "Robotics"
        : /system|infra|database|observ|security|cloud/.test(lowerName)
          ? "Systems"
          : "Models";

      return {
        id: `radar-${key.replaceAll(" ", "-")}`,
        name: aggregate.name,
        category,
        velocity,
        volume,
        confidence,
        changeLabel: `${change >= 0 ? "+" : ""}${change}% in 30d`,
        itemCount: aggregate.sources.size,
        x: Math.min(88, Math.max(12, 18 + volume * 0.7)),
        y: Math.min(84, Math.max(12, 88 - velocity * 0.72)),
      };
    })
    .filter((topic) => topic.itemCount >= 2)
    .sort((a, b) => b.velocity * b.confidence - a.velocity * a.confidence)
    .slice(0, 8);
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
