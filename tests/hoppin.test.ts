import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDoneWhen } from "../src/agent.js";
import { BrowserSession, saveStorageState } from "../src/browser.js";
import { fileArgs, flag } from "../src/cli.js";
import { defaultConfig } from "../src/config.js";
import { guideGoal } from "../src/policy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hoppin flags", () => {
  it("reads --storage-state and --done-when for auto", () => {
    const argv = ["auto", "--url", "https://x.test", "--goal", "g", "--storage-state", "auth.json", "--done-when", "Dashboard is visible"];
    expect(flag(argv, "--storage-state")).toBe("auth.json");
    expect(flag(argv, "--done-when")).toBe("Dashboard is visible");
    expect(flag(["auto", "--done-when=Tap list shows 3 beers"], "--done-when")).toBe("Tap list shows 3 beers");
    expect(flag(["auto", "--url", "u"], "--storage-state")).toBeUndefined();
  });

  it("treats --save-storage-state as a value flag for run", () => {
    const argv = ["run", "--save-storage-state", "state/auth.json", "cases/login.yaml"];
    expect(flag(argv, "--save-storage-state")).toBe("state/auth.json");
    expect(fileArgs(argv, "run")).toEqual(["cases/login.yaml"]);
    expect(fileArgs(["run", "--save-storage-state=out.json", "a.yaml"], "run")).toEqual(["a.yaml"]);
  });
});

describe("done-when override", () => {
  it("replaces a planned done condition and keeps the steps", () => {
    const plan = withDoneWhen({ steps: ["open", "submit"], doneWhen: "model guess", model: "m" }, "Saved toast is visible");
    expect(plan).toEqual({ steps: ["open", "submit"], doneWhen: "Saved toast is visible", model: "m" });
  });

  it("creates a step-less plan when planning was skipped", () => {
    expect(withDoneWhen(undefined, "Saved toast is visible")).toEqual({ steps: [], doneWhen: "Saved toast is visible" });
    expect(withDoneWhen(undefined, undefined)).toBeUndefined();
  });

  it("puts the condition in the guided goal", () => {
    const text = guideGoal("Add a beer", withDoneWhen(undefined, "Saved toast is visible"));
    expect(text).toContain("Done only when this is visibly true: Saved toast is visible");
    expect(text).not.toContain("Planned steps:");
    expect(guideGoal("g", { steps: ["a", "b"], doneWhen: "d" })).toContain("Planned steps:\n1. a\n2. b");
  });
});

describe("save storage state", () => {
  it("writes through the active context and creates parent directories", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new BrowserSession(defaultConfig());
    const storageState = vi.fn(async () => ({ cookies: [], origins: [] }));
    (session as unknown as { context: unknown }).context = { storageState };
    const dir = mkdtempSync(path.join(tmpdir(), "jev-state-"));
    const file = path.join(dir, "nested", "deeper", "auth.json");
    await expect(saveStorageState(session, file)).resolves.toBe(true);
    expect(storageState).toHaveBeenCalledWith({ path: file });
    expect(existsSync(path.dirname(file))).toBe(true);
  });

  it("does not write when no context is open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new BrowserSession(defaultConfig());
    const dir = mkdtempSync(path.join(tmpdir(), "jev-state-"));
    const file = path.join(dir, "nested", "auth.json");
    await expect(saveStorageState(session, file)).resolves.toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
  });
});
