import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION = 'github.copilot-chat';
const TRACE = `${EXTENSION}=trace`;
const MAX_BYTES = 128 * 1024;

export interface QuotaLogging {
  /** Saved startup default, not proof of a running channel's level. */
  requested: boolean;
  reason: string;
}

async function quotaLoggingArgvPath(): Promise<string> {
  if (process.env.VSCODE_PORTABLE) return join(process.env.VSCODE_PORTABLE, 'argv.json');
  const product = JSON.parse(await readBounded(join(vscode.env.appRoot, 'product.json')));
  if (typeof product.dataFolderName !== 'string' || !/^\.[\w.-]+$/.test(product.dataFolderName)) {
    throw new Error('Cannot locate this VS Code installation\'s scoped logging configuration.');
  }
  return join(homedir(), product.dataFolderName, 'argv.json');
}

/** Persist the scoped default so new windows and reloads can capture startup quota. */
export async function enableQuotaLogging(): Promise<QuotaLogging> {
  try {
    const argvPath = await quotaLoggingArgvPath();
    logLevels(await readArgv(argvPath)); // Refuse entries VS Code would silently discard.
    await vscode.commands.executeCommand('workbench.action.setDefaultLogLevel', 1, EXTENSION);
    const saved = logLevels(await readArgv(argvPath));
    if (saved.find((entry) => /^github\.copilot-chat[:=]/i.test(entry)) !== TRACE) {
      throw new Error('VS Code did not save the scoped Trace default.');
    }
    return { requested: true,
      reason: 'Copilot Trace is saved for future starts. Fully quit and reopen VS Code if quota stays unavailable. Existing channel overrides are preserved.' };
  } catch (error) {
    return { requested: false, reason: `Copilot Trace could not be saved: ${String(error)}` };
  }
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('Logging configuration exceeds its read limit.');
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}

async function readArgv(path: string): Promise<string> {
  try { return await readBounded(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
    throw error;
  }
}

/** Read only the top-level JSONC setting; VS Code owns all configuration writes. */
function logLevels(text: string): string[] {
  const tokens = [...text.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)]
    .map((token) => token[0]).filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  let depth = 0;
  let entries: string[] | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (depth === 1 && token.startsWith('"') && tokens[index + 1] === ':' && JSON.parse(token) === 'log-level') {
      if (entries) throw new Error('Duplicate log-level configuration.');
      let last = index + 2;
      if (tokens[last] === '[') while (last < tokens.length && tokens[last] !== ']') last++;
      const value: unknown = JSON.parse(tokens.slice(index + 2, last + 1).join('').replace(/,\]$/, ']'));
      if (typeof value !== 'string' && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
        throw new Error('Unsupported log-level configuration.');
      }
      entries = typeof value === 'string' ? [value] : value as string[];
      for (const entry of entries) {
        const level = /^([^.]+\..+)[:=](.+)$/.exec(entry)?.[2] ?? entry;
        if (!/^(trace|debug|info|warn|error|critical|off)$/.test(level)) {
          throw new Error('Existing log-level configuration contains unsupported entries.');
        }
      }
      index = last;
      continue;
    }
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
  }
  return entries ?? [];
}
