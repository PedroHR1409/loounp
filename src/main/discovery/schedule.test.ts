import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_INTERVAL_OPTIONS,
  isDueForAutoDiscovery,
  isValidDiscoveryInterval,
  startDiscoveryScheduler,
} from "./schedule";

describe("isValidDiscoveryInterval", () => {
  it("aceita as opções conhecidas", () => {
    for (const value of DISCOVERY_INTERVAL_OPTIONS)
      expect(isValidDiscoveryInterval(value)).toBe(true);
  });

  it("rejeita valores fora da lista", () => {
    expect(isValidDiscoveryInterval(1)).toBe(false);
    expect(isValidDiscoveryInterval(48)).toBe(false);
    expect(isValidDiscoveryInterval(-6)).toBe(false);
  });
});

describe("isDueForAutoDiscovery", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");

  it("nunca dispara quando desligado, mesmo sem busca anterior", () => {
    expect(isDueForAutoDiscovery(now, null, 0)).toBe(false);
  });

  it("dispara imediatamente quando nunca houve busca", () => {
    expect(isDueForAutoDiscovery(now, null, 6)).toBe(true);
  });

  it("dispara quando a data salva é inválida", () => {
    expect(isDueForAutoDiscovery(now, "not-a-date", 12)).toBe(true);
  });

  it("não dispara antes do intervalo configurado vencer", () => {
    const lastRunAt = new Date("2026-09-24T07:00:00.000Z").toISOString();
    expect(isDueForAutoDiscovery(now, lastRunAt, 6)).toBe(false);
  });

  it("dispara assim que o intervalo configurado vence (AT-001)", () => {
    const lastRunAt = new Date("2026-09-23T23:00:00.000Z").toISOString();
    expect(isDueForAutoDiscovery(now, lastRunAt, 12)).toBe(true);
  });

  it("dispara de novo mesmo com o app aberto por muito mais tempo que o intervalo (AT-004)", () => {
    const lastRunAt = new Date("2026-09-23T00:00:00.000Z").toISOString();
    expect(isDueForAutoDiscovery(now, lastRunAt, 6)).toBe(true);
  });
});

describe("startDiscoveryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("faz uma checagem de catch-up imediata ao iniciar", () => {
    const onDue = vi.fn();
    const scheduler = startDiscoveryScheduler({
      getIntervalHours: () => 6,
      getLastRunAt: () => null,
      onDue,
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    });
    expect(onDue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("não dispara nada quando desligado (AT-003)", () => {
    const onDue = vi.fn();
    const scheduler = startDiscoveryScheduler({
      getIntervalHours: () => 0,
      getLastRunAt: () => null,
      onDue,
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      checkFrequencyMs: 1000,
    });
    vi.advanceTimersByTime(10_000);
    expect(onDue).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("repete a checagem na cadência configurada enquanto o app está aberto", () => {
    const onDue = vi.fn();
    let lastRunAt: string | null = "2026-09-24T06:00:00.000Z";
    let current = new Date("2026-09-24T07:00:00.000Z");
    const scheduler = startDiscoveryScheduler({
      getIntervalHours: () => 6,
      getLastRunAt: () => lastRunAt,
      onDue: () => {
        lastRunAt = current.toISOString();
        onDue();
      },
      now: () => current,
      checkFrequencyMs: 1000,
    });
    expect(onDue).not.toHaveBeenCalled();
    current = new Date("2026-09-24T13:00:01.000Z");
    vi.advanceTimersByTime(1000);
    expect(onDue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("stop() impede novas checagens", () => {
    const onDue = vi.fn();
    const scheduler = startDiscoveryScheduler({
      getIntervalHours: () => 6,
      getLastRunAt: () => null,
      onDue,
      checkFrequencyMs: 1000,
    });
    expect(onDue).toHaveBeenCalledTimes(1);
    scheduler.stop();
    vi.advanceTimersByTime(10_000);
    expect(onDue).toHaveBeenCalledTimes(1);
  });
});
