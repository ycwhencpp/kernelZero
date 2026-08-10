"use client";

import { useMemo, useState } from "react";
import { sourceSelectionCoverage } from "../../lib/domain";
import { episodeLengthProfile } from "../../lib/podcast-length";
import type { DashboardState, EpisodeLength } from "../../lib/types";

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
  onStart: (itemIds: string[], episodeLength: EpisodeLength) => void;
  onAddSource: () => void;
  busy: string | null;
  sourceLimit: number | null;
}) {
  const sources = state.sources;
  const sourceIdsWithContent = useMemo(
    () =>
      new Set(
        state.items.flatMap((item) => item.sourceId ? [item.sourceId] : []),
      ),
    [state.items],
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(() =>
    sources
      .filter((source) => sourceIdsWithContent.has(source.id))
      .slice(0, 2)
      .map((source) => source.id),
  );
  const [depth, setDepth] = useState<EpisodeLength>(state.settings.episodeLength);
  const [generationTime, setGenerationTime] = useState("08:00");
  const [weekdays, setWeekdays] = useState([true, true, true, true, true, false, false]);
  const [distribution, setDistribution] = useState({ spotify: true, apple: false });
  const sourceSelection = useMemo(
    () => sourceSelectionCoverage(state.items, selectedSourceIds),
    [state.items, selectedSourceIds],
  );
  const selectedItems = sourceSelection.selectedItems;
  const readySourceIds = useMemo(
    () => sources
      .filter((source) => sourceIdsWithContent.has(source.id))
      .map((source) => source.id),
    [sourceIdsWithContent, sources],
  );
  const bulkSelectionIds = sourceLimit === null
    ? sources.map((source) => source.id)
    : readySourceIds.slice(0, sourceLimit);
  const allBulkSourcesSelected =
    bulkSelectionIds.length > 0 &&
    bulkSelectionIds.every((sourceId) => selectedSourceIds.includes(sourceId));
  const readySourceLimitReached =
    sourceLimit !== null && sourceSelection.readySourceCount >= sourceLimit;

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
          Connect trusted sources, set narrative depth, and schedule automated distribution for your
          next AI-produced episode.
        </p>
      </div>

      <div className="organic-create-grid">
        <article className="organic-panel">
          <div className="organic-panel-head">
            <h3>Source Selection</h3>
            <button
              type="button"
              className="organic-text-link lime"
              aria-pressed={allBulkSourcesSelected}
              disabled={bulkSelectionIds.length === 0}
              onClick={() =>
                setSelectedSourceIds(
                  allBulkSourcesSelected ? [] : bulkSelectionIds,
                )
              }
            >
              {allBulkSourcesSelected
                ? "Clear all"
                : sourceLimit !== null && readySourceIds.length > sourceLimit
                  ? `Select first ${sourceLimit}`
                  : "Select all"}
            </button>
          </div>
          <div className="organic-source-pick-grid">
            {sources.map((source) => {
              const selected = selectedSourceIds.includes(source.id);
              const hasContent = sourceIdsWithContent.has(source.id);
              const disabledByLimit =
                !selected && hasContent && readySourceLimitReached;
              return (
              <button
                key={source.id}
                type="button"
                className={`organic-source-pick ${selected ? "is-selected" : ""}`}
                aria-pressed={selected}
                disabled={disabledByLimit}
                onClick={() =>
                  setSelectedSourceIds((current) =>
                    current.includes(source.id)
                      ? current.filter((id) => id !== source.id)
                      : [...current, source.id],
                  )
                }
              >
                {selected && <span className="check">✓</span>}
                <strong>{source.name}</strong>
                <small>
                  {source.type.toUpperCase()} · {hasContent ? "READY" : "NO CONTENT"}
                </small>
              </button>
            ); })}
            <button type="button" className="organic-source-pick dashed" onClick={onAddSource}>
              Connect New Source
            </button>
          </div>
          {sourceLimit !== null && readySourceIds.length > sourceLimit && (
            <p className="organic-panel-copy" role="status">
              Local Ollama generation accepts up to {sourceLimit} ready sources.
              {readySourceLimitReached && " Deselect one to choose a different source."}
            </p>
          )}
          {sourceSelection.unavailableSourceCount > 0 && (
            <p className="organic-panel-copy" role="status">
              {sourceSelection.unavailableSourceCount} selected {sourceSelection.unavailableSourceCount === 1 ? "source has" : "sources have"} no imported content yet and will be skipped. Refresh them from Sources.
            </p>
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

        <article className="organic-panel span-2">
          <div className="organic-panel-head">
            <h3>Focus &amp; Interests</h3>
            <span className="organic-pill organic-pill-lime small">3 Active Filters</span>
          </div>
          <div className="organic-tag-list">
            {state.interests.filter((interest) => interest.enabled).map((interest) => (
              <span key={interest.id} className="organic-tag lime">
                {interest.name}
              </span>
            ))}
          </div>
          <input placeholder="Add specific keyword or topic..." className="organic-input" />
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
              <span>Sources Selected</span>
              <strong>{sourceSelection.selectedSourceCount}</strong>
            </li>
            <li>
              <span>Ready Sources</span>
              <strong>{sourceSelection.readySourceCount}</strong>
            </li>
            {sourceSelection.unavailableSourceCount > 0 && (
              <li>
                <span>Awaiting Content</span>
                <strong>{sourceSelection.unavailableSourceCount}</strong>
              </li>
            )}
            <li>
              <span>Selection Rule</span>
              <strong>Top item per source</strong>
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
            onClick={() => onStart(selectedItems.map((item) => item.id), depth)}
          >
            {busy
              ? "Starting…"
              : selectedItems.length
                ? `START PIPELINE (${selectedItems.length} ready sources)`
                : "START PIPELINE"}
          </button>
          <button type="button" className="organic-btn organic-btn-outline block" onClick={() => onStart(selectedItems.slice(0, 1).map((item) => item.id), depth)} disabled={busy !== null || selectedItems.length === 0}>
            Generate Preview
          </button>
        </article>
      </div>
    </div>
  );
}
