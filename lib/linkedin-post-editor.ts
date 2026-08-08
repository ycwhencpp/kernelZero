export type LinkedInPostEditorDraft = {
  episodeId: string;
  persistedPost: string | null;
  value: string | null;
};

export function linkedInPostEditorDraft(
  episodeId: string,
  persistedPost: string | null,
  value: string | null = persistedPost,
): LinkedInPostEditorDraft {
  return { episodeId, persistedPost, value };
}

export function resolveLinkedInPostEditorValue(
  draft: LinkedInPostEditorDraft,
  episodeId: string,
  persistedPost: string | null,
): string | null {
  return draft.episodeId === episodeId && draft.persistedPost === persistedPost
    ? draft.value
    : persistedPost;
}
