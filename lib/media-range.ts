export type MediaByteRange = {
  start: number;
  end: number;
  length: number;
};

export function parseMediaByteRange(
  rangeHeader: string,
  totalBytes: number,
): MediaByteRange | null {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(suffixLength, totalBytes);
    return {
      start: totalBytes - length,
      end: totalBytes - 1,
      length,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= totalBytes ||
    requestedEnd < start
  ) {
    return null;
  }

  const end = Math.min(requestedEnd, totalBytes - 1);
  return { start, end, length: end - start + 1 };
}
