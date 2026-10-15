import { describe, expect, it } from "vitest";
import raw from "../../../../../artifacts/temple-layout-diagnosis-2026-10-13/temple-assembly-integration-fixture-2026-10-15.json";
import savedNormalized from "../../../../../artifacts/temple-layout-diagnosis-2026-10-13/temple-assembly-normalized-2026-10-15.json";
import { validateLayoutDraftCandidate } from "./layoutDraft";

describe("人工增强寺庙 assembly 集成 fixture", () => {
  it("uses the production normalizer before browser injection", () => {
    const normalized = validateLayoutDraftCandidate(raw, { sourceId: raw.sourceId, fileName: raw.sourceFileName }, {
      draftId: raw.id,
      createdAt: raw.createdAt,
    });
    expect(normalized).toEqual(savedNormalized);
    expect(normalized.components).toHaveLength(19);
    expect(normalized.characters).toHaveLength(1);
    expect(normalized.components.filter((component) => component.visible)).toHaveLength(19);
    expect(normalized.components.reduce((total, component) => total + (component.assembly?.length ?? 0), 0)).toBe(18);
  });
});
