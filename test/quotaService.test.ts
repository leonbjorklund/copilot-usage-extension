import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: Array<() => void> = [];
    event = (listener: () => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire() { this.listeners.forEach(listener => listener()); }
    dispose() { this.listeners = []; }
  },
}));
const { quotaFromLog, CopilotQuotaService } = await import('../src/core/quotaService');
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
});

it('retains quota while idle, reads updates, and clears after an account switch or log rotation', async () => {
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
    await writeFile(path, quotaLine());
    await service.refreshNow();
    expect(service.getState().kind).toBe('waiting');
  } finally {
    service.dispose();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('rejects old-account responses after rotation, switch observed before rotation: %s', async (switchBeforeRotation) => {
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
    expect(service.getState().kind).toBe('waiting');
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
      expect(recorded).toEqual(['alice:63.4', 'alice:63.4,alice:60']);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
