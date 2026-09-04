import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseUsageFile } from '../src/core/parser';

describe('parseUsageFile', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it.each(['json', 'jsonl'])('skips %s files without AI Credit markers before parsing', async (extension) => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, `usage.${extension}`);
    await writeFile(filePath, '{not valid json');

    expect(await parseUsageFile(filePath, { mode: 'billed-usage' })).toEqual({
      items: [], malformedRecords: 0, consumedBytes: 0,
    });
  });

  it('finds AI Credit markers across streamed file chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    const value = { copilotUsageNanoAiu: 1 };
    // Split the marker between the first two 4096-byte reads.
    await writeFile(filePath, ' '.repeat(4090) + JSON.stringify(value) + '\n');

    const result = await parseUsageFile(filePath, { mode: 'billed-usage' });

    expect(result.items).toEqual([{ value, filePath }]);
    expect(result.malformedRecords).toBe(0);
  });

  it.each(['single', 'array', 'records', 'items', 'requests', 'turns', 'chats'])(
    'parses JSON metadata in a %s container without AI Credits', async (container) => {
      const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
      roots.push(root);
      const filePath = join(root, 'usage.json');
      const value = { kind: 1, k: ['customTitle'], v: 'Stored title' };
      const payload = container === 'single' ? value : container === 'array' ? [value] : { [container]: [value] };
      await writeFile(filePath, JSON.stringify(payload));

      const result = await parseUsageFile(filePath, { mode: 'metadata' });

      expect(result.items).toEqual([{ value, filePath }]);
      expect(result.malformedRecords).toBe(0);
    },
  );

  it('parses uppercase JSONL metadata files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.JSONL');
    await writeFile(filePath, '{"kind":1,"k":["customTitle"],"v":"Upper title"}\n');

    const result = await parseUsageFile(filePath, { mode: 'metadata' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].value).toMatchObject({ kind: 1, v: 'Upper title' });
    expect(result.malformedRecords).toBe(0);
  });

  it('skips malformed JSONL metadata lines while keeping valid lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(
      filePath,
      '{"kind":1,"k":["customTitle"],"v":"Before"}\nnot-json\n{"kind":1,"k":["customTitle"],"v":"After"}\n',
    );

    const result = await parseUsageFile(filePath, { mode: 'metadata' });

    expect(result.items.map((item) => item.value)).toEqual([
      { kind: 1, k: ['customTitle'], v: 'Before' },
      { kind: 1, k: ['customTitle'], v: 'After' },
    ]);
    expect(result.malformedRecords).toBe(1);
  });

  it('reports the bytes it read so incremental reads resume in the right place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'main.jsonl');
    // Multi-byte text keeps the byte count apart from the character count.
    const content =
      [
        JSON.stringify({ type: 'llm_request', sid: 's', ts: 1, attrs: { copilotUsageNanoAiu: 1, inputTokens: 1, outputTokens: 1 } }),
        JSON.stringify({ type: 'llm_request', sid: 's', ts: 2, attrs: { debugName: 'Förklara 🚀', copilotUsageNanoAiu: 1, inputTokens: 1, outputTokens: 1 } }),
      ].join('\n') + '\n';
    await writeFile(filePath, content);

    const parsed = await parseUsageFile(filePath, { mode: 'billed-usage' });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.consumedBytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(parsed.consumedBytes).not.toBe(content.length);
  });
});
