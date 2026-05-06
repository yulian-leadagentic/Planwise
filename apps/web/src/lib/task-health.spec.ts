import { getTaskHealth, aggregateHealth } from './task-health';

describe('getTaskHealth', () => {
  const base = { status: 'in_progress', endDate: null, budgetHours: 10, loggedMinutes: 300, lastActivityDate: null, completionPct: 0 };

  it('returns ok for completed tasks regardless of other fields', () => {
    const h = getTaskHealth({ ...base, status: 'completed', endDate: '2020-01-01' });
    expect(h.level).toBe('ok');
    expect(h.computedPct).toBe(100);
  });

  it('marks overdue when endDate is in the past', () => {
    const yesterday = new Date(Date.now() - 86400000 * 2).toISOString();
    const h = getTaskHealth({ ...base, endDate: yesterday });
    expect(h.level).toBe('critical');
    expect(h.isOverdue).toBe(true);
    expect(h.reasons.some((r) => r.includes('overdue'))).toBe(true);
  });

  it('warns when due within 3 days and not started', () => {
    const soon = new Date(Date.now() + 86400000 * 2).toISOString();
    const h = getTaskHealth({ ...base, status: 'not_started', endDate: soon, loggedMinutes: 0 });
    expect(h.level).toBe('critical');
    expect(h.reasons.some((r) => r.includes('not started'))).toBe(true);
  });

  it('warns when in progress with no hours logged', () => {
    const h = getTaskHealth({ ...base, loggedMinutes: 0, lastActivityDate: null });
    expect(h.level).toBe('warning');
    expect(h.reasons.some((r) => r.includes('no hours logged'))).toBe(true);
  });

  it('uses actual status name in stale warning (not hardcoded)', () => {
    const h = getTaskHealth({ ...base, status: 'in_review', loggedMinutes: 0, lastActivityDate: null });
    expect(h.reasons.some((r) => r.includes('In Review'))).toBe(true);
  });

  // ─── Status-ceiling completion model ────────────────────────────────────
  // Time reporting → up to 80%. Status = in_review → 90. Status = completed
  // / cancelled → 100. A task can never look "done" until it's actually
  // moved to Done.

  it('caps time-based completion at 80 for in_progress (5h / 10h → 40)', () => {
    const h = getTaskHealth({ ...base, budgetHours: 10, loggedMinutes: 300 }); // 5h / 10h
    expect(h.computedPct).toBe(40); // 50% of 80
    expect(h.loggedHours).toBe(5);
    expect(h.estimatedHours).toBe(10);
  });

  it('caps in_progress completion at 80 even when fully reported', () => {
    const h = getTaskHealth({ ...base, status: 'in_progress', budgetHours: 10, loggedMinutes: 600, lastActivityDate: new Date().toISOString() });
    expect(h.computedPct).toBe(80);
  });

  it('caps in_progress completion at 80 even when over-logged', () => {
    const h = getTaskHealth({ ...base, status: 'in_progress', budgetHours: 5, loggedMinutes: 600 }); // 10h / 5h
    expect(h.computedPct).toBe(80);
  });

  it('pins in_review to 90% regardless of hours', () => {
    const h0 = getTaskHealth({ ...base, status: 'in_review', budgetHours: 10, loggedMinutes: 0, lastActivityDate: new Date().toISOString() });
    expect(h0.computedPct).toBe(90);

    const hFull = getTaskHealth({ ...base, status: 'in_review', budgetHours: 10, loggedMinutes: 600, lastActivityDate: new Date().toISOString() });
    expect(hFull.computedPct).toBe(90);
  });

  it('pins completed to 100% even with no hours logged', () => {
    const h = getTaskHealth({ ...base, status: 'completed', budgetHours: 10, loggedMinutes: 0 });
    expect(h.computedPct).toBe(100);
  });

  it('pins cancelled to 100%', () => {
    const h = getTaskHealth({ ...base, status: 'cancelled', budgetHours: 10, loggedMinutes: 120 });
    expect(h.computedPct).toBe(100);
  });

  it('falls back to completionPct (scaled to 80%) when no budgetHours', () => {
    const h = getTaskHealth({ ...base, budgetHours: null, loggedMinutes: 0, completionPct: 100 });
    expect(h.computedPct).toBe(80); // 100 / 100 * 80
  });

  it('warns when over budget', () => {
    const h = getTaskHealth({ ...base, budgetHours: 10, loggedMinutes: 720 }); // 12h / 10h
    expect(h.reasons.some((r) => r.includes('Over budget'))).toBe(true);
  });

  it('escalates to critical when severely over budget (≥50%)', () => {
    const h = getTaskHealth({ ...base, budgetHours: 10, loggedMinutes: 960 }); // 16h / 10h = 60% over
    expect(h.level).toBe('critical');
  });

  it('warns when hours complete but status still in_progress', () => {
    const h = getTaskHealth({ ...base, budgetHours: 10, loggedMinutes: 600, lastActivityDate: new Date().toISOString() });
    expect(h.reasons.some((r) => r.includes('Hours complete'))).toBe(true);
  });

  it('detects stale task (no activity for 5+ days)', () => {
    const oldDate = new Date(Date.now() - 86400000 * 7).toISOString();
    const h = getTaskHealth({ ...base, lastActivityDate: oldDate, loggedMinutes: 60 });
    expect(h.isStale).toBe(true);
    expect(h.reasons.some((r) => r.includes('No activity'))).toBe(true);
  });
});

describe('aggregateHealth', () => {
  it('counts levels correctly', () => {
    const items = [
      getTaskHealth({ status: 'in_progress', loggedMinutes: 0, lastActivityDate: null }),     // warning
      getTaskHealth({ status: 'completed' }),                                                    // ok
      getTaskHealth({ status: 'not_started', endDate: new Date(Date.now() - 86400000).toISOString() }), // critical
    ];
    const agg = aggregateHealth(items);
    expect(agg.critical).toBe(1);
    expect(agg.warning).toBe(1);
    expect(agg.ok).toBe(1);
  });
});
