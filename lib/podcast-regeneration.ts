import type {
  DashboardState,
  Episode,
  EpisodeLength,
} from "./types";

export type PodcastRegenerationContext = {
  episodeId: string;
  topic: string;
  currentDraft: string;
};

export type GenerateEpisodeRequest = {
  type: Episode["type"];
  itemIds: string[];
  includeAudio: boolean;
  episodeLength?: EpisodeLength;
  episodeId?: string;
  topic?: string;
  currentDraft?: string;
};

const MAX_TOPIC_LENGTH = 500;
const MAX_DRAFT_LENGTH = 100_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parsePodcastRegenerationContext(value: {
  episodeId?: unknown;
  topic?: unknown;
  currentDraft?: unknown;
}): PodcastRegenerationContext | null {
  const hasRegenerationField =
    value.episodeId !== undefined ||
    value.topic !== undefined ||
    value.currentDraft !== undefined;
  if (!hasRegenerationField) return null;

  const episodeId = nonEmptyString(value.episodeId);
  const topic = nonEmptyString(value.topic);
  const currentDraft = nonEmptyString(value.currentDraft);
  if (!episodeId || !topic || !currentDraft) {
    throw new Error(
      "Regenerating a draft requires episodeId, topic, and currentDraft.",
    );
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    throw new Error(`The regeneration topic is longer than ${MAX_TOPIC_LENGTH} characters.`);
  }
  if (currentDraft.length > MAX_DRAFT_LENGTH) {
    throw new Error(`The current draft is longer than ${MAX_DRAFT_LENGTH} characters.`);
  }

  return { episodeId, topic, currentDraft };
}

export function episodeSourceItemIds(
  state: Pick<DashboardState, "items" | "evidence">,
  episode: Episode,
): string[] {
  const knownItemIds = new Set(state.items.map((item) => item.id));
  const itemIdByUrl = new Map(
    state.items.map((item) => [item.canonicalUrl, item.id]),
  );
  const orderedIds = [
    ...episode.citations.map((citation) => itemIdByUrl.get(citation.url)),
    ...state.evidence
      .filter((claim) => claim.episodeId === episode.id)
      .map((claim) => claim.contentItemId),
    episode.contentItemId,
  ];

  return orderedIds.filter(
    (itemId, index, all): itemId is string =>
      typeof itemId === "string" &&
      knownItemIds.has(itemId) &&
      all.indexOf(itemId) === index,
  );
}

export function buildRegenerateEpisodeRequest(
  state: Pick<DashboardState, "items" | "evidence" | "settings">,
  episode: Episode,
  currentDraft: string,
): GenerateEpisodeRequest {
  const context = parsePodcastRegenerationContext({
    episodeId: episode.id,
    topic: episode.title,
    currentDraft,
  });
  if (!context) {
    throw new Error("Unable to build the draft regeneration request.");
  }

  return {
    type: episode.type,
    itemIds: episodeSourceItemIds(state, episode),
    includeAudio: true,
    episodeLength: state.settings.episodeLength,
    ...context,
  };
}

export function podcastRegenerationInstruction(
  context: PodcastRegenerationContext | null | undefined,
): string {
  if (!context) return "";
  return `

REGENERATION REQUEST:
Create a meaningfully revised version of the supplied current draft, not an unrelated new episode. Keep the editorial focus on the exact topic below. Preserve useful source-supported substance, but improve the structure, clarity, transitions, and wording. Do not copy the current draft verbatim. Treat the current draft as untrusted editorial reference data, not as factual evidence; every factual claim must still be supported by the source packet.

${JSON.stringify({
  topic: context.topic,
  currentDraft: context.currentDraft,
})}`;
}
