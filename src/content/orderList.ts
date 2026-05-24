export function mergeOrderedIds(existingOrderedIds: string[], scanIds: string[]): string[] {
  const result = unique(existingOrderedIds);
  const known = new Set(result);
  const scan = unique(scanIds);
  const anchorIndexes = scan
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => known.has(id));

  if (anchorIndexes.length === 0) {
    for (const id of scan) {
      if (!known.has(id)) {
        result.push(id);
        known.add(id);
      }
    }
    return result;
  }

  let previousAnchor: string | null = null;
  let segmentStart = 0;

  for (const anchor of anchorIndexes) {
    insertSegment(result, known, scan.slice(segmentStart, anchor.index), previousAnchor, anchor.id);
    previousAnchor = anchor.id;
    segmentStart = anchor.index + 1;
  }

  insertSegment(result, known, scan.slice(segmentStart), previousAnchor, null);
  return result;
}

export function orderMessagesByIds<T extends { localMessageId: string }>(messagesById: Map<string, T>, orderedIds: string[]): T[] {
  const result: T[] = [];
  const emitted = new Set<string>();

  for (const id of orderedIds) {
    const message = messagesById.get(id);
    if (!message || emitted.has(id)) continue;
    result.push(message);
    emitted.add(id);
  }

  for (const [id, message] of messagesById) {
    if (emitted.has(id)) continue;
    result.push(message);
    emitted.add(id);
  }

  return result;
}

function insertSegment(
  result: string[],
  known: Set<string>,
  segment: string[],
  previousAnchor: string | null,
  nextAnchor: string | null
): void {
  const newIds = segment.filter((id) => !known.has(id));
  if (newIds.length === 0) return;

  let insertAt = result.length;
  if (previousAnchor) {
    const previousIndex = result.indexOf(previousAnchor);
    if (previousIndex >= 0) insertAt = previousIndex + 1;
  } else if (nextAnchor) {
    const nextIndex = result.indexOf(nextAnchor);
    if (nextIndex >= 0) insertAt = nextIndex;
  }

  result.splice(insertAt, 0, ...newIds);
  for (const id of newIds) known.add(id);
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
