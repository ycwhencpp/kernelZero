"use client";

import { useEffect, useRef, useState } from "react";
import {
  applyPlaybackRate,
  normalizePlaybackRate,
  PLAYBACK_RATE_OPTIONS,
  type PlaybackRate,
} from "../../../lib/playback";

export function PlaybackAudio({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1);

  useEffect(() => {
    if (audioRef.current) applyPlaybackRate(audioRef.current, playbackRate);
  }, [playbackRate, src]);

  const changePlaybackRate = (value: number) => {
    const rate = normalizePlaybackRate(value);
    setPlaybackRate(rate);
    if (audioRef.current) applyPlaybackRate(audioRef.current, rate);
  };

  return (
    <div className="platform-audio-player">
      <audio
        ref={audioRef}
        className="platform-audio"
        aria-label={`Audio: ${title}`}
        controls
        preload="none"
        src={src}
        onLoadedMetadata={(event) =>
          applyPlaybackRate(event.currentTarget, playbackRate)
        }
      >
        Your browser does not support audio playback.
      </audio>
      <label className="platform-playback-rate">
        <span>Speed</span>
        <select
          aria-label={`Playback speed for ${title}`}
          value={playbackRate}
          onChange={(event) =>
            changePlaybackRate(Number(event.target.value))
          }
        >
          {PLAYBACK_RATE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
