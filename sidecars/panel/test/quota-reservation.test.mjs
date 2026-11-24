import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QR_CONSUME_LAG_GRACE_MS,
  QR_LEASE_IDLE_EXPIRY_MS,
  QR_REFUND_CONFIRM_WINDOW_MS,
  createQuotaReservationTracker,
} from '../backend/quota-reservation.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';

const T0 = Date.parse('2026-11-22T09:00:00Z');
const RESET_5H = Date.parse('2026-11-22T14:00:00Z');
const RESET_WK = Date.parse('2026-11-28T09:00:00Z');

test('quota-reservation: 5h & weekly independently track staggered leases (错档触发)', () => {
  const tracker = createQuotaReservationTracker();

  // Bootstrap settled baseline: 5h ≈ 0.75 %/$, weekly ≈ 0.22 %/$
  const pool0 = new Map([
    [
      'Gemini',
      {
        poolKey: 'Gemini',
        has5h: true,
        hasWeekly: true,
        remainingFraction: 1 - 0.03,
        usedPct: 3.0,
        resetTime: new Date(RESET_5H).toISOString(),
        weeklyRemainingFraction: 1 - 0.11,
        weeklyUsedPct: 11.0,
        weeklyResetTime: new Date(RESET_WK).toISOString(),
      },
    ],
  ]);
  const stats0 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.0, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.0, unpricedCalls: 0 },
        exactCost5hUsd: 4.0,
        exactCostWeeklyUsd: 50.0,
        recent10m: { lastActivityMs: T0, activeSessionCount: 1, costUsd: 0.1 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool0,
    poolCycleStats: stats0,
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  assert.equal(pool0.get('Gemini').reservedPct, 0);
  assert.equal(pool0.get('Gemini').weeklyReservedPct, 0);

  // Heavy turn ($0.10): 5h jumps +1.0% (lease 1%), weekly jumps +0.5% (lease 0.5%)
  const t1 = T0 + 20_000;
  const pool1 = new Map([
    [
      'Gemini',
      {
        ...pool0.get('Gemini'),
        remainingFraction: 1 - 0.04,
        usedPct: 4.0,
        weeklyRemainingFraction: 1 - 0.115,
        weeklyUsedPct: 11.5,
      },
    ],
  ]);
  const stats1 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.1, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.1, unpricedCalls: 0 },
        exactCost5hUsd: 4.1,
        exactCostWeeklyUsd: 50.1,
        recent10m: { lastActivityMs: t1, activeSessionCount: 1, costUsd: 0.2 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool1,
    poolCycleStats: stats1,
    quotaFetchedAtMs: t1,
    nowMs: t1,
  });

  // 5h excess = 1.0 - 0.075 = 0.925 -> 0.9%; weekly excess = 0.5 - 0.022 = 0.478 -> 0.5%
  assert.equal(pool1.get('Gemini').reservedPct, 0.9);
  assert.equal(pool1.get('Gemini').reservedLeaseCount, 1);
  assert.equal(pool1.get('Gemini').weeklyReservedPct, 0.5);
  assert.equal(pool1.get('Gemini').weeklyReservedLeaseCount, 1);
});

test('quota-reservation: consumes inside active lease and snaps to 0 on partial refund (退还差额)', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Seed calibrated baseline: 1% per $1.00 (4.0% / $4.00)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Trigger 1.0% lease on $0.05 step -> excess = 0.95% -> 1.0%
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);

  // Follow-up turns spend $0.35 inside the lease while official stays flat at 5.0%:
  // first flat tick buffers for reporting-lag grace, follow-up flat poll past grace confirms consume -> 0.6%
  const t2 = t1 + 30_000;
  const r2Pending = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(r2Pending.reservedPct, 1.0);

  const t2Confirm = t2 + QR_CONSUME_LAG_GRACE_MS + 1_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2Confirm,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t2Confirm,
  });
  assert.equal(r2.reservedPct, 0.6);

  // 10 minutes idle: server refunds remaining 0.6% (official drops 5.0% -> 4.4%)
  const t3 = t2Confirm + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.4,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 0);
  assert.equal(r3.reservedLeaseCount, 0);
});

test('quota-reservation: stacks multiple concurrent session leases (2%+) and settles FIFO', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::weekly';

  // Seed weekly baseline: 0.2 %/$ (10% / $50)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 50.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Session A triggers +1.0% weekly lease
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 50.1,
    poolLastActivityMs: t1,
    activeSessionCount10m: 1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);
  assert.equal(r1.reservedLeaseCount, 1);

  // Session B opens concurrently and triggers a second +1.0% weekly lease -> total ~2.0%
  const t2 = t1 + 25_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 12.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 2,
    nowMs: t2,
  });
  assert.equal(r2.reservedPct, 2.0);
  assert.equal(r2.reservedLeaseCount, 2);

  // Session A's lease expires first (-0.98% refund) -> Session B's ~1.0% lease remains
  const t3 = t1 + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.02,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 1,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 1.0);
  assert.equal(r3.reservedLeaseCount, 1);

  // Session B's lease expires (-0.98% refund) -> back to 0%
  const t4 = t2 + 10 * 60 * 1000;
  const r4 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.04,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t4,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 0,
    nowMs: t4,
  });
  assert.equal(r4.reservedPct, 0);
  assert.equal(r4.reservedLeaseCount, 0);
});

test('quota-reservation: avoids false positives on genuinely large steps, handles TTL expiry & cycle reset', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Baseline 0.75 %/$
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 3.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Legitimate large $2.00 step -> expected +1.5%, official +1.5% -> NOT a reservation
  const t1 = T0 + 20_000;
  const rLarge = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 6.0,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(rLarge.reservedPct, 0);

  // Lease triggers (+0.5% on tiny $0.02 step), then idle past TTL+grace with no refund -> auto expires
  const t2 = t1 + 20_000;
  const rJump = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(rJump.reservedPct, 0.5);

  const tExpired = t2 + QR_LEASE_IDLE_EXPIRY_MS + 1_000;
  const rExpired = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: tExpired,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: tExpired,
  });
  assert.equal(rExpired.reservedPct, 0);

  // Trigger another lease then simulate 5h cycle rollover -> clears immediately while keeping rate
  const t3 = tExpired + 20_000;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 6.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 6.05,
    poolLastActivityMs: t3,
    nowMs: t3,
  });
  const tReset = t3 + 60_000;
  const rReset = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 0.0,
    resetTimeMs: RESET_5H + 5 * 3600 * 1000,
    quotaFetchedAtMs: tReset,
    cycleCostUsd: 0,
    poolLastActivityMs: t3,
    nowMs: tReset,
  });
  assert.equal(rReset.reservedPct, 0);
  assert.ok(tracker._buckets.get(key).ratePctPerUsd > 0, 'calibrated rate preserved across reset');
});

test('quota-reservation: persists log, calibrated rate, and active leases across plugin restarts', () => {
  let storedPayload = null;
  const trackerA = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });
  const key = 'local::u@example.com::Gemini::5h';

  trackerA.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  const t1 = T0 + 20_000;
  trackerA.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.ok(storedPayload && storedPayload.events.length === 2, 'baseline + lease persisted to disk');

  // Simulate full plugin restart with a brand new tracker instance reading storedPayload
  const trackerB = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });
  const snapBeforeAnyPoll = trackerB.getLogSnapshot();
  assert.equal(snapBeforeAnyPoll.count, 2, 'historical events immediately available after restart');
  assert.equal(snapBeforeAnyPoll.buckets[0].reservedPct, 1.0, 'active lease survives restart');
  assert.equal(snapBeforeAnyPoll.buckets[0].ratePctPerUsd, 1.0, 'calibrated rate survives restart');

  // Refund arriving after restart cleanly reconciles against the hydrated lease
  const t2 = t1 + 10 * 60 * 1000;
  const rAfterRestart = trackerB.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t2,
  });
  assert.equal(rAfterRestart.reservedPct, 0);
  assert.equal(trackerB.getLogSnapshot().count, 3);
});

test('quota-reservation: suppresses replica ping-pong, keeps rolling median rate clean, and ignores 0% idle reset drift', () => {
  const tracker = createQuotaReservationTracker();
  const key5h = 'local::u@example.com::Gemini::5h';
  const keyWk = 'local::u@example.com::Gemini::weekly';
  const keyIdle = 'local::u@example.com::Claude & GPT::5h';

  let ts = T0;
  let u5 = 13.0;
  let uw = 18.0;
  let c5 = 18.0;
  let cw = 86.0;

  // Baseline + 8 clean steps at exact 0.6667 %/$ (5h) and 0.1667 %/$ (weekly)
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: u5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: ts,
    cycleCostUsd: c5,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: uw,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: cw,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  tracker.observeBucket({
    bucketKey: keyIdle,
    officialUsedPct: 0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 0,
    poolLastActivityMs: 0,
    nowMs: ts,
  });

  for (let i = 0; i < 8; i += 1) {
    ts += 15_000;
    const dc = 0.09;
    c5 += dc;
    cw += dc;
    u5 += dc * (2 / 3);
    uw += dc * (1 / 6);
    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: uw,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }

  // Idle 0% pool resetTime drifts by 35 min -> silently absorbed (no spurious reset event)
  tracker.observeBucket({
    bucketKey: keyIdle,
    officialUsedPct: 0,
    resetTimeMs: RESET_5H + 35 * 60 * 1000,
    quotaFetchedAtMs: ts + 35 * 60 * 1000,
    cycleCostUsd: 0,
    poolLastActivityMs: 0,
    nowMs: ts,
  });
  assert.equal(
    tracker.getLogSnapshot().events.some((e) => e.pool === 'Claude & GPT' && e.event === 'reset'),
    false,
    'idle 0% pool drift must not emit reset'
  );

  // Weekly triggers a +0.9% lease on Cell B, then bounces Cell A <-> Cell B 5 times while 5h bounces +/-0.2%
  ts += 10_000;
  const wkBase = uw;
  const wkHigh = uw + 0.9;
  const rLease = tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: wkHigh,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: cw,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLease.reservedPct, 0.9);
  assert.equal(rLease.reservedLeaseCount, 1);

  for (let i = 0; i < 5; i += 1) {
    // Drop to Cell A (low replica)
    ts += 10_000;
    c5 += 0.06;
    cw += 0.06;
    const rLowWk = tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkBase + (i + 1) * 0.01,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    assert.equal(rLowWk.reservedPct, 0, 'low replica hides lease portion so actual stays stable');

    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5 - 0.2 + i * 0.04,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });

    // Bounce back to Cell B (high replica)
    ts += 10_000;
    c5 += 0.06;
    cw += 0.06;
    const rHighWk = tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkHigh + (i + 1) * 0.02,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    assert.equal(rHighWk.reservedPct, 0.9, 'rebound restores same lease without duplicating');
    assert.equal(rHighWk.reservedLeaseCount, 1);

    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5 + 0.08 + i * 0.08,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }

  // Both rolling-median rates remain unpolluted near 0.6667 and 0.1667
  const snapMid = tracker.getLogSnapshot();
  const b5h = snapMid.buckets.find((b) => b.pool === 'Gemini' && b.win === '5h');
  const bWk = snapMid.buckets.find((b) => b.pool === 'Gemini' && b.win === 'weekly');
  assert.ok(Math.abs(b5h.ratePctPerUsd - 0.6667) < 0.02, `5h rate stays clean: ${b5h.ratePctPerUsd}`);
  assert.ok(Math.abs(bWk.ratePctPerUsd - 0.1667) < 0.01, `weekly rate stays clean: ${bWk.ratePctPerUsd}`);

  // Sustained drop on weekly (stays low across >= 3 samples and >= 90s while active) confirms genuine refund
  for (let i = 0; i < 4; i += 1) {
    ts += Math.ceil(QR_REFUND_CONFIRM_WINDOW_MS / 3);
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkBase + 0.1,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }
  const bWkAfter = tracker.getLogSnapshot().buckets.find((b) => b.pool === 'Gemini' && b.win === 'weekly');
  assert.equal(bWkAfter.reservedPct, 0);
  assert.equal(bWkAfter.leases, 0);
});

test('quota-reservation: ignores sub-epsilon shortfall noise and drops polluted v1 EMA rate on schema upgrade', () => {
  // 1. Sub-epsilon rounding mismatch during normal spending must not keep stale leases alive
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 15.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });
  // Trigger +1.0% lease at t1
  const t1 = T0 + 15_000;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 15.0,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  // Normal steps at ~0.666 %/$ (0.001% below cold-start 0.667) across idle expiry window -> lease expires normally
  let u = 11.0;
  let c = 15.0;
  let now = t1;
  const stepMs = Math.ceil((QR_LEASE_IDLE_EXPIRY_MS + 60_000) / 12);
  for (let i = 0; i < 12; i += 1) {
    now += stepMs;
    c += 0.09;
    u += 0.059;
    tracker.observeBucket({
      bucketKey: key,
      officialUsedPct: u,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: now,
      cycleCostUsd: c,
      poolLastActivityMs: now,
      nowMs: now,
    });
  }
  const snap = tracker.getLogSnapshot();
  assert.equal(snap.buckets[0].reservedPct, 0, 'normal billing does not infinitely renew stale lease');

  // 2. Loading v1 persisted payload resets polluted EMA rate while preserving event log
  const v1Payload = {
    version: 1,
    savedAt: new Date(T0).toISOString(),
    buckets: {
      [key]: {
        resetTimeMs: RESET_5H,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 30.0,
        lastCycleCostUsd: 38.0,
        ratePctPerUsd: 2.005,
        rateSamples: 41,
        activeLeases: [],
      },
    },
    events: [{ ts: new Date(T0).toISOString(), pool: 'Gemini', win: '5h', event: 'normal' }],
  };
  const migrated = createQuotaReservationTracker({ loadState: () => v1Payload });
  const migSnap = migrated.getLogSnapshot();
  assert.equal(migSnap.count, 1, 'v1 events preserved on upgrade');
  assert.equal(migSnap.buckets[0].ratePctPerUsd, null, 'polluted v1 rate cleared for clean recalibration');
});

test('quota-reservation: buffers short reporting lag inside lease, survives 35m residency, and clears recovered pendingDrop', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::weekly';

  // Seed baseline at 0.5 %/$ (20% / $40)
  let ts = T0;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.0,
    poolLastActivityMs: ts,
    nowMs: ts,
  });

  // Trigger +0.8% lease
  ts += 10_000;
  const rLease = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.8,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.0,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLease.reservedPct, 0.8);

  // Short 8s upstream reporting lag: dCost=$0.20 (exp=0.1%), dUsed=0 -> buffered, then next tick catches up +0.1%
  ts += 10_000;
  const rLag = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.8,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLag.reservedPct, 0.8, 'first flat tick does not prematurely drain active lease');

  ts += 8_000;
  const rCatchUp = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.9,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rCatchUp.reservedPct, 0.8, 'catch-up tick keeps lease intact with zero false consume');

  // Lease stays alive past 35 minutes idle when official has not refunded yet, then clears on real refund
  const lastActTs = ts;
  ts += 35 * 60 * 1000;
  const rStillHeld = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.9,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: lastActTs,
    nowMs: ts,
  });
  assert.equal(rStillHeld.reservedPct, 0.8, 'active lease survives 35m residency before upstream refund');

  ts += 10 * 60 * 1000;
  const rRefund = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.1,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: lastActTs,
    nowMs: ts,
  });
  assert.equal(rRefund.reservedPct, 0);
  assert.equal(rRefund.reservedLeaseCount, 0);

  // Small drop (-0.05%) recovered naturally by normal spending clears zombie pendingDrop,
  // so a subsequent +1.0% jump is cleanly recognized as a real lease
  const key5h = 'local::u@example.com::Gemini::5h';
  let t5 = T0;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 20.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.0,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 19.95,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.05,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 20.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.1,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  const rNewLease = tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 21.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.1,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  assert.equal(rNewLease.reservedPct, 1.0, 'real +1.0% lease not swallowed by cleared pendingDrop');
  assert.equal(rNewLease.reservedLeaseCount, 1);
});

test('experimentalQuotaReservation setting defaults true and round-trips through schema & backup', () => {
  const def = normalizeFullSettings({});
  assert.equal(def.experimentalQuotaReservation, true);

  const disabled = normalizeFullSettings({ experimentalQuotaReservation: false });
  assert.equal(disabled.experimentalQuotaReservation, false);

  const enabled = normalizeFullSettings({ experimentalQuotaReservation: true });
  assert.equal(enabled.experimentalQuotaReservation, true);

  const json = buildExportableSettingsJson(enabled);
  const parsed = parseImportedSettingsJson(json);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patch.experimentalQuotaReservation, true);

  const disabledJson = buildExportableSettingsJson(disabled);
  const disabledParsed = parseImportedSettingsJson(disabledJson);
  assert.equal(disabledParsed.ok, true);
  assert.equal(disabledParsed.patch.experimentalQuotaReservation, false);
});

test('backendHarness buildTelemetry populates reservedPct on pools across official quota jumps', async () => {
  let now = T0;
  const h = backendHarness({
    clock: () => now,
    userStatus: { email: 'tester@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.96,
              resetTime: new Date(RESET_5H).toISOString(),
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: new Date(RESET_WK).toISOString(),
            },
          ],
        },
      ],
    },
  });

  const p1 = await h.buildTelemetryPayloadInternal(null, true);
  const g1 = p1.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(p1.settings.experimentalQuotaReservation, true);
  assert.equal(g1.reservedPct, 0);
  assert.equal(g1.weeklyReservedPct, 0);

  // Advance clock beyond quota cache TTL and simulate a +1.0% 5h lease jump with no local cost change
  now += 20_000;
  h.state.quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.95,
            resetTime: new Date(RESET_5H).toISOString(),
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.845,
            resetTime: new Date(RESET_WK).toISOString(),
          },
        ],
      },
    ],
  };

  const p2 = await h.buildTelemetryPayloadInternal(null, true);
  const g2 = p2.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(g2.reservedPct, 1.0);
  assert.equal(g2.weeklyReservedPct, 0.5);

  const logRes = await h.dispatchBridgeApiRequest('/api/quota-reservation/log', 'GET');
  assert.equal(logRes.status, 200);
  const logJson = JSON.parse(logRes.body);
  assert.equal(logJson.ok, true);
  assert.ok(logJson.count >= 4, 'baseline + lease events recorded in ring buffer');
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === '5h' && e.event === 'lease'),
    '5h lease jump logged'
  );
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === 'weekly' && e.event === 'lease'),
    'weekly lease jump logged'
  );
});

test('QuotaPoolsWidget & SettingsOtherTab render experimental reservation bar/text and toggle', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const origNavigator = globalThis.navigator;
  let copiedClipboardText = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          copiedClipboardText = String(text);
        },
      },
    },
  });
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };
  const savedPatches = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/quota-reservation/log')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          generatedAt: '2026-11-22T09:20:00.000Z',
          count: 1,
          buckets: [{ pool: 'Gemini', win: '5h', usedPct: 4.1, reservedPct: 1, leases: 1 }],
          events: [
            {
              ts: '2026-11-22T09:19:50.000Z',
              pool: 'Gemini',
              win: '5h',
              event: 'lease',
              usedPct: 4.1,
              dUsed: 1,
              rsvPct: 1,
              leases: 1,
            },
          ],
        }),
      };
    }
    if (String(url).includes('/api/settings') && opts.method === 'POST') {
      const patch = JSON.parse(opts.body);
      savedPatches.push(patch);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, settings: patch }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }, { SettingsOtherTab }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
      import('../src/views/settings/SettingsOtherTab.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const baseData = {
      settings: { experimentalQuotaReservation: false },
      account: { tierName: 'Google AI Ultra', planName: 'Pro' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 4.1,
            remainingPct: 95.9,
            reservedPct: 1.0,
            reservedLeaseCount: 1,
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            weeklyUsedPct: 16.2,
            weeklyRemainingPct: 83.8,
            weeklyReservedPct: 0.5,
            weeklyReservedLeaseCount: 1,
            weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
          },
        ],
        weekly: { isOfficial: true },
      },
    };

    // Default (omitted setting): enabled by default
    widget.refs.update({
      data: { ...baseData, settings: {} },
      minuteTick: 1,
    });
    const legendEl = widget.el.querySelector('.quota-reserve-legend');
    assert.ok(legendEl, 'quota reservation legend mounted');
    assert.equal(legendEl.hidden, false);

    // Toggle OFF: no reserved highlight, legend hidden, compact reset + used text only
    widget.refs.update({ data: baseData, minuteTick: 1 });
    assert.equal(legendEl.hidden, true);
    const metasOff = widget.el.querySelectorAll('.quota-win-meta');
    assert.equal(metasOff.length, 2);
    assert.match(metasOff[0].textContent, /· 已用 4\.1%$/);
    assert.doesNotMatch(metasOff[0].textContent, /[()（）]|预占|余/);
    assert.match(metasOff[1].textContent, /· 已用 16\.2%$/);
    assert.doesNotMatch(metasOff[1].textContent, /[()（）]|预占|余/);
    const fillBarsOff = widget.el.querySelectorAll('.progress-fill');
    assert.equal(fillBarsOff[0].style.getPropertyValue('--fill-w'), '4.1%');

    // Toggle ON: violet reserved bar segment + hover tooltip + bottom solid/dashed legend, without parenthetical inline text
    widget.refs.update({
      data: { ...baseData, settings: { experimentalQuotaReservation: true } },
      minuteTick: 1,
    });
    assert.equal(legendEl.hidden, false);
    assert.ok(legendEl.querySelector('.quota-legend-line.is-actual'));
    assert.ok(legendEl.querySelector('.quota-legend-line.is-reserved'));
    assert.match(legendEl.textContent, /实占/);
    assert.match(legendEl.textContent, /预占/);
    const metasOn = widget.el.querySelectorAll('.quota-win-meta');
    assert.match(metasOn[0].textContent, /· 已用 4\.1%$/);
    assert.doesNotMatch(metasOn[0].textContent, /[()（）]|预占|余/);
    assert.match(metasOn[0].getAttribute('title') || '', /1\.0%/);
    assert.match(metasOn[1].textContent, /· 已用 16\.2%$/);
    assert.doesNotMatch(metasOn[1].textContent, /[()（）]|预占|余/);
    assert.match(metasOn[1].getAttribute('title') || '', /0\.5%/);

    const fillBarsOn = widget.el.querySelectorAll('.progress-fill');
    const rsvBarsOn = widget.el.querySelectorAll('.progress-fill-reserved');
    assert.equal(fillBarsOn[0].style.getPropertyValue('--fill-w'), '3.1%');
    assert.equal(rsvBarsOn[0].style.getPropertyValue('--reserved-w'), '1%');
    assert.equal(rsvBarsOn[0].classList.contains('is-active'), true);
    assert.equal(rsvBarsOn[0].classList.contains('has-sep'), true);
    assert.equal(fillBarsOn[1].style.getPropertyValue('--fill-w'), '15.7%');
    assert.equal(rsvBarsOn[1].style.getPropertyValue('--reserved-w'), '0.5%');
    assert.equal(rsvBarsOn[1].classList.contains('has-sep'), true);

    // SettingsOtherTab renders experimental badge and persists toggle click
    const othTab = SettingsOtherTab({ onLayoutChange: () => {} });
    othTab.refs.renderSettings({ experimentalQuotaReservation: false }, []);
    const badge = othTab.el.querySelector('.settings-experimental-badge');
    assert.ok(badge, 'experimental badge rendered');
    assert.equal(badge.textContent, '试验性');

    const toggleBtns = othTab.refs.quotaReserveToggle.el.querySelectorAll('.seg-btn');
    assert.equal(toggleBtns.length, 2);
    toggleBtns[0].dispatchEvent({
      type: 'click',
      stopPropagation() {},
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
      savedPatches.some((p) => p.experimentalQuotaReservation === true),
      true,
      'clicking 开启 saves experimentalQuotaReservation: true'
    );

    othTab.refs.exportReserveLogBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 25));
    const copiedObj = JSON.parse(copiedClipboardText);
    assert.equal(copiedObj.count, 1);
    assert.equal(copiedObj.events[0].event, 'lease');
    assert.equal(copiedObj.events[0].pool, 'Gemini');

    othTab.destroy();
    widget.destroy();
  } finally {
    globalThis.fetch = origFetch;
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNavigator,
    });
  }
});

test('quota-reservation: learns per-model burn rates & 3x/1x multipliers with strict account isolation and persistence', () => {
  let storedPayload = null;
  const tracker = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });

  const makePools = (used5h, usedWk) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - used5h / 100,
          usedPct: used5h,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyRemainingFraction: 1 - usedWk / 100,
          weeklyUsedPct: usedWk,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);

  const makeStats = (cost5h, costWk, modelCosts5h, modelCostsWeekly, ts) =>
    new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: cost5h, unpricedCalls: 0 },
          cycleWeekly: { costUsd: costWk, unpricedCalls: 0 },
          exactCost5hUsd: cost5h,
          exactCostWeeklyUsd: costWk,
          modelCosts5h,
          modelCostsWeekly,
          recent10m: { lastActivityMs: ts, activeSessionCount: 1, costUsd: 0.1 },
        },
      ],
    ]);

  let ts = T0;
  let u5 = 10.0;
  let uw = 20.0;
  let carbonCost = 1.0;
  let neonCost = 0.0;

  // Baseline for Account A
  const p0 = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: p0,
    poolCycleStats: makeStats(
      carbonCost,
      carbonCost,
      { 'Gemini 4 Carbon': carbonCost },
      { 'Gemini 4 Carbon': carbonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(p0.get('Gemini').rateEstimate, null);

  // 3 clean single-model steps on Carbon: 2.0 %/$ (5h), 0.5 %/$ (weekly)
  let latestPool = null;
  for (let i = 0; i < 3; i += 1) {
    ts += 15_000;
    carbonCost = +(carbonCost + 0.1).toFixed(6);
    u5 = +(u5 + 0.2).toFixed(6);
    uw = +(uw + 0.05).toFixed(6);
    latestPool = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'alice@example.com',
      quotaPoolsMap: latestPool,
      poolCycleStats: makeStats(
        carbonCost,
        carbonCost,
        { 'Gemini 4 Carbon': carbonCost },
        { 'Gemini 4 Carbon': carbonCost },
        ts
      ),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }

  const estCarbonOnly = latestPool.get('Gemini').rateEstimate;
  assert.ok(estCarbonOnly, 'rateEstimate appears once 3 clean single-model steps are recorded');
  assert.equal(estCarbonOnly.models.length, 1);
  assert.equal(estCarbonOnly.models[0].model, 'Gemini 4 Carbon');
  assert.equal(estCarbonOnly.models[0].rate5hPctPerUsd, 2);
  assert.equal(estCarbonOnly.models[0].rateWeeklyPctPerUsd, 0.5);
  assert.equal(estCarbonOnly.models[0].eqFull5hUsd, 50);
  assert.equal(estCarbonOnly.models[0].eqFullWeeklyUsd, 200);
  assert.equal(estCarbonOnly.models[0].multiplier, null, 'single model does not emit relative multiplier');
  assert.equal(estCarbonOnly.models[0].samples, 3);

  // 3 clean single-model steps on Neon: 0.6667 %/$ (5h), 0.1667 %/$ (weekly) -> 1:3 relative ratio
  for (let i = 0; i < 3; i += 1) {
    ts += 15_000;
    neonCost = +(neonCost + 0.15).toFixed(6);
    u5 = +(u5 + 0.1).toFixed(6);
    uw = +(uw + 0.025).toFixed(6);
    latestPool = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'alice@example.com',
      quotaPoolsMap: latestPool,
      poolCycleStats: makeStats(
        carbonCost + neonCost,
        carbonCost + neonCost,
        { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
        { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
        ts
      ),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }

  const estDual = latestPool.get('Gemini').rateEstimate;
  assert.equal(estDual.models.length, 2);
  assert.equal(estDual.models[0].model, 'Gemini 4 Carbon');
  assert.equal(estDual.models[0].multiplier, 3);
  assert.equal(estDual.models[0].eqFull5hUsd, 50);
  assert.equal(estDual.models[0].eqFullWeeklyUsd, 200);
  assert.equal(estDual.models[1].model, 'Gemini 4 Neon');
  assert.equal(estDual.models[1].multiplier, 1);
  assert.equal(estDual.models[1].eqFull5hUsd, 150);
  assert.equal(estDual.models[1].eqFullWeeklyUsd, 600);

  // Mixed-model step ($0.10 Carbon + $0.15 Neon -> +0.30% 5h, +0.075% weekly):
  // weighted expected matches official (no false lease) and does not pollute per-model sample counts
  ts += 15_000;
  carbonCost = +(carbonCost + 0.1).toFixed(6);
  neonCost = +(neonCost + 0.15).toFixed(6);
  u5 = +(u5 + 0.3).toFixed(6);
  uw = +(uw + 0.075).toFixed(6);
  const pMixed = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: pMixed,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pMixed.get('Gemini').reservedPct, 0);
  assert.equal(pMixed.get('Gemini').rateEstimate.models[0].samples, 3);
  assert.equal(pMixed.get('Gemini').rateEstimate.models[1].samples, 3);

  // Strict account isolation: Account B sees null (no cross-account leakage);
  // case-insensitive Account A lookup still sees its own calibrated estimates
  ts += 15_000;
  const pBob = makePools(5.0, 10.0);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'bob@example.com',
    quotaPoolsMap: pBob,
    poolCycleStats: makeStats(0.5, 0.5, { 'Gemini 4 Carbon': 0.5 }, { 'Gemini 4 Carbon': 0.5 }, ts),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pBob.get('Gemini').rateEstimate, null, 'other account must not inherit Alice rates');

  // Force a persist tick past QR_PERSIST_MIN_INTERVAL_MS and test reload across restart
  ts += 40_000;
  carbonCost = +(carbonCost + 0.1).toFixed(6);
  u5 = +(u5 + 0.2).toFixed(6);
  uw = +(uw + 0.05).toFixed(6);
  const pAliceCase = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'ALICE@EXAMPLE.COM',
    quotaPoolsMap: pAliceCase,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pAliceCase.get('Gemini').rateEstimate.models[0].samples, 4);

  const reloaded = createQuotaReservationTracker({ loadState: () => storedPayload });
  const pReloadAlice = makePools(u5, uw);
  reloaded.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: pReloadAlice,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models.length, 2);
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models[0].multiplier, 3);
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models[1].multiplier, 1);

  const snap = reloaded.getLogSnapshot();
  const alice5h = snap.buckets.find((b) => b.pool === 'Gemini' && b.win === '5h' && b.byModel);
  assert.ok(alice5h?.byModel?.['Gemini 4 Carbon'], 'snapshot exposes per-model summary');
  assert.equal(alice5h.byModel['Gemini 4 Carbon'].eqFullUsd, 50);

  const pReloadBob = makePools(5.0, 10.0);
  reloaded.updatePools({
    endpointId: 'local',
    accountScope: 'bob@example.com',
    quotaPoolsMap: pReloadBob,
    poolCycleStats: makeStats(0.5, 0.5, { 'Gemini 4 Carbon': 0.5 }, { 'Gemini 4 Carbon': 0.5 }, ts),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pReloadBob.get('Gemini').rateEstimate, null, 'account isolation preserved after restart');

  // Legacy v2 persisted bucket missing lastModelCostsUsd must not pollute modelRates on first upgrade tick
  const legacyV2 = createQuotaReservationTracker({
    loadState: () => ({
      version: 2,
      savedAt: new Date(T0).toISOString(),
      buckets: {
        'local::legacy@example.com::Gemini::5h': {
          resetTimeMs: RESET_5H,
          lastQuotaTs: T0,
          lastOfficialUsedPct: 12.0,
          lastCycleCostUsd: 18.0,
          ratePctPerUsd: 0.6667,
          rateSamples: 10,
          rateWindow: [0.6667, 0.6667, 0.6667],
          activeLeases: [],
        },
      },
      events: [],
    }),
  });
  const tUp = T0 + 15_000;
  const pUp = makePools(12.2, 20.0);
  legacyV2.updatePools({
    endpointId: 'local',
    accountScope: 'legacy@example.com',
    quotaPoolsMap: pUp,
    poolCycleStats: makeStats(18.1, 18.1, { 'Gemini 4 Carbon': 18.1 }, { 'Gemini 4 Carbon': 18.1 }, tUp),
    quotaFetchedAtMs: tUp,
    nowMs: tUp,
  });
  const legacySt = legacyV2._buckets.get('local::legacy@example.com::Gemini::5h');
  assert.deepEqual(legacySt.modelRates, {}, 'first upgrade tick backfills baseline without recording polluted cumulative delta');
  assert.equal(legacySt.lastModelCostsUsd['Gemini 4 Carbon'], 18.1);
});

test('QuotaPoolsWidget renders circle-? hover popover for account-isolated model burn rates', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget, maskAccountLabel }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);
    setI18nLanguage('zh-CN');

    // Account privacy masking
    assert.equal(maskAccountLabel('sjee80343@gmail.com'), 'sj***43@gmail.com');
    assert.equal(maskAccountLabel('alice@example.com'), 'al***ce@example.com');
    assert.equal(maskAccountLabel('bob@example.com'), 'b***b@example.com');
    assert.equal(maskAccountLabel('ab@example.com'), 'a*@example.com');
    assert.equal(maskAccountLabel('Tester'), 'Te***r');
    assert.equal(maskAccountLabel(''), '');

    const widget = QuotaPoolsWidget();
    const helpBtn = widget.refs.rateHelpBtn;
    const popover = widget.refs.ratePopoverEl;
    assert.ok(helpBtn, 'circle-? help button mounted');
    assert.ok(popover, 'rate popover mounted');
    assert.equal(popover.hidden, true);
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'false');

    // Hover opens empty collecting hint before samples accumulate
    helpBtn.dispatchEvent({ type: 'mouseenter' });
    assert.equal(popover.hidden, false);
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'true');
    assert.match(popover.textContent, /暂未采集到足够的单模型干净样本/);

    // Populated multi-model rateEstimate for current account
    const dualData = {
      account: { email: 'sjee80343@gmail.com', tierName: 'Google AI Ultra', tierMultiplier: '5x' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 30,
            remainingPct: 70,
            weeklyUsedPct: 37,
            weeklyRemainingPct: 63,
            rateEstimate: {
              rate5hPctPerUsd: 2,
              rateWeeklyPctPerUsd: 0.5,
              eqFull5hUsd: 50,
              eqFullWeeklyUsd: 200,
              samples5h: 26,
              samplesWeekly: 32,
              models: [
                {
                  model: 'Gemini 4 Carbon',
                  rate5hPctPerUsd: 2,
                  rateWeeklyPctPerUsd: 0.5,
                  eqFull5hUsd: 50,
                  eqFullWeeklyUsd: 200,
                  multiplier: 3,
                  samples: 26,
                },
                {
                  model: 'Gemini 4 Neon',
                  rate5hPctPerUsd: 0.6667,
                  rateWeeklyPctPerUsd: 0.1667,
                  eqFull5hUsd: 150,
                  eqFullWeeklyUsd: 600,
                  multiplier: 1,
                  samples: 12,
                },
              ],
            },
          },
        ],
        weekly: { isOfficial: true },
      },
    };
    widget.refs.update({ data: dualData, minuteTick: 1 });
    const acctPill = popover.querySelector('.quota-rate-pop-account');
    assert.equal(acctPill.textContent, 'sj***43@gmail.com');
    assert.equal(acctPill.getAttribute('title'), 'sj***43@gmail.com');
    assert.equal(popover.textContent.includes('sjee80343'), false, 'raw email never leaks in popover');
    const rows = popover.querySelectorAll('.quota-rate-model-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Gemini 4 Carbon/);
    assert.match(rows[0].textContent, /3x/);
    assert.match(rows[0].textContent, /5h 满池≈ \$50/);
    assert.match(rows[0].textContent, /周限满池≈ \$200/);
    assert.match(rows[0].textContent, /5h 2%\/\$ · 26 样本/);
    assert.equal(rows[0].querySelector('.quota-rate-mult-badge').classList.contains('is-high'), true);
    assert.equal(rows[0].querySelector('.quota-rate-eq-grid').classList.contains('is-single'), false);

    assert.match(rows[1].textContent, /Gemini 4 Neon/);
    assert.match(rows[1].textContent, /1x/);
    assert.match(rows[1].textContent, /5h 满池≈ \$150/);
    assert.match(rows[1].textContent, /周限满池≈ \$600/);
    assert.match(rows[1].textContent, /5h 0\.67%\/\$ · 12 样本/);
    assert.equal(rows[1].querySelector('.quota-rate-mult-badge').classList.contains('is-high'), false);

    // Switching to another account with pool-average-only fallback refreshes popover cleanly
    widget.refs.update({
      data: {
        account: { email: 'bob@example.com', tierName: 'Google AI Pro' },
        quotas: {
          pools: [
            {
              poolKey: 'Argon',
              poolLabel: 'Gemini 4 Argon',
              family: 'Argon',
              weeklyUsedPct: 40,
              weeklyRemainingPct: 60,
              rateEstimate: {
                rate5hPctPerUsd: null,
                rateWeeklyPctPerUsd: 0.5,
                eqFull5hUsd: null,
                eqFullWeeklyUsd: 200,
                samples5h: 0,
                samplesWeekly: 8,
                models: [],
              },
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 2,
    });
    assert.equal(acctPill.textContent, 'b***b@example.com');
    const fallbackRow = popover.querySelector('.quota-rate-model-row.is-fallback');
    assert.ok(fallbackRow, 'renders pool-average fallback before per-model reaches 3 samples');
    assert.match(fallbackRow.textContent, /池综合均值/);
    assert.match(fallbackRow.textContent, /周限满池≈ \$200/);
    assert.match(fallbackRow.textContent, /周限 0\.5%\/\$ · 8 样本/);
    assert.equal(fallbackRow.querySelector('.quota-rate-eq-grid').classList.contains('is-single'), true);

    // Locale switch renders English copy
    setI18nLanguage('en-US');
    widget.refs.update({ data: dualData, minuteTick: 3 });
    assert.match(popover.textContent, /Estimated Burn Rates/);
    assert.equal(acctPill.textContent, 'sj***43@gmail.com');
    assert.match(popover.textContent, /5h full≈ \$50/);
    assert.match(popover.textContent, /Weekly full≈ \$200/);

    // Escape closes popover; click toggles open/close; mouseleave closes after grace delay
    helpBtn.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation() {} });
    assert.equal(popover.hidden, true);
    helpBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(popover.hidden, false);
    helpBtn.dispatchEvent({ type: 'mouseleave' });
    popover.dispatchEvent({ type: 'mouseenter' });
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(popover.hidden, false, 'moving pointer into popover cancels close');
    popover.dispatchEvent({ type: 'mouseleave' });
    await new Promise((r) => setTimeout(r, 170));
    assert.equal(popover.hidden, true, 'leaving popover closes after grace delay');

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

test('QuotaPoolsWidget supports quotaDisplayMode="remaining" for both percentage text and progress bar fill', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const baseData = {
      settings: {
        experimentalQuotaReservation: false,
        quotaDisplayMode: 'remaining',
      },
      account: { tierName: 'Google AI Pro' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 4.1,
            remainingPct: 95.9,
            reservedPct: 1.0,
            reservedLeaseCount: 1,
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            weeklyUsedPct: 86.0,
            weeklyRemainingPct: 14.0,
            weeklyReservedPct: 0.5,
            weeklyReservedLeaseCount: 1,
            weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
          },
        ],
        weekly: { isOfficial: true },
      },
    };

    widget.refs.update({ data: baseData, minuteTick: 1 });
    const metas = widget.el.querySelectorAll('.quota-win-meta');
    assert.equal(metas.length, 2);
    assert.match(metas[0].textContent, /· 剩余 95\.9%$/);
    assert.match(metas[1].textContent, /· 剩余 14\.0%$/);

    const fills = widget.el.querySelectorAll('.progress-fill');
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '95.9%');
    assert.equal(fills[0].classList.contains('tone-warn'), false);
    assert.equal(fills[0].classList.contains('tone-danger'), false);
    assert.equal(fills[1].style.getPropertyValue('--fill-w'), '14%');
    assert.equal(fills[1].classList.contains('tone-danger'), true);

    // With reservation enabled, legend switches to 剩余 and reserved segment is clamped cleanly
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'remaining' },
      },
      minuteTick: 2,
    });
    const legendEl = widget.el.querySelector('.quota-reserve-legend');
    assert.equal(legendEl.hidden, false);
    assert.match(legendEl.textContent, /剩余/);
    assert.match(legendEl.textContent, /预占/);
    const rsvBars = widget.el.querySelectorAll('.progress-fill-reserved');
    assert.equal(rsvBars[0].style.getPropertyValue('--reserved-w'), '1%');
    assert.equal(rsvBars[0].classList.contains('is-active'), true);

    // English locale
    setI18nLanguage('en-US');
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'remaining' },
      },
      minuteTick: 3,
    });
    const metasEn = widget.el.querySelectorAll('.quota-win-meta');
    assert.match(metasEn[0].textContent, /· Left 95\.9%$/);
    assert.match(legendEl.textContent, /Remaining/);

    // Switching back to 'used' restores Used % and used-width bar
    setI18nLanguage('zh-CN');
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: false, quotaDisplayMode: 'used' },
      },
      minuteTick: 4,
    });
    const metasUsed = widget.el.querySelectorAll('.quota-win-meta');
    assert.match(metasUsed[0].textContent, /· 已用 4\.1%$/);
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '4.1%');

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

