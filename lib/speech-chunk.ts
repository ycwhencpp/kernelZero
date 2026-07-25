export function chunkForSpeech(value: string, maxCharacters = 3_600): string[] {
  const paragraphs = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + paragraph).length <= maxCharacters) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxCharacters) {
      current = paragraph;
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [paragraph];
    current = "";
    for (const sentence of sentences) {
      if ((current + sentence).length > maxCharacters && current) {
        chunks.push(current.trim());
        current = "";
      }
      current += sentence;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}
