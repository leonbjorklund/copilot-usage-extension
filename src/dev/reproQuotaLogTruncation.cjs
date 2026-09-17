// Windows-only reproduction of Copilot quota disappearing when VS Code's native
// logger empties the Copilot Chat output log in place. It runs the installed VS
// Code Electron runtime and spdlog.node with VS Code's logger settings, a real
// child process that inherits the log handle, and this extension's quota service.
// Logs, accounts, and percentages are synthetic temporary fixtures.
//
// Run from the repository root:
//   node src/dev/reproQuotaLogTruncation.cjs <Code.exe> <spdlog.node> [scenario] [--rev <git-rev> | --source <quotaService.ts>]
// Scenarios: truncation (default), rename, switch-before-truncation, switch-after-truncation,
// switch-in-gap, switch-in-gap-other-plan, same-account-recovery, backup-rename-failure
// Exit 0: quota followed the log without naming or recording a wrong account. Exit 1: failure reproduced. Exit 2: harness error.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // VS Code: 30 MB split over six rotating files.
const MAX_FILES = 6;
const PATTERN = '%Y-%m-%d %H:%M:%S.%e [%l] %v';
const LOG_NAME = 'GitHub Copilot Chat.log';
const SCENARIOS = ['truncation', 'rename', 'switch-before-truncation', 'switch-after-truncation',
  'switch-in-gap', 'switch-in-gap-other-plan', 'same-account-recovery', 'backup-rename-failure'];

const quotaJson = (entitlement, percentRemaining) => JSON.stringify({ unlimited: false, hasQuota: true, additionalUsageEnabled: true,
  additionalUsageUsed: 0, quota: entitlement, resetDate: '2026-10-01T00:00:00.000Z', percentRemaining });
const localTime = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(11, 23);

async function host(addon, root, scenario) {
  const backupFailure = scenario === 'backup-rename-failure';
  const scheduleTimeout = global.setTimeout;
  if (backupFailure) {
    // Explicit polls keep both native rotations in one unread gap, independent of machine speed.
    global.setTimeout = (callback, milliseconds, ...args) =>
      scheduleTimeout(callback, milliseconds === 2000 ? 2_147_483_647 : milliseconds, ...args);
  }
  const native = require(addon);
  const Module = require('node:module');
  const load = Module._load;
  const vscode = { EventEmitter: class {
    constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
    fire() { this.listeners.forEach((listener) => listener()); }
    dispose() { this.listeners = []; }
  } };
  Module._load = function (request) { return request === 'vscode' ? vscode : load.apply(this, arguments); };
  // Record when the service polls the current log, whether it stats or opens it first.
  const fsp = require('node:fs/promises');
  const polls = [];
  let bobTokenRead = false;
  for (const name of ['open', 'stat']) {
    const original = fsp[name];
    fsp[name] = async function (file, ...rest) {
      const result = await original.call(this, file, ...rest);
      if (path.basename(String(file)) === LOG_NAME) {
        polls.push(Date.now());
        if (name === 'open') {
          const read = result.read.bind(result);
          let tail = '';
          result.read = async function (buffer, offset, length, position) {
            const outcome = await read(buffer, offset, length, position);
            const text = tail + buffer.toString('utf8', offset, offset + outcome.bytesRead);
            bobTokenRead ||= /\] Got Copilot token for bob\b/.test(text);
            tail = text.slice(-64);
            return outcome;
          };
        }
      }
      return result;
    };
  }
  const { CopilotQuotaService } = require(path.join(root, 'quotaService.cjs'));

  const exthost = path.join(root, 'logs', '20260101T000000', 'window1', 'exthost');
  const folder = path.join(exthost, 'GitHub.copilot-chat');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, LOG_NAME);
  // Mirrors VS Code's SpdLogLogger for a rotating extension log output channel.
  native.setFlushOn(0);
  const logger = new native.Logger('rotating_async', 'GitHub Copilot Chat', file, MAX_FILE_BYTES, MAX_FILES);
  logger.setPattern(PATTERN);
  logger.setLevel(0);
  const log = (level, message) => logger[level](message);
  const started = Date.now();
  const recorded = [];
  const logged = [];
  const timeline = [];
  let child;
  let service;
  let monitor;
  let watcher;
  try {
    // Sequences observed in Copilot Chat 0.66.0 logs and code.
    const tokenLines = (account, entitlement, percent, force) => {
      log('info', `Logged in as ${account}`);
      log('info', `Got Copilot token for ${account}`);
      log('info', 'Copilot Chat: 0.66.0, VS Code: 1.138.0');
      log('debug', 'Handling CopilotToken refresh.');
      log('debug', `Got CopilotToken (force: ${force}).`);
      log('debug', 'AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.');
      log('info', 'copilot token sku: monthly_subscriber_quota');
      log('trace', `[ChatQuota] processUserInfoQuotaSnapshot: ${quotaJson(entitlement, percent)}`);
      logged.push({ account, percent });
    };
    const identityChange = () => {
      log('debug', 'Auth state changed (identity change), minting a new CopilotToken...');
      log('debug', 'Getting CopilotToken (force: true)...');
      log('debug', 'Finished handling auth change event.');
    };
    const minted = () => {
      log('debug', 'Minted a new CopilotToken.');
      log('info', 'AuthenticationService: firing onDidAuthenticationChange from handleAuthChangeEvent identity change. Has token: true');
      log('info', 'copilot token sku: monthly_subscriber_quota');
      log('debug', 'Finished handling auth change event.');
    };
    const accountSwitch = (account, entitlement, percent) => {
      log('debug', 'Handling onDidChangeSession.');
      identityChange();
      tokenLines(account, entitlement, percent, true);
      minted();
    };
    let turn = 0;
    const chatTurn = (account, entitlement, percent, chunks = 256) => {
      // One agent request: model resolution, streamed trace output, request summary, quota header.
      turn++;
      log('trace', 'Resolving chat model');
      for (let index = 0; index < chunks; index++) log('trace', `[synthetic] response chunk ${turn}.${index} ${'.'.repeat(1000)}`);
      log('info', `ccreq:${turn.toString(16).padStart(8, '0')} | success | synthetic-model | 1200ms | [panel/editAgent]`);
      log('trace', `[ChatQuota] processQuotaHeaders: ${quotaJson(entitlement, percent)}`);
      logged.push({ account, percent });
    };
    const until = async (predicate, timeout, message) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await delay(25);
      }
    };
    const describe = (state) => state.kind === 'quota' ? `quota ${state.account ?? '(no account)'} ${state.quota.percentRemaining}%`
      : `${state.kind}${state.reason ? ' (hidden with reason)' : ''}`;

    let identity;
    let size = 0;
    let rotation;
    let firstRotation;
    monitor = setInterval(() => {
      let info;
      try { info = fs.statSync(file, { bigint: true }); } catch { return; }
      identity ??= info.ino;
      if (!rotation && info.ino !== identity) rotation = { kind: 'renamed', at: Date.now() };
      else if (!rotation && info.size < BigInt(size)) rotation = { kind: 'truncated in place', at: Date.now() };
      size = Number(info.size);
    }, 10);
    watcher = setInterval(() => {
      if (!service) return;
      const state = describe(service.getState());
      if (timeline.at(-1)?.state !== state) timeline.push({ atMs: Date.now() - started, state });
    }, 50);

    // Startup: Copilot mints a token, then handles the startup identity change.
    log('debug', 'Getting CopilotToken (force: undefined)...');
    tokenLines('alice', 1500, 60, undefined);
    identityChange();
    tokenLines('alice', 1500, 60, true);
    minted();
    await until(() => fs.existsSync(file) && fs.statSync(file).size > 0, 5000, 'Logger did not create the log');
    service = new CopilotQuotaService(path.join(exthost, 'leonbjorklund.copilot-usage-extension'), {
      record: async (observations) => { recorded.push(...observations.map(({ account, percentRemaining, at }) => ({ account, percent: percentRemaining, at }))); },
    });
    void service.refreshNow();
    await until(() => describe(service.getState()) === 'quota alice 60%', 10000, 'Service did not accept startup quota');
    const startupPolls = polls.length;

    if (scenario !== 'rename' && !backupFailure) {
      // Like a language server or other tool the extension host starts after Copilot opens its log.
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume();'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    }

    let alice = 60;
    let bob = 41.25;
    const recovery = scenario === 'same-account-recovery';
    const missedSwitch = scenario.startsWith('switch-in-gap') || recovery || backupFailure;
    const switchBefore = scenario === 'switch-before-truncation';
    const bobPlan = scenario === 'switch-in-gap-other-plan' || recovery ? 300 : 1500;
    const next = (value, step) => Math.round((value - step) * 100) / 100;
    if (switchBefore) {
      accountSwitch('bob', bobPlan, bob);
      await until(() => describe(service.getState()) === `quota bob ${bob}%`, 10000, 'Service did not observe the switch before truncation');
    }
    if (missedSwitch && !backupFailure) {
      // Bring the log near its rotation size, then complete an account switch
      // right after a quota poll and cross the size limit before the next poll.
      while (size < MAX_FILE_BYTES - 400 * 1024 && turn < 80) { chatTurn('alice', 1500, alice = next(alice, 0.4)); await delay(150); }
      await until(() => describe(service.getState()) === `quota alice ${alice}%`, 10000, 'Service did not catch up before the switch');
      const seen = polls.length;
      await until(() => polls.length > seen, 5000, 'Service did not poll');
      await delay(200);
      accountSwitch('bob', bobPlan, bob);
      // A switch back starts before truncation; its named token arrives afterward.
      if (recovery) identityChange();
      while (!rotation && turn < 80) { chatTurn('bob', bobPlan, bob, 64); await delay(5); }
    } else {
      while (!rotation && turn < 80) {
        if (switchBefore) chatTurn('bob', bobPlan, bob = next(bob, 0.4));
        else chatTurn('alice', 1500, alice = next(alice, 0.4));
        await delay(250);
      }
    }
    assert(rotation, 'The log never rotated');
    if (backupFailure) {
      firstRotation = rotation.kind;
      assert.equal(firstRotation, 'renamed', 'The first rotation must succeed before locking its backup');
      const backupFile = path.join(folder, 'GitHub Copilot Chat.1.log');
      const backupBytes = fs.readFileSync(backupFile);
      assert(/Got Copilot token for alice/.test(backupBytes.toString('utf8')), 'The first backup lost Alice\'s checkpoint');
      const lockScript = '$stream = [System.IO.File]::Open($env:QUOTA_REPRO_BACKUP, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine("locked"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }';
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')], {
        env: { ...process.env, QUOTA_REPRO_BACKUP: backupFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let locked = false;
      let lockError;
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('locked')) locked = true; });
      child.once('error', (error) => { lockError = error; });
      child.once('exit', (code) => { if (!locked) lockError = new Error(`Backup lock helper exited with ${code}`); });
      await until(() => locked || lockError, 5000, 'Backup lock helper did not become ready');
      if (lockError) throw lockError;

      // The checkpoint survives in .1, but .1 -> .2 fails and the current log loses Bob's switch.
      const currentInfo = fs.statSync(file, { bigint: true });
      identity = currentInfo.ino;
      size = Number(currentInfo.size);
      rotation = undefined;
      accountSwitch('bob', bobPlan, bob);
      while (!rotation && turn < 80) { chatTurn('bob', bobPlan, bob = next(bob, 0.4)); await delay(250); }
      assert(rotation, 'The second log never rotated');
      assert(backupBytes.equals(fs.readFileSync(backupFile)), 'The supposedly surviving backup changed');
    }
    const assertMissedSwitch = () => {
      assert.equal(bobTokenRead, false, 'Service read Bob\'s token; the switch was not missed between polls');
      assert.equal(recorded.some((entry) => entry.account === 'bob'), false, 'Service recorded Bob before the missed-switch check');
    };
    if (missedSwitch) assertMissedSwitch();
    assert.equal(rotation.kind, scenario === 'rename' ? 'renamed' : 'truncated in place', 'Unexpected native rotation behavior');
    const accountEvidenceAfterRotation = /\] (?:Logged in as |Got Copilot token for )/.test(fs.readFileSync(file, 'utf8'));
    const backupsAfterRotation = fs.readdirSync(folder).filter((name) => /\.\d+\.log$/.test(name)).length;
    if (scenario === 'rename') assert(backupsAfterRotation > 0, 'Rename did not retain a backup');
    else {
      assert.equal(backupsAfterRotation, backupFailure ? 1 : 0, 'Unexpected backups after truncation');
      assert.equal(accountEvidenceAfterRotation, false, 'Truncation did not erase account evidence');
    }

    for (let index = 0; index < 10; index++) {
      if (scenario === 'switch-after-truncation' && index === 4) {
        accountSwitch('bob', 1500, bob = 80);
        // A response from Alice's earlier request can still arrive without identity.
        chatTurn('alice', 1500, alice = next(alice, 0.4), 4);
      }
      if (recovery && index === 4) {
        tokenLines('alice', 1500, alice = 62, true);
        minted();
        // Bob's response outlives both switches; their identifying lines were erased.
        chatTurn('bob', bobPlan, 79, 4);
      }
      if (scenario.startsWith('switch-in-gap') || switchBefore || backupFailure || (recovery && index < 4)
        || (scenario === 'switch-after-truncation' && index >= 4)) chatTurn('bob', bobPlan, bob = next(bob, 0.5), 32);
      else chatTurn('alice', 1500, alice = next(alice, 0.4), 32);
      await delay(250);
    }
    if (backupFailure) {
      assert.equal(polls.length, startupPolls, 'Service polled during the explicitly unread two-rotation gap');
      await service.refreshNow();
    }
    else await delay(5000); // At least two more two-second polls after the last write.
    if (missedSwitch) assertMissedSwitch();

    const names = fs.readdirSync(folder);
    const contents = names.filter((name) => name.endsWith('.log')).map((name) => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n');
    const current = fs.readFileSync(file, 'utf8');
    const rotatedAt = new Date(current.slice(0, 23)).getTime();
    const final = service.getState();
    const accountOf = (percent) => new Set(logged.filter((entry) => entry.percent === percent).map((entry) => entry.account));
    const misattributed = recorded.filter((entry) => !accountOf(entry.percent).has(entry.account));
    const recordedAfter = recorded.filter((entry) => entry.at >= rotatedAt);
    const finalAccountWrong = final.kind === 'quota' && final.account !== undefined && !accountOf(final.quota.percentRemaining).has(final.account);
    const newestAlice = logged.filter((entry) => entry.account === 'alice').at(-1).percent;
    const newestBob = logged.filter((entry) => entry.account === 'bob').at(-1)?.percent;
    let passed = misattributed.length === 0 && !finalAccountWrong;
    if (scenario === 'truncation' || scenario === 'rename' || scenario.startsWith('switch-in-gap') || switchBefore || backupFailure) {
      // No current-log account line verifies these values, even if an older backup survives.
      const newest = scenario === 'truncation' || scenario === 'rename' ? newestAlice : newestBob;
      passed &&= final.kind === 'quota' && final.account === undefined && final.quota.percentRemaining === newest && recordedAfter.length === 0;
    } else {
      // After a switch or lost-prefix recovery, only the named token snapshot is trusted.
      const expectedAccount = recovery ? 'alice' : 'bob';
      const expectedPercent = recovery ? 62 : 80;
      passed &&= final.kind === 'quota' && final.account === expectedAccount && final.quota.percentRemaining === expectedPercent
        && recordedAfter.length > 0 && recordedAfter.every((entry) => entry.account === expectedAccount && entry.percent === expectedPercent);
    }
    console.log(JSON.stringify({
      scenario,
      ...(backupFailure ? { firstRotation, manualServicePolls: true } : {}),
      rotation: rotation.kind,
      backups: names.filter((name) => /\.\d+\.log$/.test(name)).length,
      accountEvidenceAfterRotation,
      bobTokenRead,
      accountEvidenceStillInLogs: /\] (?:Logged in as |Got Copilot token for )/.test(contents),
      currentLogBegins: current.slice(0, 23),
      lastRecordedBeforeRotation: recorded.filter((entry) => entry.at < rotatedAt).map((entry) => `${entry.account} ${entry.percent}% at ${localTime(entry.at)}`).at(-1),
      recordedAfterRotation: recordedAfter.map((entry) => `${entry.account} ${entry.percent}%`),
      newestLoggedQuota: logged.at(-1),
      finalState: describe(final),
      misattributed: misattributed.map((entry) => `${entry.account} ${entry.percent}%`),
      stateTimeline: timeline.map((entry) => `${(entry.atMs / 1000).toFixed(1)}s ${entry.state}`),
      verdict: passed ? 'quota followed the log without naming or recording a wrong account' : 'failure reproduced',
    }, null, 2));
    return passed;
  } finally {
    clearInterval(monitor);
    clearInterval(watcher);
    service?.dispose();
    if (child && child.exitCode === null) child.kill();
    logger.drop();
    global.setTimeout = scheduleTimeout;
  }
}

if (process.argv[2] === '--host') {
  host(process.argv[3], process.argv[4], process.argv[5]).then((passed) => { process.exitCode = passed ? 0 : 1; })
    .catch((error) => { console.error(error); process.exitCode = 2; });
} else {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
  const rev = option('--rev');
  const source = option('--source');
  const [electron, addon, scenario = 'truncation'] = args;
  if (!electron || !addon || !SCENARIOS.includes(scenario) || process.platform !== 'win32') {
    console.error(`Usage on Windows: node src/dev/reproQuotaLogTruncation.cjs <Code.exe> <spdlog.node> [${SCENARIOS.join('|')}] [--rev <git-rev> | --source <quotaService.ts>]`);
    process.exitCode = 2;
  } else {
    const repo = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-truncation-repro-'));
    try {
      let entry = source ? path.resolve(source) : path.join(repo, 'src', 'core', 'quotaService.ts');
      if (rev) {
        // Build an earlier service revision from git without touching the working tree.
        const core = path.join(root, 'src', 'core');
        fs.mkdirSync(core, { recursive: true });
        for (const name of ['quotaService.ts', 'quota.ts', 'quotaHistory.ts']) {
          fs.writeFileSync(path.join(core, name), execFileSync('git', ['show', `${rev}:src/core/${name}`], { cwd: repo }));
        }
        entry = path.join(core, 'quotaService.ts');
      }
      require(path.join(repo, 'node_modules', 'esbuild')).buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
        outfile: path.join(root, 'quotaService.cjs'), external: ['vscode'], logLevel: 'error' });
      const result = spawnSync(electron, [__filename, '--host', path.resolve(addon), root, scenario], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 180000,
      });
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      if (result.error) console.error(result.error);
      process.exitCode = result.status ?? 2;
      if (scenario === 'backup-rename-failure' && !/failed renaming [^\r\n]*GitHub Copilot Chat\.1\.log to [^\r\n]*GitHub Copilot Chat\.2\.log: permission denied/i.test(result.stderr ?? '')) {
        console.error('Harness error: the native logger did not report the required .1 -> .2 backup rename failure.');
        process.exitCode = 2;
      }
    } finally {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('quota-truncation-repro-')) {
        throw new Error('Unsafe temporary fixture path');
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
