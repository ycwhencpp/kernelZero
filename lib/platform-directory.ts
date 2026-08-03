import "server-only";

import { mediaUrl } from "./media-path";
import { safeAvatarUrl } from "./profile-avatar";
import { getSupabase } from "./supabase";

type Row = Record<string, unknown>;

export type PlatformCreator = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  joinedAt: string;
  episodeCount: number;
  totalDurationSeconds: number;
};

export type PlatformEpisode = {
  id: string;
  creatorId: string;
  type: string;
  title: string;
  dek: string;
  audioUrl: string;
  durationSeconds: number;
  publishedAt: string;
  citationCount: number;
  creator: PlatformCreator;
};

export type PlatformDirectory = {
  creators: PlatformCreator[];
  episodes: PlatformEpisode[];
  page: number;
  pageSize: number;
  totalEpisodes: number;
  totalPages: number;
};

export const PLATFORM_DIRECTORY_DEFAULT_PAGE_SIZE = 24;
export const PLATFORM_DIRECTORY_MAX_PAGE_SIZE = 48;

const EPISODE_FIELDS =
  "id,owner_id,type,title,dek,audio_key,duration_seconds,published_at,created_at,citation_count" as const;

const PROFILE_FIELDS =
  "id,email,display_name,avatar_url,auth_user_id,created_at" as const;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoValue(value: unknown): string {
  const date = new Date(stringValue(value));
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}

function durationValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.trunc(value);
}

function fallbackCreator(
  ownerId: string,
  joinedAt: string,
): PlatformCreator {
  const email = ownerId.includes("@") ? ownerId : "";
  return {
    id: ownerId,
    displayName: email.split("@")[0] || "KernelZero creator",
    email,
    avatarUrl: null,
    joinedAt,
    episodeCount: 0,
    totalDurationSeconds: 0,
  };
}

function mapCreator(row: Row): PlatformCreator {
  const id = stringValue(row.id);
  const email = stringValue(row.email);
  const authUserId = stringValue(row.auth_user_id);
  return {
    id,
    displayName:
      stringValue(row.display_name).trim() ||
      email.split("@")[0] ||
      "KernelZero creator",
    email,
    avatarUrl: authUserId
      ? safeAvatarUrl(row.avatar_url, authUserId)
      : null,
    joinedAt: isoValue(row.created_at),
    episodeCount: 0,
    totalDurationSeconds: 0,
  };
}

function usableEpisodeRows(rows: Row[]): Row[] {
  return rows.filter(
    (row) =>
      stringValue(row.id) &&
      stringValue(row.owner_id) &&
      stringValue(row.audio_key).trim(),
  );
}

async function loadCreatorRows(ownerIds: string[]): Promise<Row[]> {
  const db = getSupabase();
  if (!db || ownerIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let index = 0; index < ownerIds.length; index += 100) {
    chunks.push(ownerIds.slice(index, index + 100));
  }

  const results = await Promise.all(
    chunks.map((ids) =>
      db.from("profiles").select(PROFILE_FIELDS).in("id", ids),
    ),
  );
  const error = results.find((result) => result.error)?.error;
  if (error) {
    throw new Error(`Unable to load platform creators: ${error.message}`);
  }
  return results.flatMap(
    (result) => (result.data ?? []) as unknown as Row[],
  );
}

function composeDirectory(
  episodeRows: Row[],
  profileRows: Row[],
  pagination?: {
    page: number;
    pageSize: number;
    totalEpisodes: number;
    totalPages: number;
  },
): PlatformDirectory {
  const rows = usableEpisodeRows(episodeRows);
  const earliestByOwner = new Map<string, string>();

  for (const row of rows) {
    const ownerId = stringValue(row.owner_id);
    const createdAt = isoValue(row.created_at);
    const current = earliestByOwner.get(ownerId);
    if (!current || createdAt < current) earliestByOwner.set(ownerId, createdAt);
  }

  const creators = new Map<string, PlatformCreator>(
    profileRows.map((row) => {
      const creator = mapCreator(row);
      return [creator.id, creator];
    }),
  );

  for (const [ownerId, joinedAt] of earliestByOwner) {
    if (!creators.has(ownerId)) {
      creators.set(ownerId, fallbackCreator(ownerId, joinedAt));
    }
  }

  for (const row of rows) {
    const creator = creators.get(stringValue(row.owner_id));
    if (!creator) continue;
    creator.episodeCount += 1;
    creator.totalDurationSeconds += durationValue(row.duration_seconds);
  }

  const episodes = rows.flatMap((row): PlatformEpisode[] => {
    const creator = creators.get(stringValue(row.owner_id));
    if (!creator) return [];
    return [
      {
        id: stringValue(row.id),
        creatorId: creator.id,
        type: stringValue(row.type),
        title: stringValue(row.title),
        dek: stringValue(row.dek),
        audioUrl: mediaUrl(stringValue(row.audio_key)),
        durationSeconds: durationValue(row.duration_seconds),
        publishedAt: isoValue(row.published_at || row.created_at),
        citationCount: durationValue(row.citation_count),
        creator,
      },
    ];
  });

  const defaultTotal = rows.length;
  return {
    creators: [...creators.values()]
      .filter((creator) => creator.episodeCount > 0)
      .sort(
        (left, right) =>
          right.episodeCount - left.episodeCount ||
          left.displayName.localeCompare(right.displayName),
      ),
    episodes,
    page: pagination?.page ?? 1,
    pageSize:
      pagination?.pageSize ??
      Math.max(1, Math.min(PLATFORM_DIRECTORY_DEFAULT_PAGE_SIZE, defaultTotal)),
    totalEpisodes: pagination?.totalEpisodes ?? defaultTotal,
    totalPages:
      pagination?.totalPages ??
      (defaultTotal > 0 ? 1 : 0),
  };
}

/**
 * Returns only fields intended for the signed-in platform directory.
 * Draft scripts, transcripts, show notes, source records, and workspace settings
 * never cross this boundary.
 */
export async function getPlatformDirectory(
  options: { page?: number; pageSize?: number } = {},
): Promise<PlatformDirectory> {
  const requestedPage = positiveInteger(options.page, 1);
  const pageSize = Math.min(
    PLATFORM_DIRECTORY_MAX_PAGE_SIZE,
    positiveInteger(
      options.pageSize,
      PLATFORM_DIRECTORY_DEFAULT_PAGE_SIZE,
    ),
  );
  const db = getSupabase();
  if (!db) {
    return {
      creators: [],
      episodes: [],
      page: 1,
      pageSize,
      totalEpisodes: 0,
      totalPages: 0,
    };
  }

  const loadPage = (page: number) => {
    const from = (page - 1) * pageSize;
    return db
      .from("episodes")
      .select(EPISODE_FIELDS, { count: "exact" })
      .eq("status", "published")
      .not("audio_key", "is", null)
      .neq("audio_key", "")
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
  };

  let result = await loadPage(requestedPage);
  if (result.error) {
    throw new Error(
      `Unable to load published podcasts: ${result.error.message}`,
    );
  }

  const totalEpisodes = result.count ?? 0;
  const totalPages =
    totalEpisodes > 0 ? Math.ceil(totalEpisodes / pageSize) : 0;
  const page =
    totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;

  if (page !== requestedPage) {
    result = await loadPage(page);
    if (result.error) {
      throw new Error(
        `Unable to load published podcasts: ${result.error.message}`,
      );
    }
  }

  const episodeRows = (result.data ?? []) as unknown as Row[];
  const ownerIds = [
    ...new Set(episodeRows.map((row) => stringValue(row.owner_id)).filter(Boolean)),
  ];
  const profileRows = await loadCreatorRows(ownerIds);
  return composeDirectory(episodeRows, profileRows, {
    page,
    pageSize,
    totalEpisodes,
    totalPages,
  });
}

export async function getPlatformCreator(
  creatorId: string,
): Promise<{ creator: PlatformCreator; episodes: PlatformEpisode[] } | null> {
  const db = getSupabase();
  if (!db || !creatorId) return null;

  const [profileResult, episodeResult] = await Promise.all([
    db
      .from("profiles")
      .select(PROFILE_FIELDS)
      .eq("id", creatorId)
      .maybeSingle(),
    db
      .from("episodes")
      .select(EPISODE_FIELDS)
      .eq("owner_id", creatorId)
      .eq("status", "published")
      .not("audio_key", "is", null)
      .neq("audio_key", "")
      .order("published_at", { ascending: false }),
  ]);

  if (profileResult.error) {
    throw new Error(`Unable to load creator: ${profileResult.error.message}`);
  }
  if (episodeResult.error) {
    throw new Error(
      `Unable to load creator podcasts: ${episodeResult.error.message}`,
    );
  }

  const episodeRows = (episodeResult.data ?? []) as unknown as Row[];
  if (!profileResult.data && episodeRows.length === 0) return null;

  const directory = composeDirectory(
    episodeRows,
    profileResult.data ? [profileResult.data as unknown as Row] : [],
  );
  const creator =
    directory.creators[0] ||
    (profileResult.data
      ? mapCreator(profileResult.data as unknown as Row)
      : null);
  return creator ? { creator, episodes: directory.episodes } : null;
}
