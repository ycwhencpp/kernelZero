"use client";

import { type FormEvent, useMemo, useState } from "react";
import {
  briefingTopicId,
  buildBriefingTopicCards,
} from "../../lib/domain";
import { episodeLengthProfile } from "../../lib/podcast-length";
import { MAX_BRIEFING_SOURCES } from "../../lib/podcast-source-selection";
import type { DashboardState, EpisodeLength } from "../../lib/types";

const DEFAULT_BRIEFING_TOPICS = [
  "Backend",
  "AI",
  "LLM",
  "Infrastructure",
  "GPT",
  "Claude",
] as const;

export function OrganicCreateView({
  state,
  onBack,
  onStart,
  onAddSource,
  busy,
  sourceLimit,
}: {
  state: DashboardState;
  onBack: () => void;
  onStart: (
    itemIds: string[],
    episodeLength: EpisodeLength,
    focusTopic: string,
  ) => void;
  onAddSource: () => void;
  busy: string | null;
  sourceLimit: number | null;
}) {
  const sources = state.sources;
  const requestedSourceLimit = sourceLimit ?? MAX_BRIEFING_SOURCES;
  const briefingSourceLimit = Number.isFinite(requestedSourceLimit)
    ? Math.max(
        1,
        Math.min(MAX_BRIEFING_SOURCES, Math.floor(requestedSourceLimit)),
      )
    : MAX_BRIEFING_SOURCES;
  const [depth, setDepth] = useState<EpisodeLength>(state.settings.episodeLength);
  const [generationTime, setGenerationTime] = useState("08:00");
  const [weekdays, setWeekdays] = useState([true, true, true, true, true, false, false]);
  const [distribution, setDistribution] = useState({ spotify: true, apple: false });
  const [customTopics, setCustomTopics] = useState<string[]>([]);
  const [topicDraft, setTopicDraft] = useState("");
  const [topicMessage, setTopicMessage] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const enabledSourceIds = useMemo(
    () => sources.filter((source) => source.enabled).map((source) => source.id),
    [sources],
  );
  const preferredTopics = useMemo(
    () => [
      ...customTopics,
      ...DEFAULT_BRIEFING_TOPICS,
      ...state.interests
        .filter((interest) => interest.enabled)
        .flatMap((interest) => [interest.name, ...interest.keywords]),
    ],
    [customTopics, state.interests],
  );
  const topicCards = useMemo(
    () => buildBriefingTopicCards(state.items, preferredTopics, {
      sourceIds: enabledSourceIds,
      limit: briefingSourceLimit,
      requireFullCard: true,
    }),
    [briefingSourceLimit, enabledSourceIds, preferredTopics, state.items],
  );
  const defaultTopicCard = topicCards[0] ?? null;
  const selectedTopicCard =
    topicCards.find((card) => card.id === selectedTopicId) ?? defaultTopicCard;
  const selectedItems = selectedTopicCard?.items ?? [];
  const selectedSourceCount = new Set(
    selectedItems.flatMap((item) => item.sourceId ? [item.sourceId] : []),
  ).size;

  const addTopicCards = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedTopics = [...new Map(
      topicDraft
        .split(",")
        .map((topic) => topic.trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .map((topic) => [briefingTopicId(topic), topic]),
    ).values()];
    if (requestedTopics.length === 0) {
      setTopicMessage("Enter a topic such as Backend, AI, LLM, GPT, or Claude.");
      return;
    }

    const matchedTopics: string[] = [];
    const unmatchedTopics: string[] = [];
    for (const topic of requestedTopics) {
      const existing = topicCards.find((card) => card.id === briefingTopicId(topic));
      const card = existing ?? buildBriefingTopicCards(state.items, [topic], {
        sourceIds: enabledSourceIds,
        limit: briefingSourceLimit,
        includeInferredTopics: false,
        requireFullCard: true,
      })[0];
      if (!card) {
        unmatchedTopics.push(topic);
        continue;
      }
      matchedTopics.push(topic);
      setSelectedTopicId(card.id);
    }

    if (matchedTopics.length > 0) {
      setCustomTopics((current) => {
        const existingIds = new Set(current.map(briefingTopicId));
        return [
          ...matchedTopics.filter((topic) => !existingIds.has(briefingTopicId(topic))),
          ...current,
        ];
      });
      setTopicDraft("");
    }
    setTopicMessage(
      unmatchedTopics.length > 0
        ? `Fewer than ${briefingSourceLimit} connected sources have ready matching blogs for ${unmatchedTopics.map((topic) => `“${topic}”`).join(", ")}. Add or refresh sources to create those cards.`
        : `${matchedTopics.length === 1 ? "Topic card added" : `${matchedTopics.length} topic cards added`}.`,
    );
  };

  return (
    <div className="organic-create">
      <header className="organic-create-top">
        <button type="button" className="organic-text-link" onClick={onBack}>
          ← Back to Dashboard
        </button>
        <div className="organic-create-step">
          <span>Step 2 of 4</span>
          <strong>Configuring Pipeline</strong>
          <img src="/figma/avatar.jpg" alt="" />
        </div>
      </header>

      <div className="organic-create-intro">
        <span className="organic-pill organic-pill-lime">CONFIGURATION MODE</span>
        <h1>Create New Briefing</h1>
        <p>
          Choose a topic and we’ll combine the strongest matching blogs from five trusted
          sources into one briefing.
        </p>
      </div>

      <div className="organic-create-grid">
        <article className="organic-panel span-2 organic-topic-panel">
          <div className="organic-panel-head">
            <div>
              <h3>Choose a Podcast Topic</h3>
              <p>
                Each card combines the best matching blog from five different sources.
              </p>
            </div>
            <button type="button" className="organic-text-link lime" onClick={onAddSource}>
              Connect sources
            </button>
          </div>

          <form className="organic-topic-add" onSubmit={addTopicCards}>
            <label htmlFor="briefing-topics">Add topic cards</label>
            <div>
              <input
                id="briefing-topics"
                value={topicDraft}
                onChange={(event) => {
                  setTopicDraft(event.target.value);
                  setTopicMessage(null);
                }}
                placeholder="Backend, AI, LLM, Infrastructure, GPT, Claude…"
              />
              <button type="submit" className="organic-btn organic-btn-dark">
                Add topic
              </button>
            </div>
            <small>Separate multiple topics with commas.</small>
          </form>
          {topicMessage && (
            <p className="organic-topic-message" role="status">{topicMessage}</p>
          )}

          {topicCards.length > 0 ? (
            <div className="organic-topic-card-grid" role="radiogroup" aria-label="Podcast topics">
              {topicCards.map((card) => {
                const selected = card.id === selectedTopicCard?.id;
                return (
                  <label
                    key={card.id}
                    className={`organic-topic-card ${selected ? "is-selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="briefing-topic"
                      value={card.id}
                      checked={selected}
                      aria-label={`${card.topic}, ${briefingSourceLimit} sources`}
                      onChange={() => setSelectedTopicId(card.id)}
                    />
                    <span className="organic-topic-card-head">
                      <span>
                        <small>Podcast on</small>
                        <strong>{card.topic}</strong>
                      </span>
                      <span className="organic-topic-card-count">
                        {card.items.length} / {briefingSourceLimit} sources
                      </span>
                    </span>
                    <span className="organic-topic-blog-list">
                      {card.items.map((item, index) => {
                        const source = item.sourceId ? sourceById.get(item.sourceId) : undefined;
                        return (
                          <span key={item.id} className="organic-topic-blog-row">
                            <span className="organic-topic-blog-index" aria-hidden="true">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="organic-topic-blog-copy">
                              <strong>{item.title}</strong>
                              <small>{source?.name ?? item.sourceName}</small>
                            </span>
                          </span>
                        );
                      })}
                    </span>
                    <span className="organic-topic-card-foot">
                      <span>
                        {card.availableBlogCount > card.items.length
                          ? `${card.availableBlogCount} matching blogs across ${card.availableSourceCount} sources`
                          : "Best matching blog from each source"}
                      </span>
                      <strong>{selected ? "Selected ✓" : "Select"}</strong>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="organic-topic-empty">
              <strong>No topic cards are ready yet.</strong>
              <p>
                Each topic needs ready matching blogs from {briefingSourceLimit} different
                connected sources. Connect or refresh sources to complete a card.
              </p>
              <button type="button" className="organic-btn organic-btn-dark" onClick={onAddSource}>
                Connect a source
              </button>
            </div>
          )}
        </article>

        <article className="organic-panel dark">
          <h3>Episode Settings</h3>
          <p className="organic-field-label">Narrative Depth</p>
          <div className="organic-depth-list">
            <button type="button" className={depth === "brief" ? "is-active" : ""} onClick={() => setDepth("brief")}>Brief · 3 min</button>
            <button type="button" className={depth === "standard" ? "is-active" : ""} onClick={() => setDepth("standard")}>
              Standard · 9 min
            </button>
            <button type="button" className={depth === "deep" ? "is-active" : ""} onClick={() => setDepth("deep")}>Deep · 15 min</button>
          </div>
            <label className="organic-field light">
              <span>AI Voice Talent</span>
              <select defaultValue="local">
                <option value="local">Local system voice</option>
            </select>
          </label>
        </article>

        <article className="organic-panel">
          <h3>Schedule &amp; Distribution</h3>
          <label className="organic-field">
            <span>Generation Time</span>
            <input type="time" value={generationTime} onChange={(event) => setGenerationTime(event.target.value)} />
            </label>
          <div className="organic-day-picker">
            {["M", "T", "W", "T", "F", "S", "S"].map((day, i) => (
              <button type="button" key={`${day}-${i}`} className={weekdays[i] ? "on" : ""} onClick={() => setWeekdays((current) => current.map((enabled, index) => index === i ? !enabled : enabled))}>
                {day}
              </button>
            ))}
          </div>
          <div className="organic-toggle-row">
            <span>Spotify for Podcasters</span>
            <button type="button" className={`organic-toggle ${distribution.spotify ? "is-on" : ""}`} aria-pressed={distribution.spotify} onClick={() => setDistribution((current) => ({ ...current, spotify: !current.spotify }))} />
          </div>
          <div className="organic-toggle-row">
            <span>Apple Podcasts</span>
            <button type="button" className={`organic-toggle ${distribution.apple ? "is-on" : ""}`} aria-pressed={distribution.apple} onClick={() => setDistribution((current) => ({ ...current, apple: !current.apple }))} />
          </div>
        </article>

        <article className="organic-summary-card">
          <h3>Briefing Summary</h3>
          <ul>
            <li>
              <span>Topic</span>
              <strong>{selectedTopicCard?.topic ?? "None selected"}</strong>
            </li>
            <li>
              <span>Blogs Selected</span>
              <strong>{selectedItems.length}</strong>
            </li>
            <li>
              <span>Connected Sources</span>
              <strong>{selectedSourceCount}</strong>
            </li>
            <li>
              <span>Selection Rule</span>
              <strong>Best blog per source</strong>
            </li>
            <li>
              <span>Estimated Length</span>
              <strong>{episodeLengthProfile(depth).minutes} Minutes</strong>
            </li>
            <li>
              <span>AI Voice</span>
              <strong>{state.voiceProfile?.name ?? "Local system voice"}</strong>
            </li>
          </ul>
          <button
            type="button"
            className="organic-btn organic-btn-dark block"
            disabled={busy !== null || selectedItems.length === 0}
            onClick={() => {
              if (!selectedTopicCard) return;
              onStart(
                selectedItems.map((item) => item.id),
                depth,
                selectedTopicCard.topic,
              );
            }}
          >
            {busy
              ? "Starting…"
              : selectedItems.length
                ? `START PIPELINE (${selectedItems.length} blogs)`
                : "START PIPELINE"}
          </button>
          <button
            type="button"
            className="organic-btn organic-btn-outline block"
            onClick={() => {
              if (!selectedTopicCard) return;
              onStart(
                selectedItems.map((item) => item.id),
                "brief",
                selectedTopicCard.topic,
              );
            }}
            disabled={busy !== null || selectedItems.length === 0}
          >
            Generate Preview
          </button>
        </article>
      </div>
    </div>
  );
}
