import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as act from "../src/act.js";
import { Agent, withDoneWhen } from "../src/agent.js";
import { BrowserSession, saveStorageState, settlePage } from "../src/browser.js";
import { fileArgs, flag, main } from "../src/cli.js";
import { defaultConfig } from "../src/config.js";
import * as modelHttp from "../src/model-http.js";
import { guideGoal } from "../src/policy.js";
import { ReportWriter } from "../src/report.js";
import type { PageState } from "../src/types.js";

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

function hoppinPage(url: string, text: string): PageState {
  return {
    url,
    title: "Hoppin",
    text,
    elements: [
      { index: "1", node: 1, role: "button", name: "View Bird In Hand", value: "", operations: ["CLICK"], within: "", nearby: "", options: [] },
    ],
    scroll: {},
    pageKey: url,
    marker: "m",
    guards: {},
    fingerprint: text,
  };
}

describe("settle", () => {
  it("waits for network idle with a timeout, then caps the animation wait", async () => {
    const page = {
      waitForLoadState: vi.fn(async () => {
        throw new Error("Timeout 3000ms exceeded");
      }),
      waitForTimeout: vi.fn(async () => undefined),
    };
    await settlePage(page, 3000);
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 3000 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(1500);
    await settlePage(page, 400);
    expect(page.waitForTimeout).toHaveBeenLastCalledWith(400);
    page.waitForLoadState.mockClear();
    await settlePage(page, 0);
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("settles after open, after an action, and before the done check", async () => {
    const log: string[] = [];
    const before = hoppinPage("https://app.test/map", "Map");
    const after = hoppinPage("https://app.test/map?venue=bird", "Map Bird In Hand on tap");
    let current = before;
    vi.spyOn(act, "execute").mockImplementation(async () => {
      log.push("execute");
      current = after;
    });
    const session = {
      url: before.url,
      lastObserveMs: 1,
      page: null,
      observe: async () => {
        log.push("observe");
        return current;
      },
      settleFor: vi.fn(async (ms: number) => {
        log.push(`settle:${ms}`);
      }),
      title: async () => current.title,
      screenshot: async () => Buffer.from("x"),
    } as unknown as BrowserSession;
    vi.spyOn(Agent.prototype as unknown as { checkDone: () => unknown }, "checkDone").mockImplementation(async () => {
      log.push("check");
      return { met: true };
    });
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "jev-settle-")), "settle", false);
    const agent = new Agent(session, writer, defaultConfig(), {
      script: [{ operation: "CLICK", target: { role: "button", name: "View Bird In Hand" } }, { operation: "DONE" }],
      doneWhen: "Bird In Hand tap list is visible",
      settleMs: 2000,
    });
    const { result } = await agent.run(before.url, "Open Bird In Hand");
    expect(result.status).toBe("pass");
    expect(result.settleMs).toBe(2000);
    expect(log).toEqual([
      "observe",
      "settle:2000",
      "observe",
      "execute",
      "settle:2000",
      "observe",
      "settle:2000",
      "observe",
      "check",
    ]);
    expect(result.steps.find((step) => step.op === "click")?.pageChanged).toBe(true);
  });

  it("does not settle when --settle-ms is not set", async () => {
    const page = hoppinPage("https://app.test/", "Home");
    const settleFor = vi.fn();
    const session = {
      url: page.url,
      lastObserveMs: 1,
      page: null,
      observe: async () => page,
      settleFor,
      title: async () => page.title,
      screenshot: async () => Buffer.from("x"),
    } as unknown as BrowserSession;
    vi.spyOn(Agent.prototype as unknown as { checkDone: () => unknown }, "checkDone").mockResolvedValue({ met: true });
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "jev-settle-")), "settle-off", false);
    const agent = new Agent(session, writer, defaultConfig(), { script: [{ operation: "DONE" }], doneWhen: "Home" });
    const { result } = await agent.run(page.url, "g");
    expect(settleFor).not.toHaveBeenCalled();
    expect(result.settleMs).toBeUndefined();
  });
});

describe("no-plan", () => {
  it("skips the planner and checks done through Jev only", async () => {
    const urls: string[] = [];
    vi.spyOn(modelHttp, "modelFetch").mockImplementation(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ answers: { done: { choice: "met" } }, model: "jev-latest" }), { status: 200 });
    });
    const page = hoppinPage("https://app.test/venue", "Bird In Hand tap list");
    const session = {
      url: page.url,
      lastObserveMs: 1,
      page: null,
      observe: async () => page,
      title: async () => page.title,
      screenshot: async () => Buffer.from("x"),
    } as unknown as BrowserSession;
    const config = defaultConfig();
    config.model.apiKey = "";
    config.model.typesafeApiKey = "ts-test";
    config.model.typesafeBaseUrl = "https://typesafe.test/v1";
    const provider = { choose: vi.fn(async () => ({ operation: "DONE" })) };
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "jev-noplan-")), "noplan", false);
    const agent = new Agent(session, writer, config, { provider, noPlan: true, doneWhen: "Bird In Hand tap list is visible" });
    expect(await agent.plan(page.url, "Open Bird In Hand")).toBeUndefined();
    const { result } = await agent.run(page.url, "Open Bird In Hand");
    expect(result.plan).toEqual({ steps: [], doneWhen: "Bird In Hand tap list is visible" });
    expect(result.status).toBe("pass");
    expect(urls).toEqual(["https://typesafe.test/v1/systemone"]);
    expect(provider.choose.mock.calls[0]?.[1]).toContain("Done only when this is visibly true: Bird In Hand tap list is visible");
  });

  it("exits 2 when --no-plan has no --done-when", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["auto", "--url", "https://app.test", "--goal", "g", "--no-plan"])).toBe(2);
    expect(fileArgs(["run", "--no-plan", "a.yaml"], "run")).toEqual(["a.yaml"]);
  });

  it("reads --settle-ms as a value flag", () => {
    expect(flag(["auto", "--settle-ms", "2500", "--no-plan"], "--settle-ms")).toBe("2500");
  });
});
