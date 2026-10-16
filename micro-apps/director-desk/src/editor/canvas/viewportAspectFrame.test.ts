import { describe, expect, it } from "vitest";
import { fitFrameWithinViewport, getViewportAspectFrameRect } from "./viewportAspectFrame";

describe("fitFrameWithinViewport", () => {
  it.each([16 / 9, 9 / 16])("fits source image ratio %.5f without distorting the frame", (ratio) => {
    const frame = getViewportAspectFrameRect(ratio, 1000, 700, 120, { left: 80, right: 180, top: 0, bottom: 0 });
    expect(frame).not.toBeNull();
    expect(frame!.width / frame!.height).toBeCloseTo(ratio, 6);
    expect(frame!.left).toBeGreaterThanOrEqual(120);
    expect(frame!.left + frame!.width).toBeLessThanOrEqual(780.001);
  });

  it("keeps framed aspect layouts inside the visible safe area between overlay side panels", () => {
    const frame = fitFrameWithinViewport(1000, 700, 16 / 9, 126, {
      left: 220,
      right: 300,
      top: 0,
      bottom: 0,
    });

    expect(frame.left).toBeGreaterThanOrEqual(260);
    expect(frame.left + frame.width).toBeLessThanOrEqual(660);
    expect(frame.top).toBeGreaterThanOrEqual(40);
    expect(frame.top + frame.height).toBeLessThanOrEqual(574);
  });
});
