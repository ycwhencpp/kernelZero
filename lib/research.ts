import { scoreCandidate } from "./domain";
import type {
  ContentItem,
  InterestProfile,
  NormalizedCandidate,
} from "./types";

const REQUEST_TIMEOUT_MS = 8_000;

function invertedAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const tokens: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) tokens.push([position, word]);
  }
  return tokens
    .sort((a, b) => a[0] - b[0])
    .map(([, word]) => word)
    .join(" ");
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export async function searchOpenAlex(query: string): Promise<NormalizedCandidate[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set(
    "select",
    "id,doi,title,publication_date,authorships,primary_topic,cited_by_count,open_access,abstract_inverted_index,primary_location",
  );
  url.searchParams.set("per-page", "12");
  url.searchParams.set("mailto", "creator@example.com");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`OpenAlex returned ${response.status}`);
  const payload = (await response.json()) as {
    results?: Array<Record<string, unknown>>;
  };

  return (payload.results ?? []).map((raw) => {
    const authorships = Array.isArray(raw.authorships)
      ? (raw.authorships as Array<{ author?: { display_name?: string } }>)
      : [];
    const openAccess = raw.open_access as { is_oa?: boolean; oa_url?: string } | undefined;
    const primaryLocation = raw.primary_location as
      | { landing_page_url?: string; pdf_url?: string; source?: { display_name?: string } }
      | undefined;
    const topic = raw.primary_topic as { display_name?: string } | undefined;
    const canonicalUrl =
      openAccess?.oa_url ||
      primaryLocation?.landing_page_url ||
      String(raw.doi || raw.id);

    return {
      id: `openalex-${String(raw.id).split("/").pop()}`,
      kind: "paper" as const,
      title: String(raw.title ?? "Untitled paper"),
      summary: invertedAbstract(
        raw.abstract_inverted_index as Record<string, number[]> | undefined,
      ),
      authors: authorships
        .map((entry) => entry.author?.display_name)
        .filter((value): value is string => Boolean(value)),
      sourceName: primaryLocation?.source?.display_name ?? "OpenAlex",
      canonicalUrl,
      doi: raw.doi ? String(raw.doi) : undefined,
      publishedAt: `${String(raw.publication_date ?? new Date().toISOString().slice(0, 10))}T00:00:00Z`,
      accessLevel: openAccess?.is_oa ? ("open_access" as const) : ("abstract_only" as const),
      peerReviewState: "unknown" as const,
      topics: topic?.display_name ? [topic.display_name] : ["Research"],
      citationCount: Number(raw.cited_by_count ?? 0),
      readingMinutes: 24,
      sourceAuthority: 0.9,
    };
  });
}

export async function searchSemanticScholar(
  query: string,
): Promise<NormalizedCandidate[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "12");
  url.searchParams.set(
    "fields",
    "paperId,title,abstract,authors,year,publicationDate,citationCount,url,openAccessPdf,venue,fieldsOfStudy,externalIds",
  );

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`Semantic Scholar returned ${response.status}`);
  const payload = (await response.json()) as {
    data?: Array<Record<string, unknown>>;
  };

  return (payload.data ?? []).map((raw) => {
    const externalIds = (raw.externalIds ?? {}) as {
      DOI?: string;
      ArXiv?: string;
    };
    const openAccessPdf = raw.openAccessPdf as { url?: string } | null;
    const authors = Array.isArray(raw.authors)
      ? (raw.authors as Array<{ name?: string }>)
      : [];

    return {
      id: `s2-${String(raw.paperId)}`,
      kind: "paper" as const,
      title: String(raw.title ?? "Untitled paper"),
      summary: String(raw.abstract ?? ""),
      authors: authors
        .map((author) => author.name)
        .filter((value): value is string => Boolean(value)),
      sourceName: String(raw.venue || "Semantic Scholar"),
      canonicalUrl: openAccessPdf?.url || String(raw.url),
      doi: externalIds.DOI,
      arxivId: externalIds.ArXiv,
      publishedAt:
        raw.publicationDate
          ? `${String(raw.publicationDate).slice(0, 10)}T00:00:00Z`
          : `${String(raw.year ?? new Date().getUTCFullYear())}-01-01T00:00:00Z`,
      accessLevel: openAccessPdf?.url
        ? ("open_access" as const)
        : ("abstract_only" as const),
      peerReviewState: raw.venue ? ("peer_reviewed" as const) : ("unknown" as const),
      topics: Array.isArray(raw.fieldsOfStudy)
        ? (raw.fieldsOfStudy as string[]).slice(0, 3)
        : ["Research"],
      citationCount: Number(raw.citationCount ?? 0),
      readingMinutes: 24,
      sourceAuthority: 0.92,
    };
  });
}

export async function searchArxiv(query: string): Promise<NormalizedCandidate[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query.replace(/\s+/g, "+")}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "12");
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");

  const response = await fetch(url, {
    headers: { Accept: "application/atom+xml" },
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
  const xml = await response.text();
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];

  return entries.map((entry) => {
    const read = (name: string) =>
      entry
        .match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]
        ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() ?? "";
    const idUrl = read("id");
    const arxivId = idUrl.split("/").pop()?.replace(/v\d+$/, "") ?? idUrl;
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((match) => match[1].trim())
      .slice(0, 8);
    const categories = [...entry.matchAll(/<category[^>]+term=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .slice(0, 3);

    return {
      id: `arxiv-${arxivId}`,
      kind: "paper" as const,
      title: read("title"),
      summary: read("summary"),
      authors,
      sourceName: "arXiv",
      canonicalUrl: idUrl,
      arxivId,
      publishedAt: read("published") || new Date().toISOString(),
      accessLevel: "open_access" as const,
      peerReviewState: "preprint" as const,
      topics: categories.length ? categories : ["Preprint"],
      citationCount: 0,
      readingMinutes: 24,
      sourceAuthority: 0.86,
    };
  });
}

export async function discoverResearch(
  interest: InterestProfile,
): Promise<{ items: ContentItem[]; warnings: string[] }> {
  const calls = [
    ["OpenAlex", searchOpenAlex(interest.query)],
    ["Semantic Scholar", searchSemanticScholar(interest.query)],
    ["arXiv", searchArxiv(interest.query)],
  ] as const;
  const settled = await Promise.allSettled(calls.map(([, call]) => call));
  const candidates: NormalizedCandidate[] = [];
  const warnings: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") candidates.push(...result.value);
    else warnings.push(`${calls[index][0]}: ${String(result.reason)}`);
  });

  return {
    items: candidates
      .map((candidate) => scoreCandidate(candidate, [interest]))
      .sort((a, b) => b.score - a.score),
    warnings,
  };
}
