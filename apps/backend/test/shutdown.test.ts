import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installShutdownHandlers } from "../src/util/shutdown";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(close: () => Promise<void>, ceilingMs = 1_000) {
  const target = new EventEmitter();
  const exits: number[] = [];
  const remove = installShutdownHandlers({
    close,
    ceilingMs,
    target,
    exit: (code) => {
      exits.push(code);
    }
  });
  return { target, exits, remove };
}

describe("installShutdownHandlers", () => {
  it("closes the server and exits 0 once the close has finished", async () => {
    let closed = 0;
    const { target, exits } = harness(async () => {
      await delay(20);
      closed += 1;
    });

    target.emit("SIGINT", "SIGINT");
    expect(exits).toEqual([]);
    await delay(60);

    expect(closed).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("exits inside the ceiling when the close hangs", async () => {
    let released!: () => void;
    const hang = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { target, exits } = harness(() => hang, 40);

    target.emit("SIGTERM", "SIGTERM");
    await delay(20);
    expect(exits).toEqual([]);
    await delay(60);

    expect(exits).toEqual([0]);
    // The close eventually finishing must not exit a second time.
    released();
    await delay(10);
    expect(exits).toEqual([0]);
  });

  it("exits at once on a second signal during the close", async () => {
    let released!: () => void;
    const hang = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { target, exits } = harness(() => hang, 1_000);

    target.emit("SIGINT", "SIGINT");
    await delay(10);
    expect(exits).toEqual([]);
    target.emit("SIGINT", "SIGINT");

    expect(exits).toEqual([0]);
    released();
    await delay(10);
    expect(exits).toEqual([0]);
  });

  it("still exits 0 when the close rejects, and can be uninstalled", async () => {
    const { target, exits, remove } = harness(async () => {
      throw new Error("hook failed");
    });

    target.emit("SIGTERM", "SIGTERM");
    await delay(10);
    expect(exits).toEqual([0]);

    remove();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
