import { describe, expect, it, vi } from "vitest";
import { BrowserContext } from "../understudy/context.ts";
import { FrameRegistry } from "../understudy/frameRegistry.ts";
import { Page } from "../understudy/page.ts";
import type { CdpConnection } from "../understudy/cdp.ts";

function createContext() {
  const listeners = new Map<string, (event: { frameId: string; reason?: string }) => void>();
  const session = {
    on: vi.fn((event: string, listener: (event: { frameId: string; reason?: string }) => void) => {
      listeners.set(event, listener);
    }),
  };
  const connection = {
    getSession: vi.fn(() => session),
    close: vi.fn(async () => {}),
  };
  const context = new BrowserContext(
    connection as unknown as CdpConnection,
    {} as never,
    {} as never,
  );
  return { context, connection, listeners };
}

function createPage(targetId: string) {
  const registry = new FrameRegistry(targetId, `${targetId}-root`);
  registry.onFrameAttached(`${targetId}-child`, `${targetId}-root`, "main");
  registry.onFrameAttached(`${targetId}-grandchild`, `${targetId}-child`, "child");
  const page = {
    registry,
    mainFrameId: () => registry.mainFrameId(),
    onFrameDetached: vi.fn((frameId: string, reason: string) => {
      registry.onFrameDetached(frameId, reason);
    }),
    dispose: vi.fn(),
  } as unknown as Page;
  return page;
}

describe("nested frame cleanup", () => {
  it("removes all ownership for a closed page and keeps another page intact", () => {
    const { context } = createContext();
    const closed = createPage("closed");
    const open = createPage("open");
    context.pagesByTarget.set("closed", closed);
    context.pagesByTarget.set("open", open);
    context.mainFrameToTarget.set("closed-root", "closed");
    context.mainFrameToTarget.set("open-root", "open");
    for (const id of ["closed-root", "closed-child", "closed-grandchild"]) {
      context.frameOwnerPage.set(id, closed);
    }
    context.frameOwnerPage.set("open-child", open);
    context.sessionOwnerPage.set("closed-session", closed);
    context.sessionOwnerPage.set("open-session", open);
    context.pendingOopifByMainFrame.set("closed-child", "closed-session");
    context.pendingOopifByMainFrame.set("open-child", "open-session");

    context.cleanupByTarget("closed");

    expect([...context.frameOwnerPage.keys()]).toEqual(["open-child"]);
    expect([...context.mainFrameToTarget.keys()]).toEqual(["open-root"]);
    expect([...context.sessionOwnerPage.keys()]).toEqual(["open-session"]);
    expect([...context.pendingOopifByMainFrame.keys()]).toEqual(["open-child"]);
    expect([...context.pagesByTarget.keys()]).toEqual(["open"]);
  });

  it("clears ownership even if page disposal throws", () => {
    const { context } = createContext();
    const page = createPage("closed");
    vi.mocked(page.dispose).mockImplementation(() => {
      throw new Error("dispose failed");
    });
    context.pagesByTarget.set("closed", page);
    context.frameOwnerPage.set("closed-child", page);

    expect(() => context.cleanupByTarget("closed")).toThrow("dispose failed");
    expect(context.frameOwnerPage.size).toBe(0);
    expect(context.pagesByTarget.size).toBe(0);
  });

  it("removes a detached frame subtree but preserves process swaps", () => {
    const { context, listeners } = createContext();
    const page = createPage("page");
    context.frameOwnerPage.set("page-child", page);
    context.frameOwnerPage.set("page-grandchild", page);
    context.pendingOopifByMainFrame.set("page-grandchild", "child-session");
    context.installFrameEventBridges("main", page);
    const detach = listeners.get("Page.frameDetached")!;

    detach({ frameId: "page-child", reason: "swap" });
    expect(context.frameOwnerPage.has("page-grandchild")).toBe(true);

    detach({ frameId: "page-child", reason: "remove" });
    expect(context.frameOwnerPage.has("page-child")).toBe(false);
    expect(context.frameOwnerPage.has("page-grandchild")).toBe(false);
    expect(context.pendingOopifByMainFrame.has("page-grandchild")).toBe(false);
  });

  it("drops cached frames for a detached subtree", () => {
    const registry = new FrameRegistry("page", "root");
    registry.onFrameAttached("child", "root", "main");
    registry.onFrameAttached("grandchild", "child", "child");
    const page = Object.create(Page.prototype) as Page;
    Object.assign(page, {
      registry,
      invalidateWebMCPFrame: vi.fn(),
      frameCache: new Map([
        ["root", {}],
        ["child", {}],
        ["grandchild", {}],
      ]),
    });

    page.onFrameDetached("child", "swap");
    expect([...page.frameCache.keys()]).toEqual(["root", "grandchild"]);

    page.onFrameDetached("child", "remove");

    expect([...page.frameCache.keys()]).toEqual(["root"]);
  });

  it("clears context maps even when connection shutdown fails", async () => {
    const { context, connection } = createContext();
    connection.close.mockRejectedValueOnce(new Error("close failed"));
    context.pagesByTarget.set("page", createPage("page"));
    context.frameOwnerPage.set("child", createPage("page"));

    await expect(context.close()).rejects.toThrow("close failed");
    expect(context.pagesByTarget.size).toBe(0);
    expect(context.frameOwnerPage.size).toBe(0);
  });
});
