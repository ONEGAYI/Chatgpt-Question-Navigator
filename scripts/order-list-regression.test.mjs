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

const { mergeOrderedIds } = await importTypeScriptModule('../src/content/orderList.ts');

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
