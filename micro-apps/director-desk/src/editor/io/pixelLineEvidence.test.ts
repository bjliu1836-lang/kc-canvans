import { describe, expect, it } from "vitest";
import { extractPixelLineEvidence, PIXEL_LINE_LIMITS, type GrayscaleImage } from "./pixelLineEvidence";

function makeLineImage(width: number, height: number, angleDegrees: number, contrast = 180): GrayscaleImage {
  const pixels = new Uint8Array(width * height).fill(96);
  const angle = angleDegrees * Math.PI / 180;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const centerX = width / 2, centerY = height / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.abs(-(x - centerX) * dy + (y - centerY) * dx);
    if (distance <= 1.5) pixels[y * width + x] = Math.min(255, 96 + contrast);
  }
  return { width, height, pixels };
}

function angularDifference(a: number, b: number) {
  const difference = Math.abs(a - b) % 180;
  return Math.min(difference, 180 - difference);
}

describe("extractPixelLineEvidence", () => {
  it.each([0, 27, 63, 143])("detects a long straight edge at %i degrees", (angle) => {
    const result = extractPixelLineEvidence(makeLineImage(320, 240, angle));
    expect(result.segments.length).toBeGreaterThan(0);
    expect(angularDifference(result.segments[0].angleDegrees, angle)).toBeLessThanOrEqual(3);
    expect(result.segments[0].evidence).toBe("observed-pixel-edge");
    expect(result.segments[0].supportRate).toBeGreaterThan(0.3);
  });

  it("detects a faint edge on a low-texture background", () => {
    const result = extractPixelLineEvidence(makeLineImage(256, 192, 34, 28));
    expect(result.segments.length).toBeGreaterThan(0);
    expect(angularDifference(result.segments[0].angleDegrees, 34)).toBeLessThanOrEqual(4);
  });

  it("retains a low-contrast long edge beside a bright textured region", () => {
    const width = 384, height = 256, pixels = new Uint8Array(width * height).fill(35);
    for (let y = 16; y < 112; y += 1) for (let x = 40; x < 280; x += 1) {
      pixels[y * width + x] = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 248 : 12;
    }
    for (let y = 165; y <= 167; y += 1) for (let x = 12; x < width - 12; x += 1) pixels[y * width + x] = 47;
    const result = extractPixelLineEvidence({ width, height, pixels });
    const darkLongEdge = result.segments.find((segment) => angularDifference(segment.angleDegrees, 0) <= 2
      && segment.lengthPixels >= 150);
    expect(result.edgeThreshold).toBeGreaterThan(48);
    expect(darkLongEdge).toBeDefined();
    expect(darkLongEdge?.supportRate).toBeGreaterThan(0.3);
  });

  it("returns no lines for a pure-color image", () => {
    const result = extractPixelLineEvidence({ width: 128, height: 96, pixels: new Uint8Array(128 * 96).fill(128) });
    expect(result.detectedEdgePixels).toBe(0);
    expect(result.voteCount).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it("keeps noise evidence bounded and does not promote it to a semantic junction", () => {
    const width = 256, height = 192, pixels = new Uint8Array(width * height);
    let state = 0x12345678;
    for (let i = 0; i < pixels.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[i] = state >>> 24;
    }
    const result = extractPixelLineEvidence({ width, height, pixels });
    expect(result.sampledEdgePixels).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxEdges);
    expect(result.voteCount).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxVotes);
    expect(result.candidateCount).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxCandidates);
    expect(result.segments.length).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxSegments);
    expect(result.segments.every((segment) => segment.evidence === "observed-pixel-edge")).toBe(true);
  });

  it("caps edge, vote, and candidate work for dense texture", () => {
    const width = 300, height = 220, pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[y * width + x] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 255 : 0;
    const result = extractPixelLineEvidence({ width, height, pixels });
    expect(result.detectedEdgePixels).toBeGreaterThan(PIXEL_LINE_LIMITS.maxEdges);
    expect(result.sampledEdgePixels).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxEdges);
    expect(result.sampledEdgePixels).toBeGreaterThan(0);
    expect(result.voteCount).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxVotes);
    expect(result.candidateCount).toBeLessThanOrEqual(PIXEL_LINE_LIMITS.maxCandidates);
    expect(result.truncated.edges).toBe(true);
  });

  it("rejects non-thumbnail input instead of allocating an unbounded accumulator", () => {
    expect(() => extractPixelLineEvidence({ width: 769, height: 10, pixels: new Uint8Array(7690) })).toThrow(RangeError);
  });
});
