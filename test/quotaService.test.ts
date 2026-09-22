import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// Lets a test append to the log exactly when the service checks its size.
const fsHooks = vi.hoisted(() => ({
  beforeStat: undefined as ((path: string) => Promise<void>) | undefined,
  onOpen: undefined as ((path: string, file: FileHandle) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      await fsHooks.beforeStat?.(String(args[0]));
      return actual.stat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      fsHooks.onOpen?.(String(args[0]), file);
      return file;
    },
  };
});
vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: Array<() => void> = [];
    event = (listener: () => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire() { this.listeners.forEach(listener => listener()); }
    dispose() { this.listeners = []; }
  },
}));
const { quotaFromLog, CopilotQuotaService } = await import('../src/core/quotaService');
const { QuotaHistory } = await import('../src/core/quotaHistory');
type QuotaObservation = import('../src/core/quotaHistory').QuotaObservation;
const now = new Date(2026, 8, 12, 12, 0, 0).getTime();
const time = '2026-09-12 12:00:00.000';
const auth = (account = 'alice') => `${time} [info] Logged in as ${account}\n${time} [info] Got Copilot token for ${account}\n`;
const data = { quota: 1500, unlimited: false, hasQuota: true, percentRemaining: 63.4,
  additionalUsageUsed: 0, resetDate: '2026-10-01T00:00:00.000Z' };
const tokenEvent = `${time} [debug] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.\n`;
const identityChange = `${time} [debug] Auth state changed (identity change), minting a new CopilotToken...\n`;
const quotaLine = (method = 'processQuotaHeaders', value: unknown = data) => `${time} [trace] [ChatQuota] ${method}: ${JSON.stringify(value)}\n`;
const reply = `${time} [info] ccreq:example | success | model | 100ms | [panel/editAgent]\n`;

describe('quota log account boundary', () => {
  it('accepts token-derived startup quota without any chat', () => {
    expect(quotaFromLog(auth() + quotaLine('processUserInfoQuotaSnapshot'), now)).toMatchObject({ account: 'alice', quota: { percentRemaining: 63.4 } });
  });
  it('reads Windows CRLF output logs', () => {
    expect(quotaFromLog((auth() + quotaLine()).replaceAll('\n', '\r\n'), now)?.account).toBe('alice');
  });
  it('waits at startup then accepts the first ordinary response snapshot', () => {
    expect(quotaFromLog(auth(), now)).toBeUndefined();
    expect(quotaFromLog(auth() + quotaLine(), now)?.quota.entitlement).toBe(1500);
  });
  it('requires account and successful token in this log', () => {
    expect(quotaFromLog(quotaLine(), now)).toBeUndefined();
    expect(quotaFromLog(`${time} [info] Logged in as alice\n` + quotaLine(), now)).toBeUndefined();
  });
  it('keeps the last reported quota regardless of age or reset date', () => {
    expect(quotaFromLog(auth() + quotaLine(), now + 30 * 24 * 60 * 60_000)).toMatchObject({ account: 'alice', quota: { percentRemaining: 63.4 } });
    expect(quotaFromLog(auth() + quotaLine('processQuotaHeaders', { ...data, resetDate: '2026-09-01' }), now)).toMatchObject({ account: 'alice', quota: { percentRemaining: 63.4 } });
  });
  it('rejects future log entries', () => {
    expect(quotaFromLog(auth() + quotaLine(), now - 1)).toBeUndefined();
  });
  it('invalidates on switching accounts and rejects previous in-flight response data', () => {
    const switched = auth() + quotaLine() + auth('bob');
    expect(quotaFromLog(switched, now)).toBeUndefined();
    expect(quotaFromLog(switched + quotaLine(), now)).toBeUndefined();
    expect(quotaFromLog(switched + quotaLine('processUserInfoQuotaSnapshot'), now)).toBeUndefined();
    expect(quotaFromLog(switched + tokenEvent + quotaLine('processUserInfoQuotaSnapshot'), now)?.account).toBe('bob');
  });
  it.each(['Minted a new CopilotToken.', 'Finished handling auth change event.',
    'AuthenticationService: firing onDidAuthenticationChange from handleAuthChangeEvent identity change. Has token: true'])(
    'rejects delayed user-info quota after token handling ends with %s', marker => {
      const switched = auth() + quotaLine() + auth('bob') + tokenEvent;
      expect(quotaFromLog(switched + `${time} [debug] ${marker}\n`
        + quotaLine('processUserInfoQuotaSnapshot')
        + `${time} [trace] [ChatQuota] refreshQuota: fetched up-to-date quota data\n`, now)).toBeUndefined();
    });
  it('accepts synchronous token quota with another token listener log between the event and snapshot', () => {
    const switched = auth() + auth('bob') + tokenEvent;
    expect(quotaFromLog(switched + `${time} [info] copilot token sku: copilot_individual\n`
      + quotaLine('processUserInfoQuotaSnapshot')
      + `${time} [debug] Minted a new CopilotToken.\n`, now)?.account).toBe('bob');
  });
  it.each(['GitHub login failed', 'AuthenticationService: firing onDidAuthenticationChange Has token: false',
    'onDidCopilotTokenChange from getCopilotToken token lost', 'Auth state changed (identity change), minting token'])('clears on %s', marker => {
    expect(quotaFromLog(auth() + quotaLine() + `${time} [info] ${marker}\n`, now)).toBeUndefined();
  });
  it('accepts normal responses after same-account reauthentication', () => {
    const reauth = auth() + `${time} [debug] Auth state changed (identity change), minting token\n` + auth();
    expect(quotaFromLog(reauth + quotaLine(), now)?.account).toBe('alice');
  });
  it('retains the accepted log timestamp when reread and updates it only for another quota record', () => {
    const text = auth() + quotaLine();
    expect(quotaFromLog(text, now + 60_000)?.observedAt).toBe(now);
    expect(quotaFromLog(text + reply.replace(time, '2026-09-12 12:00:30.000'), now + 60_000)?.observedAt).toBe(now);
    const updated = text + quotaLine().replace(time, '2026-09-12 12:01:00.000');
    expect(quotaFromLog(updated, now + 60_000)?.observedAt).toBe(now + 60_000);
    expect(quotaFromLog(updated + auth('bob'), now + 60_000)).toBeUndefined();
  });
  it('hides startup quota until the same account supplies another successful token', () => {
    const startup = auth() + tokenEvent + quotaLine('processUserInfoQuotaSnapshot') + identityChange;
    expect(quotaFromLog(startup, now)).toBeUndefined();
    const login = startup + `${time} [info] Logged in as alice\n`;
    expect(quotaFromLog(login + quotaLine(), now)).toBeUndefined();
    expect(quotaFromLog(login + `${time} [info] Got Copilot token for alice\n`, now))
      .toMatchObject({ account: 'alice', quota: { percentRemaining: 63.4 } });
  });
  it('discards retained quota when another account appears, including a switch back', () => {
    const switched = auth() + quotaLine() + identityChange + auth('bob');
    expect(quotaFromLog(switched, now)).toBeUndefined();
    expect(quotaFromLog(switched + identityChange + auth(), now)).toBeUndefined();
    expect(quotaFromLog(switched + quotaLine(), now)).toBeUndefined();
    expect(quotaFromLog(switched + tokenEvent + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }), now))
      .toMatchObject({ account: 'bob', quota: { percentRemaining: 80 } });
  });
  it.each(['GitHub login failed', 'AuthenticationService: firing onDidAuthenticationChange Has token: false',
    'onDidCopilotTokenChange from getCopilotToken token lost', 'onDidCopilotTokenChange resetCopilotToken',
    'Logged in as devDeviceId'])(
    'does not restore retained quota after %s', marker => {
      const interrupted = auth() + quotaLine() + identityChange + `${time} [info] ${marker}\n`;
      expect(quotaFromLog(interrupted + auth(), now)).toBeUndefined();
    });
  it('rejects changed snapshot format instead of retaining an earlier value', () => {
    expect(quotaFromLog(auth() + quotaLine() + quotaLine('processQuotaHeaders', {}), now)).toBeUndefined();
  });
  it('applies account lines stamped later than the clock', () => {
    // After the clock steps back, an earlier-written switch has a later timestamp.
    const switched = auth() + quotaLine() + auth('bob').replaceAll(time, '2026-09-12 12:00:05.000')
      + quotaLine('processQuotaHeaders', { ...data, percentRemaining: 50 }).replace(time, '2026-09-12 12:00:01.000');
    const observations: QuotaObservation[] = [];
    expect(quotaFromLog(switched, now + 2_000, new Set(), observations)).toBeUndefined();
    expect(observations.map((entry) => entry.percentRemaining)).toEqual([63.4]);
  });
});

it('retains quota while idle, reads updates, clears after an account switch, and names no account after truncation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const root = await mkdtemp(join(tmpdir(), 'quota-log-test-'));
  const folder = join(root, 'GitHub.copilot-chat');
  const path = join(folder, 'GitHub Copilot Chat.log');
  await mkdir(folder);
  const service = new CopilotQuotaService(join(root, 'extension'));
  try {
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
    await writeFile(path, auth() + quotaLine().trimEnd());
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
    await appendFile(path, '\n');
    await service.refreshNow();
    expect(service.getState().kind).toBe('quota');
    expect(service.getState()).toMatchObject({ observedAt: now });
    vi.setSystemTime(now + 30 * 24 * 60 * 60_000);
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ kind: 'quota', account: 'alice', quota: { percentRemaining: 63.4 } });
    expect(service.getState()).toMatchObject({ observedAt: now });
    await appendFile(path, reply);
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ observedAt: now });
    expect(service.getState()).toMatchObject({ kind: 'quota', account: 'alice', quota: { percentRemaining: 63.4 } });
    await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ kind: 'quota', account: 'alice', quota: { percentRemaining: 60 } });
    await appendFile(path, identityChange);
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
    await appendFile(path, auth());
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ kind: 'quota', account: 'alice', quota: { percentRemaining: 60 } });
    await appendFile(path, auth('bob'));
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
    await appendFile(path, tokenEvent + quotaLine('processUserInfoQuotaSnapshot', { ...data, quota: 60000 }));
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ kind: 'quota', account: 'bob', quota: { entitlement: 60000 } });
    // A lost account must not freeze the displayed percentage at its last named value.
    await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 70 }));
    await service.refreshNow();
    expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
      quota: expect.objectContaining({ entitlement: 1500, percentRemaining: 70 }) });
    await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 65 }));
    await service.refreshNow();
    expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
      quota: expect.objectContaining({ percentRemaining: 65 }) });
  } finally {
    service.dispose();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('shows anonymous quota after lost rotation and rejects late responses after recovery, switch previously observed: %s', async (switchBeforeRotation) => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const root = await mkdtemp(join(tmpdir(), 'quota-log-test-'));
  const folder = join(root, 'GitHub.copilot-chat');
  const path = join(folder, 'GitHub Copilot Chat.log');
  const bobQuota = { ...data, quota: 60000, percentRemaining: 80 };
  const bobToken = auth('bob') + tokenEvent + quotaLine('processUserInfoQuotaSnapshot', bobQuota)
    + `${time} [debug] Minted a new CopilotToken.\n`;
  const service = new CopilotQuotaService(join(root, 'extension'));
  try {
    await mkdir(folder);
    await writeFile(path, auth() + quotaLine());
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ account: 'alice' });
    if (switchBeforeRotation) {
      // Remember the switch even when Bob has not supplied a quota yet.
      await appendFile(path, auth('bob'));
      await service.refreshNow();
      expect(service.getState().kind).toBe('waiting');
    }
    await rename(path, `${path}.1`);
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
    await writeFile(path, quotaLine());
    await service.refreshNow();
    // The renamed file is not a VS Code backup, so either account's response is anonymous.
    expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
      quota: expect.objectContaining({ entitlement: 1500 }) });
    await appendFile(path, bobToken);
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ account: 'bob', quota: { entitlement: 60000, percentRemaining: 80 } });
    // Alice's delayed HTTP, WebSocket, and asynchronous user-info responses lack identity.
    for (const method of ['processQuotaHeaders', 'processQuotaSnapshots', 'processUserInfoQuotaSnapshot']) {
      await appendFile(path, quotaLine(method));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob', quota: { entitlement: 60000, percentRemaining: 80 } });
    }
  } finally {
    service.dispose();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

describe('quota observations for the daily history', () => {
  const stamp = (seconds: number, line: string) => `2026-09-12 12:00:${String(seconds).padStart(2, '0')}.000 ${line}\n`;
  const observe = (text: string) => {
    const observations: QuotaObservation[] = [];
    quotaFromLog(text, now + 60_000, new Set(), observations);
    return observations.map((entry) => `${entry.account}:${entry.percentRemaining}@${entry.at - now}`);
  };
  it('collects every accepted percentage with its account, including ones a later line retracts', () => {
    const text = auth() + quotaLine() + stamp(10, '[trace] [ChatQuota] processQuotaHeaders: ' + JSON.stringify({ ...data, percentRemaining: 60 }))
      + stamp(20, '[info] Logged in as bob') + stamp(20, '[info] Got Copilot token for bob') + stamp(21, '[info] ccreq:x | success | model | 1ms | [panel]')
      + stamp(25, '[trace] [ChatQuota] processQuotaHeaders: ' + JSON.stringify({ ...data, percentRemaining: 50 }))
      + stamp(30, '[debug] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.')
      + stamp(30, '[trace] [ChatQuota] processUserInfoQuotaSnapshot: ' + JSON.stringify({ ...data, percentRemaining: 80 }));
    expect(observe(text)).toEqual(['alice:63.4@0', 'alice:60@10000', 'bob:80@30000']);
    expect(quotaFromLog(text, now + 60_000)).toMatchObject({ account: 'bob', quota: { percentRemaining: 80 } });
  });
  it('skips unlimited, empty, unauthenticated, and future percentages', () => {
    expect(observe(auth() + quotaLine('processQuotaHeaders', { ...data, quota: -1, unlimited: true })
      + quotaLine('processQuotaHeaders', { ...data, quota: 0 }) + quotaLine())).toEqual(['alice:63.4@0']);
    expect(observe(quotaLine() + `${time} [info] Logged in as alice\n` + quotaLine())).toEqual([]);
    expect(observe(auth() + quotaLine().replace(time, '2026-09-12 12:02:00.000'))).toEqual([]);
    expect(observe(auth() + quotaLine('processQuotaHeaders', { ...data, resetDate: undefined }))).toEqual(['alice:63.4@0']);
    const observations: QuotaObservation[] = [];
    quotaFromLog(auth() + quotaLine(), now, new Set(), observations);
    expect(observations).toEqual([{ account: 'alice', at: now, percentRemaining: 63.4, resetDate: '2026-10-01T00:00:00.000Z' }]);
  });
  it('journals observations before announcing a changed state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-log-test-'));
    const folder = join(root, 'GitHub.copilot-chat');
    await mkdir(folder);
    const recorded: string[] = [];
    let announced = 0;
    const service = new CopilotQuotaService(join(root, 'extension'), {
      record: async (observations) => {
        expect(announced).toBe(recorded.length);
        recorded.push(observations.map((entry) => `${entry.account}:${entry.percentRemaining}`).join(','));
      },
    });
    service.onDidChange(() => announced++);
    try {
      await writeFile(join(folder, 'GitHub Copilot Chat.log'), auth() + quotaLine());
      await service.refreshNow();
      expect(recorded).toEqual(['alice:63.4']);
      expect(announced).toBe(1);
      await appendFile(join(folder, 'GitHub Copilot Chat.log'), quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
      await service.refreshNow();
      expect(recorded).toEqual(['alice:63.4', 'alice:60']);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('announces growing overage at 0% without writing overage to history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-log-test-'));
    const folder = join(root, 'GitHub.copilot-chat');
    await mkdir(folder);
    const recorded: QuotaObservation[] = [];
    let announced = 0;
    const service = new CopilotQuotaService(join(root, 'extension'), {
      record: async (observations) => { recorded.push(...observations); },
    });
    service.onDidChange(() => announced++);
    const over = (additionalUsageUsed: number) => quotaLine('processQuotaHeaders', { ...data, percentRemaining: 0, additionalUsageUsed });
    try {
      await writeFile(join(folder, 'GitHub Copilot Chat.log'), auth() + over(300));
      await service.refreshNow();
      await appendFile(join(folder, 'GitHub Copilot Chat.log'), over(400));
      await service.refreshNow();
      expect(announced).toBe(2);
      expect(service.getState()).toMatchObject({ kind: 'quota', quota: { percentRemaining: 0, overage: 400 } });
      expect(recorded).toEqual([
        { account: 'alice', at: now, percentRemaining: 0, resetDate: '2026-10-01T00:00:00.000Z' },
        { account: 'alice', at: now, percentRemaining: 0, resetDate: '2026-10-01T00:00:00.000Z' },
      ]);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('log replacement and continuity', () => {
  async function fixture(run: (service: InstanceType<typeof CopilotQuotaService>, path: string, journal: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'quota-rotation-test-'));
    const folder = join(root, 'GitHub.copilot-chat');
    await mkdir(folder);
    const path = join(folder, 'GitHub Copilot Chat.log');
    const journal = join(root, 'quota-history.jsonl');
    const service = new CopilotQuotaService(join(root, 'extension'), new QuotaHistory(journal));
    try {
      await writeFile(path, auth() + quotaLine());
      await service.refreshNow();
      expect(service.getState().kind).toBe('quota');
      await run(service, path, journal);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
  const backup = (path: string, index = 1) => path.replace(/\.log$/, `.${index}.log`);

  it.each([1, 3])('does not bridge an erased switch through %i surviving backups', async (rotations) => {
    await fixture(async (service, path, journal) => {
      const before = await readFile(journal, 'utf8');
      // The reader pauses while ordinary rotations create a complete-looking backup chain.
      for (let turn = 0; turn < rotations; turn++) {
        for (let index = turn; index >= 1; index--) await rename(backup(path, index), backup(path, index + 1));
        await rename(path, backup(path));
        await writeFile(path, reply);
      }
      await appendFile(path, identityChange + auth('bob') + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }));
      const inode = (await stat(path)).ino;
      // If a backup rename fails, spdlog truncates current but retains the older backups.
      await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 78 }));
      expect((await stat(path)).ino).toBe(inode);
      await service.refreshNow();
      expect.soft(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 78 }) });
      expect.soft(await readFile(journal, 'utf8')).toBe(before);

      await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 77 }));
      await service.refreshNow();
      expect.soft(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 77 }) });
      expect.soft(await readFile(journal, 'utf8')).toBe(before);

      await appendFile(path, auth('bob') + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 75 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob', quota: { percentRemaining: 75 } });
      const persisted = (await readFile(journal, 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as QuotaObservation)
        .map(entry => `${entry.account}:${entry.percentRemaining}`);
      expect(persisted).toEqual(['alice:63.4', 'bob:75']);
    });
  });

  it('keeps quota anonymous through ordinary and repeated rotations without changing history', async () => {
    await fixture(async (service, path, journal) => {
      const before = await readFile(journal, 'utf8');
      await rename(path, backup(path));
      await service.refreshNow(); // Rotation briefly leaves no current file.
      expect(service.getState().kind).toBe('waiting');
      await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 60 }) });
      await rename(backup(path), backup(path, 2));
      await rename(path, backup(path));
      await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 55 }));
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 55 }) });
      expect(await readFile(journal, 'utf8')).toBe(before);
    });
  });

  it('does not restore an account from token evidence split across a rotation', async () => {
    await fixture(async (service, path, journal) => {
      const before = await readFile(journal, 'utf8');
      await appendFile(path, auth('bob'));
      await rename(path, backup(path));
      await writeFile(path, quotaLine());
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 63.4 }) });
      await appendFile(path, tokenEvent + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }));
      await service.refreshNow();
      expect(service.getState().kind).toBe('waiting');
      expect(await readFile(journal, 'utf8')).toBe(before);
      await appendFile(path, auth('bob') + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 75 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob', quota: { percentRemaining: 75 } });
      expect(await readFile(journal, 'utf8')).not.toContain('"percentRemaining":80');
    });
  });

  it.each([false, true])('preserves only observed sign-out evidence across replacement, observed: %s', async (observed) => {
    await fixture(async (service, path, journal) => {
      const before = await readFile(journal, 'utf8');
      await appendFile(path, `${time} [debug] onDidCopilotTokenChange from getCopilotToken token lost\n`);
      if (observed) await service.refreshNow();
      await rename(path, backup(path, 2));
      await writeFile(backup(path), reply);
      await writeFile(path, quotaLine());
      await service.refreshNow();
      if (observed) expect(service.getState().kind).toBe('waiting');
      else expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 63.4 }) });
      expect(await readFile(journal, 'utf8')).toBe(before);
    });
  });

  it('names no account across a missing intermediate backup', async () => {
    await fixture(async (service, path) => {
      await rename(path, backup(path, 2));
      await writeFile(path, quotaLine());
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 63.4 }) });
    });
  });

  it('keeps quota anonymous as earlier logs age out of all six backups', async () => {
    await fixture(async (service, path) => {
      for (let turn = 0; turn < 9; turn++) {
        await rm(backup(path, 6), { force: true });
        for (let index = Math.min(turn, 5); index >= 1; index--) await rename(backup(path, index), backup(path, index + 1));
        await rename(path, backup(path));
        await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 - turn }));
        await service.refreshNow();
        expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
          quota: expect.objectContaining({ percentRemaining: 60 - turn }) });
      }
    });
  });

  it('shows current quota without an owner or new history across a torn archived line', async () => {
    await fixture(async (service, path, journal) => {
      const before = await readFile(journal, 'utf8');
      await appendFile(path, `${time} [info] Logged in as bo`);
      await rename(path, backup(path));
      await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 40 }));
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 40 }) });
      expect(await readFile(journal, 'utf8')).toBe(before);
    });
  });

  it('names no account for a truncated file that grew past the consumed offset', async () => {
    await fixture(async (service, path) => {
      await writeFile(path, reply.repeat(20) + quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 60 }) });
      await appendFile(path, auth('bob') + tokenEvent + quotaLine('processUserInfoQuotaSnapshot'));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob' });
    });
  });

  it('does not borrow startup identity from an older backup', async () => {
    await fixture(async (_service, path) => {
      await rename(path, backup(path));
      await writeFile(path, quotaLine());
      const restarted = new CopilotQuotaService(join(path, '..', '..', 'extension'));
      try {
        await restarted.refreshNow();
        expect(restarted.getState().kind).toBe('waiting');
      } finally { restarted.dispose(); }
    });
  });

  it('keeps the last quota anonymously while the rotated log is empty and follows later updates', async () => {
    await fixture(async (service, path) => {
      await rename(path, backup(path));
      await writeFile(path, '');
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 63.4 }) });
      await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
      await service.refreshNow();
      expect(service.getState()).toEqual({ kind: 'quota', observedAt: now,
        quota: expect.objectContaining({ percentRemaining: 60 }) });
    });
  });

  it.each([['empty', ''], ['partial', `${time} [debug] Resolving chat model`]])(
    'does not assign an erased switch to the old account after an initially %s rotated log', async (_name, pending) => {
      await fixture(async (service, path, journal) => {
        const persisted = async () => (await readFile(journal, 'utf8')).split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as QuotaObservation)
          .map(entry => `${entry.account}:${entry.percentRemaining}`);
        await rename(path, backup(path));
        await writeFile(path, pending);
        await service.refreshNow();
        // Bob switches and starts work, then the logger loses those lines before the next poll.
        await appendFile(path, '\n' + identityChange + auth('bob') + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }));
        const inode = (await stat(path)).ino;
        await writeFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 40 }));
        expect((await stat(path)).ino).toBe(inode);
        await service.refreshNow();
        expect.soft(service.getState()).toEqual({ kind: 'quota', observedAt: now,
          quota: expect.objectContaining({ percentRemaining: 40 }) });
        expect(await persisted()).toEqual(['alice:63.4']);
        // A later successful token restores Bob's name and permits only his verified snapshot.
        await appendFile(path, auth('bob') + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 35 }));
        await service.refreshNow();
        expect(service.getState()).toMatchObject({ account: 'bob', quota: { percentRemaining: 35 } });
        expect(await persisted()).toEqual(['alice:63.4', 'bob:35']);
      });
    });

  it('keeps quota while Copilot appends during every read', async () => {
    await fixture(async (service, path) => {
      await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 60 }));
      fsHooks.beforeStat = async (file) => { if (file === path) await appendFile(path, reply); };
      try {
        await service.refreshNow();
        expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 60 } });
      } finally { fsHooks.beforeStat = undefined; }
    });
  });

  it.each([['equal', ''], ['larger', reply]])(
    'never combines old account evidence with a rewritten quota when the final log is %s in size', async (_name, tail) => {
      await fixture(async (service, path, journal) => {
        const before = await readFile(journal, 'utf8');
        const prefixBytes = Buffer.byteLength(auth() + quotaLine());
        await appendFile(path, quotaLine('processQuotaHeaders', { ...data, percentRemaining: 55 }));
        const originalInfo = await stat(path);
        let rewritten = false;
        fsHooks.onOpen = (openedPath, file) => {
          if (openedPath !== path || rewritten) return;
          const read = file.read.bind(file);
          file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (rewritten) return read(buffer, offset, length, position);
            const result = await read(buffer, offset, Math.min(length, prefixBytes), position);
            rewritten = true;
            // The next read sees another generation, although inode and length still match.
            await writeFile(path, '.'.repeat(prefixBytes - 1) + '\n'
              + quotaLine('processQuotaHeaders', { ...data, percentRemaining: 40 }) + tail);
            const changed = new Date(originalInfo.mtimeMs + 1_000);
            await utimes(path, changed, changed);
            return result;
          }) as typeof file.read;
        };
        try {
          await service.refreshNow();
        } finally { fsHooks.onOpen = undefined; }
        expect(rewritten).toBe(true);
        expect((await stat(path)).ino).toBe(originalInfo.ino);
        expect.soft(service.getState()).toEqual({ kind: 'quota', observedAt: now,
          quota: expect.objectContaining({ percentRemaining: 40 }) });
        expect(await readFile(journal, 'utf8')).toBe(before);
      });
    });
});

describe('account lines lost to truncation in place', () => {
  // VS Code's logger empties the log in place when a child process blocks its rename.
  async function truncated(run: (fixture: { service: InstanceType<typeof CopilotQuotaService>; path: string;
    recorded: string[]; truncate: (text: string) => Promise<void> }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'quota-truncation-test-'));
    const folder = join(root, 'GitHub.copilot-chat');
    await mkdir(folder);
    const path = join(folder, 'GitHub Copilot Chat.log');
    const recorded: string[] = [];
    const service = new CopilotQuotaService(join(root, 'extension'), {
      record: async (observations) => { recorded.push(...observations.map((entry) => `${entry.account}:${entry.percentRemaining}`)); },
    });
    try {
      await writeFile(path, auth() + quotaLine());
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice' });
      const inode = (await stat(path)).ino;
      const truncate = async (text: string) => {
        await writeFile(path, text);
        expect((await stat(path)).ino).toBe(inode);
      };
      await run({ service, path, recorded, truncate });
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
  const headers = (percentRemaining: number) => quotaLine('processQuotaHeaders', { ...data, percentRemaining });
  const unnamed = (percentRemaining: number) => ({ kind: 'quota', observedAt: now,
    quota: expect.objectContaining({ percentRemaining }) });

  it('shows newer quota without an account or history until a token names the account', async () => {
    await truncated(async ({ service, path, recorded, truncate }) => {
      await truncate(reply + headers(60));
      await service.refreshNow();
      expect(service.getState()).toEqual(unnamed(60));
      await appendFile(path, headers(55));
      await service.refreshNow();
      expect(service.getState()).toEqual(unnamed(55));
      await truncate(headers(50));
      await service.refreshNow();
      expect(service.getState()).toEqual(unnamed(50));
      expect(recorded).toEqual(['alice:63.4']);
      // A token refresh names the account again. Untagged responses may still belong to an erased switch.
      await appendFile(path, auth() + `${time} [debug] Handling CopilotToken refresh.\n` + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 50 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 50 } });
      await appendFile(path, headers(49));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 50 } });
      expect(recorded).toEqual(['alice:63.4', 'alice:50']);
      await appendFile(path, auth() + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 48 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 48 } });
      expect(recorded).toEqual(['alice:63.4', 'alice:50', 'alice:48']);
    });
  });

  it('updates anonymous percentages after an observed switch without recording them', async () => {
    await truncated(async ({ service, path, recorded, truncate }) => {
      await appendFile(path, identityChange + auth('bob') + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob', quota: { percentRemaining: 80 } });
      await truncate(headers(70));
      await service.refreshNow();
      expect(service.getState()).toEqual(unnamed(70));
      await appendFile(path, headers(65));
      await service.refreshNow();
      expect(service.getState()).toEqual(unnamed(65));
      expect(recorded).toEqual(['alice:63.4', 'bob:80']);
    });
  });

  it.each(['processQuotaHeaders', 'processQuotaSnapshots', 'processUserInfoQuotaSnapshot'])(
    'rejects a delayed Bob %s after truncation erases both switch markers', async method => {
      await truncated(async ({ service, path, recorded, truncate }) => {
        // Neither Bob's switch nor the later switch-back marker is read before truncation.
        await appendFile(path, identityChange + auth('bob') + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }) + identityChange);
        await truncate(auth() + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 55 })
          + `${time} [debug] Minted a new CopilotToken.\n`);
        await service.refreshNow();
        expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 55 } });
        await appendFile(path, quotaLine(method, { ...data, percentRemaining: 39 }));
        await service.refreshNow();
        expect.soft(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 55 } });
        expect(recorded).toEqual(['alice:63.4', 'alice:55']);
      });
    });

  it('trusts only token snapshots after an identity change that follows lost lines', async () => {
    await truncated(async ({ service, path, recorded, truncate }) => {
      // The lost lines may have switched to bob. Switching back does not end bob's in-flight responses.
      await truncate(identityChange + auth() + tokenEvent + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 62 })
        + quotaLine('processQuotaSnapshots', { ...data, quota: 300, percentRemaining: 79 }));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice', quota: { entitlement: 1500, percentRemaining: 62 } });
      await appendFile(path, headers(61));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 62 } });
      expect(recorded).toEqual(['alice:63.4', 'alice:62']);
    });
  });

  it.each([['identity change', identityChange], ['sign-out', `${time} [info] GitHub login failed\n`]])(
    'rejects erased-account responses when truncation follows a read %s', async (_name, reset) => {
      await truncated(async ({ service, path, recorded, truncate }) => {
        await appendFile(path, reset);
        await service.refreshNow();
        expect(service.getState().kind).toBe('waiting');
        // The parser has no current account when the unread switch and log content disappear.
        await appendFile(path, auth('bob') + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }) + identityChange);
        await truncate(auth() + tokenEvent
          + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 55 }));
        await service.refreshNow();
        expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 55 } });
        await appendFile(path, headers(39));
        await service.refreshNow();
        expect(service.getState()).toMatchObject({ account: 'alice', quota: { percentRemaining: 55 } });
        expect(recorded).toEqual(['alice:63.4', 'alice:55']);
      });
    });

  it.each(['Auth state changed (identity change), minting a new CopilotToken...',
    'AuthenticationService: firing onDidAuthenticationChange from handleAuthChangeEvent identity change. Has token: true',
    'AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.', 'Minted a new CopilotToken.',
    'Getting CopilotToken (force: true)...', 'Got CopilotToken (force: true).',
    'Handling CopilotToken refresh.', 'GitHub login failed', 'Logged in as bob', 'Logged in as alice'])(
    'hides quota with lost account lines after "%s" without a named token', async (marker) => {
      await truncated(async ({ service, path, recorded, truncate }) => {
        await truncate(headers(60));
        await service.refreshNow();
        expect(service.getState().kind).toBe('quota');
        await appendFile(path, `${time} [debug] ${marker}\n` + headers(55));
        await service.refreshNow();
        expect(service.getState().kind).toBe('waiting');
        expect(recorded).toEqual(['alice:63.4']);
      });
    });

  it('follows a switch seen after truncation and rejects the old account\'s late response', async () => {
    await truncated(async ({ service, path, recorded, truncate }) => {
      await truncate(headers(60));
      await service.refreshNow();
      await appendFile(path, identityChange + auth('bob') + tokenEvent
        + quotaLine('processUserInfoQuotaSnapshot', { ...data, percentRemaining: 80 }) + headers(59));
      await service.refreshNow();
      expect(service.getState()).toMatchObject({ account: 'bob', quota: { percentRemaining: 80 } });
      expect(recorded).toEqual(['alice:63.4', 'bob:80']);
    });
  });

  it('keeps quota hidden when a sign-out was read before the truncation', async () => {
    await truncated(async ({ service, path, truncate }) => {
      await appendFile(path, `${time} [info] GitHub login failed\n`);
      await service.refreshNow();
      expect(service.getState().kind).toBe('waiting');
      await truncate(headers(60));
      await service.refreshNow();
      expect(service.getState().kind).toBe('waiting');
    });
  });
});
