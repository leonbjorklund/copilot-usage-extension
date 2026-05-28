import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeRawUsage } from '../src/core/normalizer';
import { fileContainsText, parseUsageFile } from '../src/core/parser';

describe('parseUsageFile and normalizeRawUsage', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('skips JSON usage fixture without AI Credit marker in billed mode', async () => {
    const filePath = join(__dirname, 'fixtures', 'sample-usage.json');
    const result = await parseUsageFile(filePath, { mode: 'billed-usage' });
    const records = result.items.flatMap((item) => normalizeRawUsage(item));

    expect(result.items).toHaveLength(0);
    expect(records).toEqual([]);
  });

  it('finds AI Credit markers across streamed file chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, `prefix ${'"copilot'.padStart(4096, 'x')}UsageNanoAiu" suffix`);

    await expect(fileContainsText(filePath, '"copilotUsageNanoAiu"')).resolves.toBe(true);
  });

  it('skips a JSON root array without AI Credit marker in billed mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.json');
    await writeFile(
      filePath,
      JSON.stringify([
        { id: 'array-first', total_tokens: 1 },
        { id: 'array-second', total_tokens: 2 },
      ]),
    );

    const result = await parseUsageFile(filePath, { mode: 'billed-usage' });
    const records = result.items.flatMap((item) => normalizeRawUsage(item));

    expect(result.items).toHaveLength(0);
    expect(records).toEqual([]);
  });

  it('skips a JSON records container without AI Credit marker in billed mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-parser-'));
    roots.push(root);
    const filePath = join(root, 'usage.json');
    await writeFile(
      filePath,
      JSON.stringify({
        records: [
          { id: 'records-first', total_tokens: 1 },
          { id: 'records-second', total_tokens: 2 },
        ],
      }),
    );

    const result = await parseUsageFile(filePath, { mode: 'billed-usage' });
    const records = result.items.flatMap((item) => normalizeRawUsage(item));

    expect(result.items).toHaveLength(0);
    expect(records).toEqual([]);
  });

  it('skips a JSONL usage fixture without AI Credit marker in billed mode', async () => {
    const filePath = join(__dirname, 'fixtures', 'sample-usage.jsonl');
    const result = await parseUsageFile(filePath, { mode: 'billed-usage' });
    const records = result.items.flatMap((item) => normalizeRawUsage(item));

    expect(result.items).toHaveLength(0);
    expect(records).toEqual([]);
  });

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

  it('ignores nested camel-case total token counts without AI Credits', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'usage.json',
        value: {
          id: 'nested-total',
          usage: { totalTokens: 3000 },
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('ignores cached total token counts without AI Credits', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'usage.json',
        value: {
          id: 'cached-total',
          total_tokens: 3000,
          cached_tokens: 1200,
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('ignores split token counts without AI Credits', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'usage.json',
        value: {
          id: 'cached-split',
          model: 'gpt-5.4',
          input_tokens: 3000,
          cached_tokens: 1200,
          output_tokens: 500,
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('ignores cache write token counts without AI Credits', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'usage.json',
        value: {
          id: 'cache-write',
          model: 'claude-sonnet-4.6',
          usage: {
            input_tokens: 5000,
            cache_write_input_tokens: 2000,
            output_tokens: 1000,
          },
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('skips invalid numeric token counts', () => {
    const records = [
      normalizeRawUsage({ filePath: 'usage.json', value: { id: 'negative', input_tokens: -1 } }),
      normalizeRawUsage({ filePath: 'usage.json', value: { id: 'fractional', total_tokens: 1.5 } }),
      normalizeRawUsage({ filePath: 'usage.json', value: { id: 'infinite', output_tokens: Infinity } }),
      normalizeRawUsage({ filePath: 'usage.json', value: { id: 'nan', total_tokens: NaN } }),
    ].flat();

    expect(records).toEqual([]);
  });

  it('skips text-only records without token counts', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'usage.json',
        value: {
          id: 'multi-message',
          messages: [
            { role: 'user', content: '12' },
            { role: 'user', content: '34' },
            { role: 'assistant', content: 'ab' },
            { role: 'assistant', content: 'cd' },
          ],
        },
      },
    );

    expect(records).toEqual([]);
  });
});
