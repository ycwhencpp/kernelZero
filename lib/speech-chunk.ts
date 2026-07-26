export function chunkForSpeech(value: string, maxCharacters = 3_600): string[] {
  if (maxCharacters < 1) return [];
  const paragraphs = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  const append = (part: string) => {
    const separator = current ? " " : "";
    if ((current + separator + part).length <= maxCharacters) {
      current += `${separator}${part}`;
      return;
    }
    pushCurrent();
    if (part.length <= maxCharacters) {
      current = part;
      return;
    }

    for (const word of part.split(/\s+/).filter(Boolean)) {
      if (word.length > maxCharacters) {
        pushCurrent();
        for (let offset = 0; offset < word.length; offset += maxCharacters) {
          const slice = word.slice(offset, offset + maxCharacters);
          if (slice.length === maxCharacters) chunks.push(slice);
          else current = slice;
        }
        continue;
      }
      const wordSeparator = current ? " " : "";
      if ((current + wordSeparator + word).length > maxCharacters) pushCurrent();
      current += `${current ? " " : ""}${word}`;
    }
  };

  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [paragraph];
    for (const sentence of sentences) {
      append(sentence.trim());
    }
  }
  pushCurrent();
  return chunks;
}
