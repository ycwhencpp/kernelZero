export function mediaUrl(key: string): string {
  const segments = key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/api/media/${segments.join("/")}`;
}

export function mediaKeyFromRoute(
  value: string | string[],
): string | null {
  const rawSegments = Array.isArray(value) ? value : [value];
  const decodedSegments: string[] = [];

  try {
    for (const rawSegment of rawSegments) {
      // Next normally decodes route parameters. Decoding once more preserves
      // compatibility with URLs previously stored as one `%2F`-encoded key.
      const decoded = rawSegment.includes("%")
        ? decodeURIComponent(rawSegment)
        : rawSegment;
      decodedSegments.push(...decoded.split("/").filter(Boolean));
    }
  } catch {
    return null;
  }

  return decodedSegments.length ? decodedSegments.join("/") : null;
}
