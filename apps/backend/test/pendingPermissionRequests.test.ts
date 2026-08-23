import { describe, expect, it } from "vitest";
import { PendingPermissionRequests } from "../src/runner/shared/PendingPermissionRequests";

const options = [
  { optionId: "allow-1", kind: "allow_once", name: "Allow" },
  { optionId: "reject-1", kind: "reject_once", name: "Reject" }
];

describe("pending permission requests", () => {
  it("settles with the option a human selected", async () => {
    const pending = new PendingPermissionRequests({ timeoutMs: 5_000 });
    const wait = pending.wait({ sessionKey: "s1", requestId: "r1", options })!;

    expect(pending.answer("s1", "r1", "allow-1")).toBe("answered");
    await expect(wait).resolves.toEqual({ decidedBy: "human", optionId: "allow-1" });
    // The request is gone with its answer; a second one has nothing to reach.
    expect(pending.pendingCount("s1")).toBe(0);
    expect(pending.answer("s1", "r1", "allow-1")).toBe("unknown_request");
  });

  it("refuses an option the agent did not offer", async () => {
    const pending = new PendingPermissionRequests({ timeoutMs: 5_000 });
    const wait = pending.wait({ sessionKey: "s1", requestId: "r1", options })!;

    // The agent decides what it is willing to be told. Inventing a value it
    // never supplied is the one thing this channel must never do.
    expect(pending.answer("s1", "r1", "allow_always")).toBe("unknown_option");
    expect(pending.pendingCount("s1")).toBe(1);

    pending.releaseSession("s1");
    await expect(wait).resolves.toEqual({ decidedBy: "timeout" });
  });

  it("does not let one session answer another's request", async () => {
    const pending = new PendingPermissionRequests({ timeoutMs: 5_000 });
    const wait = pending.wait({ sessionKey: "s1", requestId: "r1", options })!;

    expect(pending.answer("s2", "r1", "allow-1")).toBe("unknown_request");
    pending.releaseAll();
    await expect(wait).resolves.toEqual({ decidedBy: "timeout" });
  });

  it("refuses to advertise a wait once a session is full", async () => {
    // The cap is what keeps a looping or hostile agent from growing this map:
    // past it a request is answered as the configured policy would, not queued.
    const pending = new PendingPermissionRequests({ timeoutMs: 5_000, maxPerSession: 2 });
    const held = [
      pending.wait({ sessionKey: "s1", requestId: "r1", options })!,
      pending.wait({ sessionKey: "s1", requestId: "r2", options })!
    ];

    expect(pending.wait({ sessionKey: "s1", requestId: "r3", options })).toBeUndefined();
    expect(pending.pendingCount("s1")).toBe(2);

    pending.releaseSession("s1");
    await Promise.all(held);
  });

  it("refuses to advertise an empty answer vocabulary", () => {
    const pending = new PendingPermissionRequests({ timeoutMs: 5_000 });

    expect(pending.wait({ sessionKey: "s1", requestId: "r1", options: [] })).toBeUndefined();
    expect(pending.pendingCount("s1")).toBe(0);
  });

  it("times out into the caller's fallback rather than waiting forever", async () => {
    // A turn that blocks forever on an absent operator is a worse failure than
    // a refusal, so every wait has a clock behind it.
    const pending = new PendingPermissionRequests({ timeoutMs: 20 });
    await expect(pending.wait({ sessionKey: "s1", requestId: "r1", options })!)
      .resolves.toEqual({ decidedBy: "timeout" });
    expect(pending.pendingCount("s1")).toBe(0);
  });
});
