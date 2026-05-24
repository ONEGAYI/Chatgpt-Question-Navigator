export function normalizeMessageText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function toPreview(input: string, maxLength = 120): string {
  const normalized = normalizeMessageText(input);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function toSearchText(input: string, maxLength = 2000): string {
  return normalizeMessageText(input).slice(0, maxLength);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitByQuery(text: string, query: string): Array<{ text: string; match: boolean }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [{ text, match: false }];

  const regex = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
  return text
    .split(regex)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: part.toLowerCase() === normalizedQuery.toLowerCase()
    }));
}
