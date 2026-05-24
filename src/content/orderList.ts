export type ScanDirection = 'up' | 'down' | 'unknown';
export type ScanSegmentKind = 'local-contiguous' | 'detached-top' | 'detached-bottom';

export interface OrderedIdSegment {
  ids: string[];
  direction: ScanDirection;
  kind: ScanSegmentKind;
}

export interface SegmentScrollAnchor {
  segmentRatio: number | null;
  existingRatios: number[];
}

export function mergeOrderedIds(existingOrderedIds: string[], scanIds: string[]): string[] {
  return mergeOrderedSegments(existingOrderedIds, [{
    ids: scanIds,
    direction: 'unknown',
    kind: 'local-contiguous'
  }]);
}

export function mergeOrderedSegments(existingOrderedIds: string[], segments: OrderedIdSegment[]): string[] {
  let result = unique(existingOrderedIds);
  for (const segment of segments) {
    result = mergeOrderedSegment(result, segment);
  }
  return result;
}

export function inferDirectionFromScrollAnchor(anchor: SegmentScrollAnchor): ScanDirection {
  const existingRatios = anchor.existingRatios.filter((ratio) => Number.isFinite(ratio));
  if (anchor.segmentRatio === null || existingRatios.length === 0) return 'unknown';

  const minExisting = Math.min(...existingRatios);
  const maxExisting = Math.max(...existingRatios);
  if (anchor.segmentRatio < minExisting) return 'up';
  if (anchor.segmentRatio > maxExisting) return 'down';
  return 'unknown';
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

function mergeOrderedSegment(existingOrderedIds: string[], segment: OrderedIdSegment): string[] {
  const ids = unique(segment.ids);
  if (ids.length === 0) return existingOrderedIds;
  if (segment.kind === 'local-contiguous') return mergeContiguousSegment(existingOrderedIds, ids, segment.direction);
  return mergeDetachedSegment(existingOrderedIds, ids, segment.direction);
}

function mergeContiguousSegment(existingOrderedIds: string[], segmentIds: string[], direction: ScanDirection): string[] {
  const originalIndexById = new Map(existingOrderedIds.map((id, index) => [id, index]));
  const knownIndexes = segmentIds
    .map((id) => originalIndexById.get(id))
    .filter((index): index is number => index !== undefined);
  const result = existingOrderedIds.filter((id) => !segmentIds.includes(id));

  let insertAt = insertionIndexForDirection(result, direction);
  if (knownIndexes.length > 0) {
    const firstKnownIndex = Math.min(...knownIndexes);
    insertAt = result.filter((id) => (originalIndexById.get(id) ?? Number.POSITIVE_INFINITY) < firstKnownIndex).length;
  }

  result.splice(insertAt, 0, ...segmentIds);
  return result;
}

function mergeDetachedSegment(existingOrderedIds: string[], segmentIds: string[], direction: ScanDirection): string[] {
  const result = unique(existingOrderedIds);
  const known = new Set(result);
  const scan = unique(segmentIds);
  const anchorIndexes = scan
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => known.has(id));

  if (anchorIndexes.length === 0) {
    const insertAt = insertionIndexForDirection(result, direction);
    result.splice(insertAt, 0, ...scan.filter((id) => !known.has(id)));
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

function insertionIndexForDirection(result: string[], direction: ScanDirection): number {
  if (direction === 'up') return 0;
  return result.length;
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
