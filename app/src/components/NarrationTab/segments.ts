/** Prefer sentence and clause boundaries; only split oversized clauses as a fallback. */
export function splitNarration(text: string, limit = 80): string[] {
  const result: string[] = [];
  for (const sentence of text.match(/[^。！？\n]+[。！？]?/gu) || []) {
    let pending = '';
    for (const clause of sentence.match(/[^，；：,;:]+[，；：,;:]?/gu) || []) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      if (Array.from(pending + trimmed).length > limit && pending) {
        result.push(pending);
        pending = '';
      }
      const chars = Array.from(trimmed);
      while (chars.length > limit) result.push(chars.splice(0, limit).join(''));
      pending += chars.join('');
    }
    if (pending) result.push(pending);
  }
  return result;
}
