import { render } from "ink";
import { describe, expect, test, vi } from "vitest";

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}));

import { INK_RENDER_OPTIONS, renderApp } from "./render-app.js";

describe("renderApp", () => {
  test("disables Ink exitOnCtrlC", () => {
    const onExit = vi.fn();

    renderApp({
      emitter: { on: vi.fn(), off: vi.fn() } as never,
      pipelineOptions: {} as never,
      onExit,
    });

    expect(render).toHaveBeenCalledWith(expect.anything(), INK_RENDER_OPTIONS);
    expect(INK_RENDER_OPTIONS).toEqual({ exitOnCtrlC: false });
  });
});
