import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PARENT_EXIT_POLL_MS,
  startParentExitWatchdog
} from "../src/util/parentExitWatchdog";

describe("parentExitWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the parent pid changes", () => {
    let parentPid = 4242;
    const onOrphaned = vi.fn();

    startParentExitWatchdog({
      parentPid: 4242,
      intervalMs: 100,
      readParentPid: () => parentPid,
      onOrphaned
    });

    vi.advanceTimersByTime(500);
    expect(onOrphaned).not.toHaveBeenCalled();

    // Reparented to launchd, which is what a child sees when its launcher dies.
    parentPid = 1;
    vi.advanceTimersByTime(100);
    expect(onOrphaned).toHaveBeenCalledTimes(1);

    // The timer is cleared on the first observation, so a still-orphaned
    // process is never told twice.
    vi.advanceTimersByTime(1_000);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("does not arm when the process is already parented to the reaper", () => {
    const onOrphaned = vi.fn();

    // A pid that starts at 1 can never observe it change, so a timer here would
    // poll forever and report nothing.
    expect(
      startParentExitWatchdog({
        parentPid: 1,
        intervalMs: 100,
        readParentPid: () => 1,
        onOrphaned
      })
    ).toBeUndefined();

    vi.advanceTimersByTime(1_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("fires immediately when the launcher died before the watchdog was armed", () => {
    const onOrphaned = vi.fn();

    const stop = startParentExitWatchdog({
      parentPid: 4242,
      intervalMs: 100,
      readParentPid: () => 1,
      onOrphaned
    });

    expect(stop).toBeDefined();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("stops watching when the returned stop function is called", () => {
    let parentPid = 4242;
    const onOrphaned = vi.fn();

    const stop = startParentExitWatchdog({
      parentPid: 4242,
      intervalMs: 100,
      readParentPid: () => parentPid,
      onOrphaned
    });
    expect(stop).toBeDefined();
    stop?.();

    parentPid = 1;
    vi.advanceTimersByTime(1_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("polls on a bounded default interval", () => {
    let parentPid = 4242;
    const onOrphaned = vi.fn();

    startParentExitWatchdog({
      parentPid: 4242,
      readParentPid: () => parentPid,
      onOrphaned
    });

    parentPid = 1;
    vi.advanceTimersByTime(DEFAULT_PARENT_EXIT_POLL_MS - 1);
    expect(onOrphaned).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });
});
