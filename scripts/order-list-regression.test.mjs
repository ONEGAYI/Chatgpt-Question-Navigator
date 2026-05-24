import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScriptModule(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true
    }
  });

  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const { inferDirectionFromScrollAnchor, mergeOrderedIds, mergeOrderedSegments } = await importTypeScriptModule('../src/content/orderList.ts');
const { directionFromDelta, directionFromKey } = await importTypeScriptModule('../src/content/scrollDriver.ts');

test('anchor-splice preserves established order when later scans omit early messages', () => {
  const bottom = mergeOrderedIds([], ['M50', 'M52', 'M54']);
  assert.deepEqual(bottom, ['M50', 'M52', 'M54']);

  const withOlderHistory = mergeOrderedIds(bottom, ['M40', 'M42', 'M44', 'M50', 'M52']);
  assert.deepEqual(withOlderHistory, ['M40', 'M42', 'M44', 'M50', 'M52', 'M54']);

  const backToBottom = mergeOrderedIds(withOlderHistory, ['M44', 'M50', 'M52', 'M54']);
  assert.deepEqual(backToBottom, ['M40', 'M42', 'M44', 'M50', 'M52', 'M54']);
});

test('anchor-splice inserts new messages between and after known anchors without moving existing ids', () => {
  const existing = ['M10', 'M20', 'M30', 'M40'];
  const merged = mergeOrderedIds(existing, ['M20', 'M25', 'M30', 'M45']);

  assert.deepEqual(merged, ['M10', 'M20', 'M25', 'M30', 'M45', 'M40']);
  assert.deepEqual(merged.filter((id) => existing.includes(id)), existing);
});

test('upward top segment without local anchors prepends before cached-only messages', () => {
  const merged = mergeOrderedSegments(['M30', 'M50'], [{
    ids: ['M20'],
    direction: 'up',
    kind: 'detached-top'
  }]);

  assert.deepEqual(merged, ['M20', 'M30', 'M50']);
});

test('upward segment with local lower anchor inserts inside an existing gap', () => {
  const merged = mergeOrderedSegments(['M30', 'M50'], [{
    ids: ['M40', 'M50'],
    direction: 'up',
    kind: 'local-contiguous'
  }]);

  assert.deepEqual(merged, ['M30', 'M40', 'M50']);
});

test('trusted contiguous segment can repair previously inverted known ids', () => {
  const merged = mergeOrderedSegments(['M30', 'M20', 'M50'], [{
    ids: ['M20', 'M30'],
    direction: 'up',
    kind: 'local-contiguous'
  }]);

  assert.deepEqual(merged, ['M20', 'M30', 'M50']);
});

test('detached scan segments do not share anchors with each other', () => {
  const merged = mergeOrderedSegments(['M30', 'M50'], [
    { ids: ['M20'], direction: 'up', kind: 'detached-top' },
    { ids: ['M50'], direction: 'up', kind: 'detached-bottom' }
  ]);

  assert.deepEqual(merged, ['M20', 'M30', 'M50']);
});

test('normalization-style append does not let stale message array reorder known ids', () => {
  const storedOrderedIds = ['M20', 'M30', 'M50'];
  const staleMessageIds = ['M30', 'M20', 'M50', 'M60'];
  const normalized = [
    ...storedOrderedIds.filter((id) => staleMessageIds.includes(id)),
    ...staleMessageIds.filter((id) => !storedOrderedIds.includes(id))
  ];

  assert.deepEqual(normalized, ['M20', 'M30', 'M50', 'M60']);
});

test('unknown direction can be inferred from scroll metadata for earlier lazy-loaded history', () => {
  const direction = inferDirectionFromScrollAnchor({
    segmentRatio: 0.2,
    existingRatios: [0.5]
  });
  const merged = mergeOrderedSegments(['M50'], [{
    ids: ['M20'],
    direction,
    kind: 'local-contiguous'
  }]);

  assert.equal(direction, 'up');
  assert.deepEqual(merged, ['M20', 'M50']);
});

test('user scroll input exposes direction before lazy-load mutation scans run', () => {
  assert.equal(directionFromDelta(-1), 'up');
  assert.equal(directionFromDelta(1), 'down');
  assert.equal(directionFromKey('PageUp'), 'up');
  assert.equal(directionFromKey('PageDown'), 'down');
});
