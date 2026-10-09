import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addReadings,
  assignAccounts,
  dailyUsed,
  formatNumber,
  loadRecords,
  monthlyPace,
  readLogs,
  statusText,
  toReading,
  type Found,
  type LogState,
  type Reading,
  type Records,
} from "../src/quota";

const RESET = "2026-10-01T00:00:00.000Z";
const payload = {
  quota: 80000,
  unlimited: false,
  hasQuota: true,
  percentRemaining: 26.5,
  additionalUsageUsed: 0,
  additionalUsageEnabled: true,
  resetDate: RESET,
};

/** Local time, as Copilot Chat stamps its log lines. */
function time(day: number, hour: number, minute = 0, second = 0, ms = 0, month = 9): number {
  return new Date(2026, month - 1, day, hour, minute, second, ms).getTime();
}

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

const quotaLine = (at: number, percentRemaining: number, method = "processQuotaHeaders") =>
  `${stamp(at)} [trace] [ChatQuota] ${method}: ${JSON.stringify({ ...payload, percentRemaining })}\r\n`;
const tokenLine = (at: number, login: string) =>
  `${stamp(at)} [info] Got Copilot token for ${login}\r\n`;
// Windows are listed in directory order, which differs between platforms.
const byTime = (found: Found[]) => [...found].sort((a, b) => a.reading.at - b.reading.at);

function reading(at: number, percentRemaining: number, extra: Partial<Reading> = {}): Reading {
  return { at, quota: 80000, percentRemaining, resetDate: RESET, unlimited: false, ...extra };
}

describe("quota payloads", () => {
  it("keeps the allowance, percentage, reset date and unlimited flag", () => {
    expect(toReading(5, payload)).toEqual({
      at: 5,
      quota: 80000,
      percentRemaining: 26.5,
      resetDate: RESET,
      unlimited: false,
    });
    expect(toReading(5, { ...payload, quota: -1 })?.unlimited).toBe(true);
    expect(toReading(5, { ...payload, quota: -1, unlimited: true })?.unlimited).toBe(true);
    expect(toReading(5, { ...payload, unlimited: true })?.unlimited).toBe(true);
    expect(toReading(5, { ...payload, percentRemaining: 100 })?.percentRemaining).toBe(100);
  });

  it("counts spending past the allowance only while no allowance remains", () => {
    expect(
      toReading(5, { ...payload, percentRemaining: 0, additionalUsageUsed: 2560 })
        ?.additionalUsageUsed,
    ).toBe(2560);
    expect(
      toReading(5, { ...payload, percentRemaining: 0.1, additionalUsageUsed: 300 }),
    ).not.toHaveProperty("additionalUsageUsed");
    for (const additionalUsageUsed of [0, -1, null, "3", Infinity]) {
      const kept = toReading(5, { ...payload, percentRemaining: 0, additionalUsageUsed });
      expect(kept).toBeDefined();
      expect(kept).not.toHaveProperty("additionalUsageUsed");
    }
  });

  it("keeps a reading whose reset date is not text, without the date", () => {
    for (const resetDate of [null, 5, undefined]) {
      const kept = toReading(5, { ...payload, resetDate });
      expect(kept?.percentRemaining).toBe(26.5);
      expect(kept).not.toHaveProperty("resetDate");
    }
  });

  it.each([
    ["null", null],
    ["an infinite quota", { ...payload, quota: Infinity }],
    ["101% remaining", { ...payload, percentRemaining: 101 }],
    ["-1% remaining", { ...payload, percentRemaining: -1 }],
    ["a text unlimited flag", { ...payload, unlimited: "false" }],
  ])("rejects %s", (_name, value) => {
    expect(toReading(5, value)).toBeUndefined();
  });
});

describe("reading the session logs", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function session(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "copilot-credits-"));
    roots.push(root);
    return root;
  }

  async function log(
    root: string,
    window: string,
    text: string,
    file = "GitHub Copilot Chat.log",
  ): Promise<string> {
    const folder = join(root, window, "exthost", "GitHub.copilot-chat");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, file), text);
    return join(folder, file);
  }

  const newState = (): LogState => ({ windows: new Map(), logins: [] });

  it("reads every window and names each reading after its window's latest account line", async () => {
    const root = await session();
    await log(
      root,
      "window1",
      [
        tokenLine(time(23, 9, 0, 1), "leon-work"),
        quotaLine(time(23, 9, 5), 26.6, "processUserInfoQuotaSnapshot"),
        `  ${stamp(time(23, 9, 8))} [info] Got Copilot token for quoted-in-a-message\r\n`,
        `${stamp(time(23, 9, 9))} [trace] [ChatQuota] processQuotaHeaders: {"quota":"x"}\r\n`,
        quotaLine(time(23, 10), 26.5),
      ].join(""),
    );
    await log(
      root,
      "window2",
      tokenLine(time(23, 9, 10), "leon") +
        quotaLine(time(23, 9, 15), 26.6, "processQuotaSnapshots"),
    );
    await mkdir(join(root, "window3", "exthost"), { recursive: true });

    const state = newState();
    expect(byTime(await readLogs(root, state))).toEqual([
      { login: "leon-work", reading: reading(time(23, 9, 5), 26.6) },
      { login: "leon", reading: reading(time(23, 9, 15), 26.6) },
      { login: "leon-work", reading: reading(time(23, 10), 26.5) },
    ]);
    expect([...state.logins].sort((a, b) => a.at - b.at)).toEqual([
      { at: time(23, 9, 0, 1), login: "leon-work" },
      { at: time(23, 9, 10), login: "leon" },
    ]);
  });

  it("reads only what a log gained, and waits for a line to end", async () => {
    const root = await session();
    const file = await log(
      root,
      "window1",
      tokenLine(time(23, 9), "leon-work") + quotaLine(time(23, 9, 1), 26.6),
    );
    const state = newState();
    expect(await readLogs(root, state)).toHaveLength(1);
    expect(await readLogs(root, state)).toEqual([]);
    const half = quotaLine(time(23, 10), 26.5);
    await appendFile(file, half.slice(0, 40));
    expect(await readLogs(root, state)).toEqual([]);
    await appendFile(file, half.slice(40) + quotaLine(time(23, 11), 26.4));
    expect(await readLogs(root, state)).toEqual([
      { login: "leon-work", reading: reading(time(23, 10), 26.5) },
      { login: "leon-work", reading: reading(time(23, 11), 26.4) },
    ]);
  });

  it("reads a log again from its start after it was emptied, keeping the window's account", async () => {
    const root = await session();
    const file = await log(
      root,
      "window1",
      tokenLine(time(23, 9), "leon-work") + quotaLine(time(23, 9, 1), 26.6),
    );
    const state = newState();
    await readLogs(root, state);
    await writeFile(file, quotaLine(time(23, 12), 26.3));
    expect(await readLogs(root, state)).toEqual([
      { login: "leon-work", reading: reading(time(23, 12), 26.3) },
    ]);
  });

  it("reads rotated copies first, oldest first, when it first sees a window", async () => {
    const root = await session();
    await log(
      root,
      "window1",
      tokenLine(time(23, 8), "leon-old") + quotaLine(time(23, 8, 5), 27),
      "GitHub Copilot Chat.2.log",
    );
    await log(root, "window1", tokenLine(time(23, 9), "leon-work"), "GitHub Copilot Chat.1.log");
    await log(root, "window1", quotaLine(time(23, 10), 26.5));
    const state = newState();
    expect(await readLogs(root, state)).toEqual([
      { login: "leon-old", reading: reading(time(23, 8, 5), 27) },
      { login: "leon-work", reading: reading(time(23, 10), 26.5) },
    ]);
    expect(await readLogs(root, state)).toEqual([]);
  });

  it("marks anonymous or unreadable accounts as none, and lowercases logins", async () => {
    const root = await session();
    const names = [
      "devDeviceId",
      "DevDeviceID",
      "<unknown>",
      "Leon Björklund",
      "leon-",
      "",
      "Leon_ACME",
    ];
    for (const [index, name] of names.entries()) {
      // Each window names another account first, so a skipped line would leave that account in place.
      await log(
        root,
        `window${index + 1}`,
        tokenLine(time(23, 8), "leon") +
          tokenLine(time(23, 9), name) +
          quotaLine(time(23, 9, index + 1), 26.6),
      );
    }
    await log(root, "window8", quotaLine(time(23, 9, 8), 26.6));
    const found = byTime(await readLogs(root, newState()));
    expect(found.map((entry) => entry.login)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "leon_acme",
      undefined,
    ]);
  });

  it("dates lines in local time and skips payloads that are not JSON", async () => {
    const root = await session();
    await log(
      root,
      "window1",
      `${tokenLine(time(23, 9), "leon-work")}${stamp(time(23, 9, 1))} [trace] [ChatQuota] processQuotaHeaders: {oops\n` +
        quotaLine(time(23, 23, 59, 59, 999), 26.5).replace("\r\n", "\n"),
    );
    expect(await readLogs(root, newState())).toEqual([
      { login: "leon-work", reading: reading(time(23, 23, 59, 59, 999), 26.5) },
    ]);
  });

  it("keeps each window's latest Trace line time", async () => {
    const root = await session();
    const first = await log(
      root,
      "window1",
      `${stamp(time(23, 9))} [info] Logged in as leon-work, not [trace]\r\n` +
        `  ${stamp(time(23, 9, 1))} [trace] inside a multi-line message\r\n`,
    );
    const second = await log(
      root,
      "window2",
      `${stamp(time(23, 9))} [trace] started\r\n` +
        `${stamp(time(23, 9, 2))} [trace] detail\r\n${stamp(time(23, 9, 3))} [info] later\r\n`,
    );
    const state = newState();
    await readLogs(root, state);
    expect(state.windows.get("window1")?.traceAt).toBeUndefined();
    expect(state.windows.get("window2")?.traceAt).toBe(time(23, 9, 2));
    await appendFile(first, `${stamp(time(23, 10))} [trace] now\r\n`);
    await readLogs(root, state);
    expect(state.windows.get("window1")?.traceAt).toBe(time(23, 10));
    await appendFile(second, `${stamp(time(23, 11))} [info] no Trace line in this read\r\n`);
    await readLogs(root, state);
    expect(state.windows.get("window2")?.traceAt).toBe(time(23, 9, 2));
  });

  it("returns nothing for a missing session", async () => {
    expect(await readLogs(join(await session(), "gone"), newState())).toEqual([]);
  });
});

describe("accounts", () => {
  const logins = [
    { at: time(23, 9), login: "leon-work" },
    { at: time(23, 12), login: "leon" },
    { at: time(23, 14), login: null },
  ];

  it("uses the window's account, and drops readings of no account", () => {
    expect(
      assignAccounts(
        [
          { login: "leon", reading: reading(time(23, 10), 26) },
          { login: null, reading: reading(time(23, 10), 26) },
        ],
        logins,
        "saved",
      ),
    ).toEqual([{ login: "leon", reading: reading(time(23, 10), 26) }]);
  });

  it("falls back to the latest account line of any window before the reading, then the saved account", () => {
    const lost = (at: number) => ({ reading: reading(at, 26) });
    expect(
      assignAccounts(
        [lost(time(23, 11)), lost(time(23, 12)), lost(time(23, 15)), lost(time(23, 8))],
        logins,
        "saved",
      ),
    ).toEqual([
      { login: "leon-work", reading: reading(time(23, 11), 26) },
      { login: "leon", reading: reading(time(23, 12), 26) },
      { login: "saved", reading: reading(time(23, 8), 26) },
    ]);
    expect(assignAccounts([lost(time(23, 8))], [], undefined)).toEqual([]);
  });

  it("takes the latest account line by time, whatever order the windows were read in", () => {
    const outOfOrder = [
      { at: time(23, 12), login: "leon" },
      { at: time(23, 9), login: "leon-work" },
    ];
    expect(assignAccounts([{ reading: reading(time(23, 13), 26) }], outOfOrder, "saved")).toEqual([
      { login: "leon", reading: reading(time(23, 13), 26) },
    ]);
  });
});

describe("saved record", () => {
  const now = time(23, 12);

  it("keeps each account's earliest reading and the last reading of each day", () => {
    const records = addReadings(
      {},
      [
        reading(time(21, 9), 30),
        reading(time(21, 18), 29),
        reading(time(22, 9), 28),
        reading(time(22, 23, 59), 27.5),
        reading(time(23, 8), 27),
        reading(time(23, 11), 26.5),
      ].map((entry) => ({ login: "leon", reading: entry })),
      now,
    );
    expect(records.leon.map((entry) => entry.at)).toEqual([
      time(21, 9),
      time(21, 18),
      time(22, 23, 59),
      time(23, 11),
    ]);
  });

  it("is unchanged when the same readings are added again", () => {
    const added = [
      reading(time(22, 9), 28),
      reading(time(23, 8), 27),
      reading(time(23, 11), 26.5),
    ].map((entry) => ({ login: "leon", reading: entry }));
    const records = addReadings({}, added, now);
    expect(addReadings(records, added, now)).toEqual(records);
    expect(addReadings(records, added.slice(1), now)).toEqual(records);
  });

  it("drops readings older than 35 days or stamped in the future, and accounts left empty", () => {
    const records: Records = {
      old: [reading(time(18, 9, 0, 0, 0, 8), 50)],
      leon: [reading(time(19, 9, 0, 0, 0, 8), 40)],
    };
    expect(
      addReadings(records, [{ login: "leon", reading: reading(time(23, 13), 26) }], now),
    ).toEqual({
      leon: [reading(time(19, 9, 0, 0, 0, 8), 40)],
    });
  });

  it("keeps the newest reading older than 35 days while newer ones remain, since the oldest day counts from it", () => {
    const later = time(16, 12);
    const added = [
      reading(time(5, 9, 0, 0, 0, 8), 95),
      reading(time(10, 9, 0, 0, 0, 8), 90),
      reading(time(21, 9, 0, 0, 0, 8), 80),
    ].map((entry) => ({ login: "leon", reading: entry }));
    const records = addReadings({}, added, later);
    expect(records.leon.map((entry) => entry.at)).toEqual([
      time(10, 9, 0, 0, 0, 8),
      time(21, 9, 0, 0, 0, 8),
    ]);
    expect(
      dailyUsed(records.leon, later).find((entry) => entry.day === time(21, 0, 0, 0, 0, 8))?.used,
    ).toBe(0);
    expect(dailyUsed(records.leon, later)[0].gap).toEqual({
      from: time(10, 9, 0, 0, 0, 8),
      to: time(21, 9, 0, 0, 0, 8),
      used: 10,
    });
  });

  it("keeps accounts apart", () => {
    const records = addReadings(
      {},
      [
        { login: "leon", reading: reading(time(23, 9), 26) },
        { login: "leon-work", reading: reading(time(23, 10), 60) },
      ],
      now,
    );
    expect(records).toEqual({
      leon: [reading(time(23, 9), 26)],
      "leon-work": [reading(time(23, 10), 60)],
    });
  });

  it("loads saved readings and drops anything malformed", () => {
    const records = addReadings(
      {},
      [
        { login: "leon", reading: reading(time(22, 9), 28) },
        { login: "leon", reading: reading(time(23, 9), 0, { additionalUsageUsed: 100 }) },
      ],
      now,
    );
    expect(loadRecords(JSON.parse(JSON.stringify(records)))).toEqual(records);
    expect(loadRecords(undefined)).toEqual({});
    expect(loadRecords(null)).toEqual({});
    expect(loadRecords("text")).toEqual({});
    expect(loadRecords({ a: "text", b: [null, 5, { at: "soon", ...payload }], c: [] })).toEqual({});
    expect(
      loadRecords(
        JSON.parse(`{"__proto__": [${JSON.stringify({ ...payload, at: 10 })}], "not valid": []}`),
      ),
    ).toEqual({});
    expect(loadRecords({ "not valid": [{ ...payload, at: 10 }] })).toEqual({});
  });

  it("keeps a login that names an object property", () => {
    const records = addReadings(
      {},
      [{ login: "constructor", reading: reading(time(23, 9), 26) }],
      now,
    );
    expect(Object.keys(records)).toEqual(["constructor"]);
  });
});

describe("today and month", () => {
  const now = time(23, 16);

  it("reads today as the latest reading minus the last one before midnight, a midnight reading included", () => {
    const readings = [
      reading(time(22, 23), 26.6),
      reading(time(23, 0), 25),
      reading(time(23, 15), 23.5),
    ];
    expect(statusText({ leon: readings }, now)).toBe("3.1% | 76.5%");
    expect(
      dailyUsed(readings, now)
        .slice(-2)
        .map((entry) => entry.used),
    ).toEqual([0, expect.closeTo(3.1)]);
    expect(statusText({ leon: [reading(time(21, 9), 30), reading(time(22, 15), 23.5)] }, now)).toBe(
      "0% | 76.5%",
    );
  });

  it("shows spending past the allowance", () => {
    const readings = [
      reading(time(22, 20), 1),
      reading(time(23, 15), 0, { additionalUsageUsed: 2560 }),
    ];
    expect(statusText({ leon: readings }, now)).toBe("4.2% | 103.2%");
    expect(
      statusText(
        { leon: [reading(time(22, 20), 0, { additionalUsageUsed: 800 }), readings[1]] },
        now,
      ),
    ).toBe("2.2% | 103.2%");
    expect(statusText({ leon: [reading(time(23, 15), 0)] }, now)).toBe("0% | 100%");
    expect(
      statusText({ leon: [reading(time(23, 15), 0, { additionalUsageUsed: 400 })] }, now),
    ).toBe("0% | 100.5%");
  });

  it("never shows a lower latest reading as negative", () => {
    expect(
      statusText({ leon: [reading(time(22, 20), 23.5), reading(time(23, 15), 23.8)] }, now),
    ).toBe("0% | 76.2%");
  });

  it("keeps today's spend but shows the month at zero once the reset passed and Copilot has not reported since", () => {
    // A reset at local noon keeps the reset apart from local midnight in every time zone.
    const resetDate = new Date(2026, 9, 1, 12).toISOString();
    const readings = [
      reading(time(30, 23, 59), 30, { resetDate }),
      reading(time(1, 11, 59, 0, 0, 10), 28, { resetDate }),
    ];
    expect(statusText({ leon: readings }, time(1, 12, 1, 0, 0, 10))).toBe("2% | 0%");
  });

  it("trusts a reading that still reports the old period after its reset date", () => {
    const readings = [reading(time(30, 10), 23.5), reading(time(1, 15, 0, 0, 0, 10), 23.4)];
    expect(statusText({ leon: readings }, time(1, 16, 0, 0, 0, 10))).toBe("0.1% | 76.6%");
  });

  it("does not take a changed reset date that has not passed for a reset", () => {
    // Copilot invents a reset date a month ahead when the server sends none.
    const readings = [
      reading(time(22, 20), 26.6, { resetDate: "2026-10-22T20:00:00.000Z" }),
      reading(time(23, 15), 23.5, { resetDate: "2026-10-23T15:00:00.000Z" }),
    ];
    expect(statusText({ leon: readings }, now)).toBe("3.1% | 76.5%");
  });

  it("reads a base without a reset date or allowance as the same period", () => {
    const noReset = [
      reading(time(22, 20), 26.6, { resetDate: undefined }),
      reading(time(23, 15), 23.5),
    ];
    expect(statusText({ leon: noReset }, now)).toBe("3.1% | 76.5%");
    const noAllowance = [reading(time(22, 20), 100, { quota: 0 }), reading(time(23, 15), 90)];
    expect(statusText({ leon: noAllowance }, now)).toBe("10% | 10%");
  });

  it("shows the account Copilot reported for last", () => {
    const records = {
      "leon-work": [reading(time(22, 20), 26.6), reading(time(23, 14), 23.5)],
      leon: [reading(time(22, 20), 51), reading(time(23, 15), 50)],
    };
    expect(statusText(records, now)).toBe("1% | 50%");
  });

  it("names unlimited and zero allowances and waits without a reading", () => {
    expect(statusText({}, now)).toBe("Waiting for Copilot");
    expect(statusText({}, now, "restart")).toBe("Restart to see Credit usage");
    expect(statusText({}, now, "trace")).toBe("Set Copilot Chat log level to Trace");
    expect(
      statusText(
        { leon: [reading(time(22, 20), 26.6), reading(time(23, 15), 23.5)] },
        now,
        "trace",
      ),
    ).toBe("3.1% | 76.5%");
    expect(
      statusText({ leon: [reading(time(23, 15), 100, { quota: -1, unlimited: true })] }, now),
    ).toBe("Unlimited Copilot quota");
    expect(
      statusText({ leon: [reading(time(23, 15), 100, { quota: 0, unlimited: true })] }, now),
    ).toBe("Unlimited Copilot quota");
    expect(statusText({ leon: [reading(time(23, 15), 0, { quota: 0 })] }, now)).toBe(
      "No Copilot credit allowance",
    );
  });
});

describe("days", () => {
  it("keeps the first reading after a gap as the daily baseline across polls and restarts", () => {
    const before = reading(time(21, 17), 89.1);
    const first = reading(time(23, 7), 82.6);
    const add = (records: Records, entries: Reading[]) =>
      addReadings(
        records,
        entries.map((entry) => ({ login: "leon", reading: entry })),
        time(23, 16),
      );
    let records = add({}, [before, first]);
    expect(statusText(records, time(23, 7))).toBe("0% | 17.4%");
    records = add(records, [reading(time(23, 9), 82)]);
    records = add(loadRecords(JSON.parse(JSON.stringify(records))), [reading(time(23, 15), 81.8)]);
    expect(records.leon).toContainEqual(first);
    expect(statusText(records, time(23, 16))).toBe("0.8% | 18.2%");
    const days = dailyUsed(records.leon, time(23, 16)).slice(-3);
    const gap = { from: before.at, to: first.at, used: expect.closeTo(6.5) };
    expect(days.map((day) => day.gap)).toEqual([gap, gap, undefined]);
    expect(days.map((day) => day.used)).toEqual([0, 0, expect.closeTo(0.8)]);
  });

  it.each([
    ["unchanged balance", time(21, 9), 80, time(23, 9), 80, 0, false],
    ["lower use", time(21, 9), 80, time(23, 9), 81, 0, false],
    ["same day", time(23, 8), 80, time(23, 9), 79, 1, false],
    ["consecutive days over 24 hours apart", time(22, 0), 80, time(23, 15), 79, 1, false],
    ["one whole missing calendar day", time(21, 23, 59), 80, time(23, 0), 79, 0, true],
  ])(
    "marks only an increase across a missing day: %s",
    (_name, from, before, to, after, today, striped) => {
      const readings = [reading(from, before), reading(to, after)];
      const days = dailyUsed(readings, time(23, 16));
      expect(days.some((day) => day.gap !== undefined)).toBe(striped);
      expect(days.at(-1)?.used).toBe(today);
    },
  );

  it("limits a gap across a monthly reset to the new period's observed usage", () => {
    const resetDate = new Date(2026, 9, 1, 12).toISOString();
    const before = reading(time(29, 20), 40, { resetDate });
    const first = reading(time(3, 8, 0, 0, 0, 10), 97, { resetDate: "2026-11-01T00:00:00.000Z" });
    const later = { ...first, at: time(3, 15, 0, 0, 0, 10), percentRemaining: 96.5 };
    const days = dailyUsed([before, first, later], later.at);
    expect(days.slice(-3).map((day) => day.gap)).toEqual([
      { from: Date.parse(resetDate), to: first.at, used: 3 },
      { from: Date.parse(resetDate), to: first.at, used: 3 },
      undefined,
    ]);
    expect(days.slice(0, -3).every((day) => day.gap === undefined)).toBe(true);
    expect(statusText({ leon: [before, first, later] }, later.at)).toBe("0.5% | 3.5%");
    // Returning on the reset day counts only the new allowance, without inventing a gap total.
    const resetDay = { ...first, at: time(1, 15, 0, 0, 0, 10) };
    expect(statusText({ leon: [before, resetDay] }, resetDay.at)).toBe("3% | 3%");
    expect(dailyUsed([before, resetDay], resetDay.at).some((day) => day.gap)).toBe(false);
    // Several resets may pass while away; October's total cannot describe September's use.
    const older = reading(time(30, 20, 0, 0, 0, 8), 80, { resetDate: "2026-09-01T00:00:00.000Z" });
    const monthStart = Date.UTC(2026, 9, 1);
    const afterSeveralResets = dailyUsed([older, first, later], later.at);
    const gaps = afterSeveralResets.filter((day) => day.gap);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((day) => day.gap!.from === monthStart && day.gap!.used === 3)).toBe(true);
  });

  it("recomputes a gap when another window supplies the missing day's readings", () => {
    const entries = [
      reading(time(21, 18), 80),
      reading(time(23, 8), 75),
      reading(time(23, 15), 74),
    ];
    const now = time(23, 16);
    const records = addReadings(
      {},
      entries.map((entry) => ({ login: "leon", reading: entry })),
      now,
    );
    expect(statusText(records, now)).toBe("1% | 26%");
    const filled = addReadings(
      records,
      [{ login: "leon", reading: reading(time(22, 20), 77) }],
      now,
    );
    expect(statusText(filled, now)).toBe("3% | 26%");
    expect(dailyUsed(filled.leon, now).some((day) => day.gap)).toBe(false);
  });

  it("keeps a delayed monthly reset's first reading out of today's use after a gap", () => {
    const before = reading(time(29, 20), 80);
    const oldPeriod = reading(time(3, 8, 0, 0, 0, 10), 75);
    const first = reading(time(3, 9, 0, 0, 0, 10), 97, { resetDate: "2026-11-01T00:00:00.000Z" });
    const later = { ...first, at: time(3, 15, 0, 0, 0, 10), percentRemaining: 96 };
    const records = addReadings(
      {},
      [before, oldPeriod, first, later].map((entry) => ({ login: "leon", reading: entry })),
      later.at,
    );
    expect(statusText(records, later.at)).toBe("1% | 4%");
    expect(records.leon).toContainEqual(first);
    expect(dailyUsed(records.leon, later.at).at(-2)?.gap).toEqual({
      from: Date.parse(RESET), to: first.at, used: 3,
    });
    const interleaved = addReadings(records, [
      { ...oldPeriod, at: time(3, 10, 0, 0, 0, 10) },
      { ...first, at: time(3, 11, 0, 0, 0, 10), percentRemaining: 96 },
      { ...later, at: time(3, 16, 0, 0, 0, 10), percentRemaining: 95 },
    ].map((entry) => ({ login: "leon", reading: entry })), time(3, 16, 0, 0, 0, 10));
    expect(statusText(interleaved, time(3, 16, 0, 0, 0, 10))).toBe("2% | 5%");
    expect(dailyUsed(interleaved.leon, time(3, 16, 0, 0, 0, 10)).at(-2)?.gap).toEqual({
      from: Date.parse(RESET), to: first.at, used: 3,
    });
    // A delayed reset alone is not a missing day when quota readings continued every day.
    const continuous = addReadings(records, [
      reading(time(30, 20), 80),
      reading(time(1, 20, 0, 0, 0, 10), 80),
      reading(time(2, 20, 0, 0, 0, 10), 80),
    ].map((entry) => ({ login: "leon", reading: entry })), later.at);
    expect(statusText(continuous, later.at)).toBe("9% | 4%");
    expect(dailyUsed(continuous.leon, later.at).some((day) => day.gap)).toBe(false);
  });

  it("gives each of the last 30 days its last reading minus the one before, nothing before the first reading", () => {
    const readings = [
      reading(time(20, 9), 40),
      reading(time(20, 18), 38),
      reading(time(22, 23), 30),
      reading(time(23, 15), 26),
    ];
    const days = dailyUsed(readings, time(23, 16));
    expect(days).toHaveLength(30);
    expect(days[0].day).toBe(time(25, 0, 0, 0, 0, 8));
    expect(days.slice(25).map((entry) => [new Date(entry.day).getDate(), entry.used])).toEqual([
      [19, undefined],
      [20, 2],
      [21, 0],
      [22, 0],
      [23, 4],
    ]);
  });

  it("adds a reset day's spend before the reset to the new period's, keeping the reading before the reset", () => {
    const resetDate = new Date(2026, 9, 1, 12).toISOString();
    const readings = [
      reading(time(29, 20), 50, { resetDate }),
      reading(time(30, 20), 40, { resetDate }),
      reading(time(1, 15, 0, 0, 0, 10), 97, { resetDate: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(
      dailyUsed(readings, time(1, 16, 0, 0, 0, 10))
        .slice(-2)
        .map((entry) => entry.used),
    ).toEqual([10, 3]);
    const beforeReset = reading(time(1, 11, 0, 0, 0, 10), 38, { resetDate });
    const saved = addReadings(
      {},
      [...readings, beforeReset].map((entry) => ({ login: "leon", reading: entry })),
      time(1, 16, 0, 0, 0, 10),
    );
    expect(saved.leon).toContainEqual(beforeReset);
    expect(
      dailyUsed(saved.leon, time(1, 16, 0, 0, 0, 10))
        .slice(-2)
        .map((entry) => entry.used),
    ).toEqual([10, 5]);
  });
});

describe("monthly pace", () => {
  const at = Date.UTC(2026, 8, 16);

  it("projects the share used over the whole month, counting the reading's day in full", () => {
    // 30% used on day 16 of October projects to 30 * 31 / 16 = 58.125%.
    expect(
      monthlyPace(
        reading(Date.UTC(2026, 9, 16, 12), 70, { resetDate: "2026-11-01T00:00:00.000Z" }),
        Date.UTC(2026, 9, 20),
      ),
    ).toBeCloseTo(58.125);
    expect(monthlyPace(reading(at, 0, { additionalUsageUsed: 8000 }), at)).toBeCloseTo(206.25);
  });

  it("has no pace without a reset at the start of next UTC month, or outside the reading's month", () => {
    expect(monthlyPace(reading(at, 70, { resetDate: undefined }), at)).toBeUndefined();
    expect(
      monthlyPace(reading(at, 70, { resetDate: "2026-10-16T00:00:00.000Z" }), at),
    ).toBeUndefined();
    expect(monthlyPace(reading(at, 70), Date.UTC(2026, 9, 1))).toBeUndefined();
  });
});

describe("numbers", () => {
  it.each([
    [0.04, "0"],
    [0.05, "0.1"],
    [61200, "61\u00a0200"],
  ])("formats %s as %s", (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });
});
