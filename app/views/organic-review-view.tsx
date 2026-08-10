"use client";

import { useState } from "react";
import type {
  AppUser,
  DashboardState,
  Episode,
  EpisodeAudioVariant,
} from "../../lib/types";
import { formatDuration } from "../../lib/domain";
import { PLAYBACK_RATE_OPTIONS } from "../../lib/playback";
import {
  mapTranscriptParagraphsToChapters,
  transcriptParagraphs,
} from "../../lib/chapter-mapping";
import {
  resolveReviewVoiceId,
  reviewAudioButtonLabel,
} from "../../lib/review-audio-state";
import {
  linkedInPostEditorDraft,
  resolveLinkedInPostEditorValue,
} from "../../lib/linkedin-post-editor";
import {
  appendLinkedInPostSource,
  containsLinkedInPostSourceReference,
  LINKEDIN_POST_MAX_CHARACTERS,
  linkedInPostCharacterCount,
  primaryLinkedInPostSource,
  replaceLinkedInPostContent,
  resolveLinkedInSourceCta,
  splitLinkedInPostSource,
} from "../../lib/linkedin-post-format";

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export function OrganicReviewView({
  state,
  episode,
  playingId,
  playbackSeconds,
  playbackDuration,
  playbackRate,
  audioStatus,
  backLabel,
  onBack,
  onApprove,
  onRegenerateDraft,
  onPreview,
  onSeek,
  onSeekTo,
  onPlaybackRateChange,
  onEdit,
  onGenerateLinkedInPost,
  onSaveLinkedInPost,
  onRegenerateAudio,
  selectedAudioVariant,
  onAudioVariantChange,
  onSetDefaultAudioVariant,
  onExport,
  onNotify,
  busy,
  canEdit,
  canPublish,
  user,
}: {
  state: DashboardState;
  episode: Episode;
  playingId: string | null;
  playbackSeconds: number;
  playbackDuration: number;
  playbackRate: number;
  audioStatus: "missing" | "loading" | "ready" | "error";
  backLabel: string;
  onBack: () => void;
  onApprove: (overrideTitleWarning?: boolean) => void;
  onRegenerateDraft: (currentDraft: string) => void;
  onPreview: () => void;
  onSeek: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onEdit: (draft: Pick<Episode, "title" | "dek" | "script">) => Promise<boolean>;
  onGenerateLinkedInPost: () => Promise<string | null>;
  onSaveLinkedInPost: (post: string) => Promise<string | null>;
  onRegenerateAudio: (voiceId: string | null) => void;
  selectedAudioVariant: EpisodeAudioVariant | null;
  onAudioVariantChange: (id: string) => void;
  onSetDefaultAudioVariant: (id: string) => void;
  onExport: () => void;
  onNotify: (message: string) => void;
  busy: string | null;
  canEdit: boolean;
  canPublish: boolean;
  user: AppUser;
}) {
  const evidence = state.evidence.filter((claim) => claim.episodeId === episode.id);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(episode.title);
  const [dekDraft, setDekDraft] = useState(episode.dek);
  const [scriptDraft, setScriptDraft] = useState(episode.script);
  const persistedLinkedInPost = episode.linkedInPost ?? null;
  const [linkedInDraft, setLinkedInDraft] = useState(() =>
    linkedInPostEditorDraft(episode.id, persistedLinkedInPost),
  );
  const storedLinkedInPost = resolveLinkedInPostEditorValue(
    linkedInDraft,
    episode.id,
    persistedLinkedInPost,
  );
  const storedLinkedInParts = storedLinkedInPost
    ? splitLinkedInPostSource(storedLinkedInPost)
    : { content: "", sourceCta: null, sourceFooter: null };
  const linkedInSource = primaryLinkedInPostSource(episode, state.items);
  const linkedInSourceCta = resolveLinkedInSourceCta(
    storedLinkedInPost,
    storedLinkedInParts.content.trim() || episode.title,
  );
  const linkedInPost =
    storedLinkedInPost?.trim() &&
    storedLinkedInParts.content.trim() &&
    linkedInSource
      ? appendLinkedInPostSource(
          storedLinkedInParts.content,
          linkedInSource,
          linkedInSourceCta,
        )
      : storedLinkedInPost;
  const updateLinkedInPost = (value: string | null) => {
    setLinkedInDraft(
      linkedInPostEditorDraft(episode.id, persistedLinkedInPost, value),
    );
  };
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [preferredVoiceId, setPreferredVoiceId] = useState<string | null>(
    () => state.voiceProfile?.id ?? state.voiceProfiles[0]?.id ?? null,
  );
  const selectedVoiceId = resolveReviewVoiceId(
    state.voiceProfiles,
    preferredVoiceId,
  );
  const audioVariants = episode.audioVariants ?? [];
  const defaultAudioVariant =
    audioVariants.find(
      (variant) => variant.id === episode.defaultAudioVariantId,
    ) ??
    audioVariants.find((variant) => variant.isDefault) ??
    null;
  const activeAudioVariant =
    (selectedAudioVariant &&
    audioVariants.some((variant) => variant.id === selectedAudioVariant.id)
      ? selectedAudioVariant
      : null) ??
    defaultAudioVariant ??
    audioVariants[0] ??
    null;
  const selectedNarrator = state.voiceProfiles.find(
    (voice) => voice.id === selectedVoiceId,
  );
  const selectedNarratorVariant = audioVariants.find(
    (variant) => variant.voiceId === selectedVoiceId,
  );
  const selectedNarratorName =
    selectedNarrator?.name ??
    selectedNarratorVariant?.voiceName ??
    "system voice";
  const audioGenerationBusy = busy === `audio:${episode.id}`;
  const selectedVariantIsDefault = Boolean(
    activeAudioVariant &&
      (activeAudioVariant.id === defaultAudioVariant?.id ||
        activeAudioVariant.isDefault),
  );
  const transcriptParts = transcriptParagraphs(episode.script);
  const sourceDurationSeconds =
    activeAudioVariant?.durationSeconds ?? episode.durationSeconds;
  const sourceChapters = activeAudioVariant?.chapters?.length
    ? activeAudioVariant.chapters
    : episode.chapters;
  const hasAudio = Boolean(activeAudioVariant?.audioUrl ?? episode.audioUrl);
  const audioReady = hasAudio && audioStatus === "ready";
  const audioPreparing = audioStatus === "loading" ||
    (hasAudio && audioStatus === "missing");
  const duration = audioReady ? Math.max(1, playbackDuration) : 0;
  const rawChapters = sourceChapters.length
    ? sourceChapters
    : transcriptParts.map((paragraph, index) => ({
        title: `Section ${index + 1}`,
        startSeconds: Math.round(
          (sourceDurationSeconds * index) /
            Math.max(1, transcriptParts.length),
        ),
        scriptStart: paragraph.scriptStart,
      }));
  const chapterScale = audioReady
    ? duration / Math.max(1, sourceDurationSeconds)
    : 1;
  const chapters = rawChapters.map((chapter) => ({
    ...chapter,
    startSeconds: Math.min(
      duration || sourceDurationSeconds,
      chapter.startSeconds * chapterScale,
    ),
  }));
  const paragraphs = mapTranscriptParagraphsToChapters(
    episode.script,
    rawChapters,
  );
  const activeChapterIndex = chapters.reduce(
    (active, chapter, index) =>
      playbackSeconds >= chapter.startSeconds ? index : active,
    0,
  );
  const canEditDraft =
    canEdit &&
    (episode.status === "needs_approval" || episode.status === "draft");
  const canApprove = canPublish && episode.status === "needs_approval";
  const hasTitleValidationWarning =
    episode.generationWarning === "title_validation_failed";
  const hasLengthWarning = episode.generationWarning === "length_below_target";
  const hasGenerationWarning = episode.generationWarning !== null &&
    episode.generationWarning !== undefined;
  const linkedInBusy = busy === `linkedin:${episode.id}`;
  const linkedInSaving = busy === `linkedin-save:${episode.id}`;
  const linkedInDirty =
    linkedInPost !== null && linkedInPost !== persistedLinkedInPost;
  const linkedInCharacterCount = linkedInPost
    ? linkedInPostCharacterCount(linkedInPost)
    : 0;
  const linkedInParts = linkedInPost
    ? splitLinkedInPostSource(linkedInPost)
    : { content: "", sourceCta: null, sourceFooter: null };
  const linkedInHasContent = Boolean(linkedInParts.content.trim());
  const linkedInHasSource = linkedInParts.sourceFooter !== null;
  const linkedInHasExtraSource = containsLinkedInPostSourceReference(
    linkedInParts.content,
  );
  const linkedInTooLong =
    linkedInCharacterCount > LINKEDIN_POST_MAX_CHARACTERS;
  const generateLinkedInPost = async () => {
    const post = await onGenerateLinkedInPost();
    if (post !== null) {
      updateLinkedInPost(post);
      setCopyStatus("idle");
    }
  };
  const saveLinkedInPost = async () => {
    if (!linkedInPost?.trim() || !linkedInHasContent) return;
    const savedPost = await onSaveLinkedInPost(linkedInPost);
    if (savedPost !== null) {
      updateLinkedInPost(savedPost);
    }
  };
  const copyLinkedInPost = async () => {
    if (!linkedInPost) return;

    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.clipboard?.writeText === "function"
      ) {
        await navigator.clipboard.writeText(linkedInPost);
      } else {
        const copyTarget = document.createElement("textarea");
        copyTarget.value = linkedInPost;
        copyTarget.setAttribute("readonly", "");
        copyTarget.setAttribute("aria-hidden", "true");
        copyTarget.setAttribute("tabindex", "-1");
        copyTarget.style.position = "fixed";
        copyTarget.style.top = "0";
        copyTarget.style.opacity = "0";
        copyTarget.style.pointerEvents = "none";
        document.body.appendChild(copyTarget);
        let copied = false;
        try {
          copyTarget.focus();
          copyTarget.select();
          copyTarget.setSelectionRange(0, copyTarget.value.length);
          copied = document.execCommand("copy");
        } finally {
          copyTarget.remove();
        }
        if (!copied) throw new Error("Copy command was unavailable.");
      }
      setCopyStatus("copied");
      onNotify("LinkedIn post copied to your clipboard.");
      window.setTimeout(() => setCopyStatus("idle"), 2400);
    } catch {
      setCopyStatus("failed");
      onNotify("Unable to copy automatically. Select the post and copy it manually.");
    }
  };
  const revealChapter = (seconds: number) => {
    if (audioReady) onSeekTo(seconds);
    const chapterIndex = chapters.reduce(
      (active, chapter, index) =>
        seconds >= chapter.startSeconds ? index : active,
      0,
    );
    document
      .getElementById(
        `review-section-${Math.max(
          0,
          paragraphs.findIndex(
            (paragraph) => paragraph.chapterIndex === chapterIndex,
          ),
        )}`,
      )
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const resetDraft = () => {
    setTitleDraft(episode.title);
    setDekDraft(episode.dek);
    setScriptDraft(episode.script);
  };
  const toggleEditing = () => {
    resetDraft();
    setEditing((value) => !value);
  };
  const saveDraft = async () => {
    const saved = await onEdit({
      title: titleDraft.trim(),
      dek: dekDraft.trim(),
      script: scriptDraft,
    });
    if (saved) setEditing(false);
  };
  const approve = () => {
    const confirmation = hasTitleValidationWarning
      ? "The title still does not pass transcript-alignment validation. Publish this episode anyway?"
      : hasLengthWarning
        ? "This transcript is shorter than the selected episode length. Publish this episode anyway?"
        : null;
    if (confirmation && !window.confirm(confirmation)) return;
    onApprove(hasGenerationWarning);
  };

  return (
    <div className="organic-review">
      <header className="organic-review-top">
        <button type="button" className="organic-text-link" onClick={onBack}>
          ← Back to {backLabel}
        </button>
        <div className="organic-review-user">
          <span>
            <strong>{user.displayName}</strong>
            <small>{user.role.toUpperCase()}</small>
          </span>
          <img src={user.avatarUrl || "/user-placeholder.svg"} alt="" />
        </div>
      </header>

      <div className="organic-review-banner">
        <span className="organic-eyebrow">
          {episode.status === "needs_approval"
            ? "DRAFT: NEEDS REVIEW"
            : titleCase(episode.status)}
        </span>
        <p className="organic-eyebrow">
          EPISODE #{episode.generation} • {titleCase(episode.type)}
        </p>
        {editing ? (
          <div className="organic-review-metadata-editor">
            <label htmlFor="review-episode-title">
              <span>Episode title</span>
              <input
                id="review-episode-title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={500}
              />
            </label>
            <label htmlFor="review-episode-dek">
              <span>Episode summary</span>
              <textarea
                id="review-episode-dek"
                value={dekDraft}
                onChange={(event) => setDekDraft(event.target.value)}
                rows={3}
              />
            </label>
          </div>
        ) : (
          <>
            <h1>{episode.title}</h1>
            {episode.dek && <p className="organic-review-dek">{episode.dek}</p>}
          </>
        )}
        {hasTitleValidationWarning && (
          <aside className="organic-review-warning" role="alert">
            <strong>Title needs review</strong>
            <p>
              The generated title did not pass transcript-alignment validation.
              Edit the title or transcript and save to recheck it before publishing.
            </p>
          </aside>
        )}
        {hasLengthWarning && (
          <aside className="organic-review-warning" role="alert">
            <strong>Transcript runs short</strong>
            <p>
              The generation passes could not reach the selected episode length.
              Extend the transcript with source-backed detail and save to recheck
              it, or publish the shorter episode deliberately.
            </p>
          </aside>
        )}
        <div className="organic-review-stats">
          <span>
            {audioReady
              ? `${formatDuration(duration)} audio`
              : audioPreparing
                ? "Preparing audio"
                : audioStatus === "error"
                  ? "Audio unavailable"
                  : "No audio generated"}
          </span>
          <span>{episode.citations.length} sources cited</span>
          <span>{titleCase(episode.status)}</span>
        </div>
        <div className="organic-review-actions">
          <button
            type="button"
            className="organic-btn organic-btn-outline"
            disabled={busy !== null}
            onClick={() => onRegenerateDraft(editing ? scriptDraft : episode.script)}
          >
            Regenerate Draft
          </button>
          <div className="organic-review-audio-control">
            <label
              className="organic-review-voice-picker"
              htmlFor="review-audio-voice"
            >
              <span>Voice for regeneration</span>
              <select
                id="review-audio-voice"
                value={selectedVoiceId ?? ""}
                disabled={
                  busy !== null ||
                  state.voiceProfiles.length === 0
                }
                onChange={(event) =>
                  setPreferredVoiceId(event.target.value || null)
                }
              >
                {state.voiceProfiles.length === 0 ? (
                  <option value="">Configured system voice</option>
                ) : (
                  state.voiceProfiles.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}{voice.active ? " (primary)" : ""}
                    </option>
                  ))
                )}
              </select>
            </label>
            <button
              type="button"
              className="organic-btn organic-btn-outline"
              disabled={busy !== null}
              aria-busy={audioGenerationBusy}
              onClick={() => onRegenerateAudio(selectedVoiceId)}
            >
              {audioGenerationBusy
                ? "Generating voice…"
                : selectedNarratorVariant
                  ? `Regenerate ${selectedNarratorName}`
                  : "Add voice version"}
            </button>
          </div>
          {canEdit && (
            <button
              type="button"
              className="organic-btn organic-btn-dark"
              disabled={busy !== null}
              aria-busy={linkedInBusy}
              onClick={() => void generateLinkedInPost()}
            >
              {linkedInBusy ? "Generating LinkedIn Post…" : "Generate LinkedIn Post"}
            </button>
          )}
          {canApprove ? (
            <button
              type="button"
              className="organic-btn organic-btn-lime"
              disabled={busy !== null}
              onClick={approve}
            >
              {hasGenerationWarning
                ? "Publish with Warning"
                : "Approve and Publish"}
            </button>
          ) : episode.status === "needs_approval" && !canPublish ? (
            <span className="organic-review-state">
              Owner approval required
            </span>
          ) : (
            <span className="organic-review-state">
              {titleCase(episode.status)}
            </span>
          )}
        </div>
        <div className="organic-citation-pills">
          {episode.citations.slice(0, 4).map((c) => (
            <span key={c.url}>{c.label || c.title}</span>
          ))}
          {episode.citations.length > 4 && (
            <span className="more">+{episode.citations.length - 4} More</span>
          )}
        </div>
      </div>

      {linkedInPost !== null && (
        <section
          className="organic-linkedin-post"
          aria-labelledby="linkedin-post-title"
        >
          <div className="organic-linkedin-post-head">
            <div>
              <p className="organic-kicker lime">SOCIAL DRAFT</p>
              <h2 id="linkedin-post-title">Your LinkedIn post</h2>
              <p>
                Refine the generated copy, then paste it into LinkedIn when it
                is ready.
              </p>
            </div>
            <span className="organic-linkedin-mark" aria-hidden="true">
              in
            </span>
          </div>
          <label className="organic-linkedin-editor" htmlFor="linkedin-post-copy">
            <span>Edit post</span>
            <textarea
              id="linkedin-post-copy"
              value={storedLinkedInParts.content}
              readOnly={!canEdit || busy !== null}
              aria-busy={linkedInBusy || linkedInSaving}
              onChange={(event) => {
                updateLinkedInPost(
                  replaceLinkedInPostContent(
                    linkedInPost,
                    event.target.value,
                  ),
                );
                setCopyStatus("idle");
              }}
              rows={10}
            />
          </label>
          {linkedInParts.sourceFooter && (
            <div className="organic-linkedin-source" aria-label="Source footer">
              <span>Included when copied</span>
              <p>{linkedInParts.sourceFooter}</p>
            </div>
          )}
          <div className="organic-linkedin-post-footer">
            <span className="organic-linkedin-count">
              {linkedInCharacterCount.toLocaleString()} /{" "}
              {LINKEDIN_POST_MAX_CHARACTERS.toLocaleString()} characters
              {linkedInHasSource ? " (source excluded)" : ""}
            </span>
            <span
              className={`organic-linkedin-copy-status ${
                copyStatus === "failed" ||
                !linkedInHasSource ||
                linkedInHasExtraSource ||
                linkedInTooLong
                  ? "is-error"
                  : ""
              }`}
              role="status"
              aria-live="polite"
            >
              {copyStatus === "copied"
                ? "Copied to clipboard"
                : copyStatus === "failed"
                  ? "Select the text and copy manually"
                  : linkedInHasExtraSource
                    ? "Source links are added automatically"
                    : !linkedInHasSource
                      ? "A valid episode source is required"
                      : linkedInTooLong
                        ? "Shorten the post copy before saving"
                        : ""}
            </span>
            <div className="organic-linkedin-post-actions">
              {canEdit && (
                <>
                  <button
                    type="button"
                    className="organic-btn organic-btn-outline compact"
                    disabled={busy !== null}
                    aria-busy={linkedInBusy}
                    onClick={() => void generateLinkedInPost()}
                  >
                    {linkedInBusy ? "Regenerating…" : "Regenerate"}
                  </button>
                  <button
                    type="button"
                    className="organic-btn organic-btn-outline compact"
                    disabled={
                      busy !== null ||
                      !linkedInDirty ||
                      !linkedInHasContent ||
                      !linkedInHasSource ||
                      linkedInHasExtraSource ||
                      linkedInTooLong
                    }
                    aria-busy={linkedInSaving}
                    onClick={() => void saveLinkedInPost()}
                  >
                    {linkedInSaving ? "Saving…" : "Save changes"}
                  </button>
                </>
              )}
              <button
                type="button"
                className="organic-btn organic-btn-lime compact"
                disabled={
                  !linkedInHasContent ||
                  !linkedInHasSource ||
                  linkedInHasExtraSource ||
                  linkedInTooLong
                }
                onClick={() => void copyLinkedInPost()}
              >
                {copyStatus === "copied" ? "Copied" : "Copy post"}
              </button>
            </div>
          </div>
        </section>
      )}

      <div className="organic-review-grid">
        <article className="organic-panel transcript">
          <div className="organic-panel-head">
            <h3>Transcript</h3>
            {canEditDraft && (
              <button
                type="button"
                className="organic-btn organic-btn-outline compact"
                disabled={busy !== null}
                aria-controls="review-transcript-content"
                aria-expanded={editing}
                onClick={toggleEditing}
              >
                {editing ? "Cancel editing" : "Edit transcript"}
              </button>
            )}
          </div>
          {editing ? (
            <div
              id="review-transcript-content"
              className="organic-transcript-body"
            >
              <textarea className="organic-input" value={scriptDraft} onChange={(event) => setScriptDraft(event.target.value)} rows={18} />
              <button
                type="button"
                className="organic-btn organic-btn-dark"
                disabled={
                  busy !== null || !titleDraft.trim() || !scriptDraft.trim()
                }
                onClick={() => void saveDraft()}
              >
                {busy === `edit:${episode.id}` ? "Saving…" : "Save Draft"}
              </button>
            </div>
          ) : (
            <div
              id="review-transcript-content"
              className="organic-transcript-body"
            >
              {paragraphs.map((paragraph, index) => (
                <section
                  id={`review-section-${index}`}
                  className={`organic-transcript-section ${
                    paragraph.chapterIndex === activeChapterIndex ? "is-active" : ""
                  }`}
                  key={`${paragraph.scriptStart}-${paragraph.text.slice(0, 24)}`}
                >
                  {paragraph.startsChapter && chapters[paragraph.chapterIndex] && (
                    <h4>{chapters[paragraph.chapterIndex].title}</h4>
                  )}
                  <p>{paragraph.text}</p>
                </section>
              ))}
              {!paragraphs.length && (
                <p>No transcript was stored for this run.</p>
              )}
            </div>
          )}
        </article>

        <aside className="organic-panel evidence">
          <h3>Evidence &amp; Sources</h3>
          {evidence.map((claim) => (
            <article key={claim.id} className="organic-evidence-card">
              <p className="organic-kicker lime">DIRECT ATTRIBUTION</p>
              <h4>{claim.claim}</h4>
              <blockquote>{claim.support}</blockquote>
              <footer>
                <span>{claim.location}</span>
                <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
                  View PDF Source
                </a>
              </footer>
            </article>
          ))}
          {evidence.length === 0 && (
            <div className="organic-evidence-card dashed">
              <p>No itemized evidence cards were stored for this run.</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="organic-player-bar">
        <div className="organic-player-main">
          <div className="organic-player-meta">
            <span className="organic-episode-thumb">KZ</span>
            <span>
              <strong>{episode.title.slice(0, 42)}</strong>
              <small>
                {audioReady
                  ? chapters[activeChapterIndex]?.title ?? "Now reviewing"
                  : audioPreparing
                    ? "Generating or loading audio"
                    : audioStatus === "error"
                      ? "Audio unavailable"
                      : "Generate audio to enable playback"}
              </small>
            </span>
          </div>
          <div className="organic-player-controls">
            {audioVariants.length > 0 && activeAudioVariant && (
              <div className="organic-player-version-controls">
                {audioVariants.length > 1 ? (
                  <label
                    className="organic-player-variant-picker"
                    htmlFor="review-playback-voice"
                  >
                    <span>Listen as</span>
                    <select
                      id="review-playback-voice"
                      aria-label="Listen as voice"
                      value={activeAudioVariant.id}
                      onChange={(event) =>
                        onAudioVariantChange(event.target.value)
                      }
                    >
                      {audioVariants.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.voiceName}
                          {variant.id === defaultAudioVariant?.id ||
                          variant.isDefault
                            ? " (default)"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="organic-player-voice-summary">
                    <span>Voice</span>
                    <strong>{activeAudioVariant.voiceName}</strong>
                  </div>
                )}
                {canPublish ? (
                  selectedVariantIsDefault ? (
                    <span className="organic-player-default-state">
                      Publish default
                    </span>
                  ) : episode.status === "published" ? (
                    <span className="organic-player-default-state">
                      Default locked after publishing
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="organic-player-default-action"
                      disabled={busy !== null}
                      onClick={() =>
                        onSetDefaultAudioVariant(activeAudioVariant.id)
                      }
                    >
                      Set as publish default
                    </button>
                  )
                ) : (
                  <span className="organic-player-default-state">
                    {defaultAudioVariant
                      ? `Default: ${defaultAudioVariant.voiceName}`
                      : "Default not selected"}
                  </span>
                )}
              </div>
            )}
            <div className="organic-player-transport">
              {audioReady ? (
                <>
                  <button
                    type="button"
                    aria-label="Back 10 seconds"
                    onClick={() => onSeek(-10)}
                  >
                    -10
                  </button>
                  <button
                    type="button"
                    className="organic-play"
                    onClick={onPreview}
                    aria-label={playingId === episode.id ? "Pause" : "Play"}
                  >
                    {playingId === episode.id ? "II" : "▶"}
                  </button>
                  <button
                    type="button"
                    aria-label="Forward 10 seconds"
                    onClick={() => onSeek(10)}
                  >
                    +10
                  </button>
                  <select
                    className="organic-playback-rate"
                    aria-label="Playback speed"
                    value={playbackRate}
                    onChange={(event) =>
                      onPlaybackRateChange(Number(event.target.value))
                    }
                  >
                    {PLAYBACK_RATE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <button
                  type="button"
                  className="organic-btn organic-btn-lime"
                  disabled={busy !== null || audioPreparing}
                  onClick={() => onRegenerateAudio(selectedVoiceId)}
                >
                  {audioGenerationBusy
                    ? "Generating voice…"
                    : reviewAudioButtonLabel({
                        hasAudio,
                        status: audioStatus,
                      })}
                </button>
              )}
            </div>
          </div>
          <button type="button" className="organic-btn organic-btn-light" onClick={onExport}>
            Final Export
          </button>
        </div>
        <div className="organic-player-timeline">
          <span>{audioReady ? formatDuration(playbackSeconds) : "--:--"}</span>
          <div className="organic-player-track">
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={audioReady ? Math.min(playbackSeconds, duration) : 0}
              disabled={!audioReady}
              aria-label="Podcast position"
              onChange={(event) => revealChapter(Number(event.target.value))}
            />
            <div className="organic-chapter-markers" aria-hidden="true">
              {chapters.slice(1).map((chapter) => (
                <i
                  key={`${chapter.title}-${chapter.startSeconds}`}
                  style={{
                    left: `${Math.min(100, (chapter.startSeconds / duration) * 100)}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <span>{audioReady ? formatDuration(duration) : "--:--"}</span>
        </div>
        <nav className="organic-player-chapters" aria-label="Podcast sections">
          {chapters.map((chapter, index) => (
            <button
              type="button"
              key={`${chapter.title}-${chapter.startSeconds}`}
              className={index === activeChapterIndex ? "is-active" : ""}
              onClick={() => revealChapter(chapter.startSeconds)}
            >
              <span>{index + 1}</span>
              {chapter.title}
            </button>
          ))}
        </nav>
      </footer>
    </div>
  );
}
