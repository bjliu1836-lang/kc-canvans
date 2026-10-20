import type { LayoutDraft, LayoutDraftComponent } from "./layoutDraft";
import type { ModelLibraryItem } from "../modelLibrary/modelLibraryCatalog";
import { resolveLayoutCatalogItem } from "../modelLibrary/modelLibraryCatalog";

/** Persisted marker for layout-generated catalog assets with component-sized local bounds. */
export const LAYOUT_CATALOG_FIT_MODE = "unit-box-bottom-center-v1" as const;

export type LayoutComponentRepresentation =
  | { kind: "geometry" }
  | { kind: "catalog"; item: ModelLibraryItem; yawCorrectionRadians: number };

function isRectangularFootprint(component: LayoutDraftComponent) {
  const footprints = component.groundFootprint;
  if (!footprints?.length) return true;
  if (footprints.length !== 1) return false;
  const footprint = footprints[0];
  if (footprint.holes?.length || footprint.outer.length !== 4) return false;
  const points = footprint.outer;
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return [next[0] - point[0], next[1] - point[1]] as const;
  });
  const lengths = edges.map(([x, z]) => Math.hypot(x, z));
  if (lengths.some((length) => length < 1e-4)) return false;
  const dot01 = edges[0][0] * edges[1][0] + edges[0][1] * edges[1][1];
  const dot12 = edges[1][0] * edges[2][0] + edges[1][1] * edges[2][1];
  const perpendicular01 = Math.abs(dot01) / (lengths[0] * lengths[1]);
  const perpendicular12 = Math.abs(dot12) / (lengths[1] * lengths[2]);
  const opposite01 = Math.abs(lengths[0] - lengths[2]) / Math.max(lengths[0], lengths[2]);
  const opposite12 = Math.abs(lengths[1] - lengths[3]) / Math.max(lengths[1], lengths[3]);
  return perpendicular01 <= 0.04 && perpendicular12 <= 0.04 && opposite01 <= 0.08 && opposite12 <= 0.08;
}

/**
 * Resolve the exact same bounded catalog choice for draft preview and apply.
 * Compound or linked observations remain on the shared program-geometry path.
 */
export function resolveLayoutComponentRepresentation(
  draft: Pick<LayoutDraft, "components">,
  component: LayoutDraftComponent
): LayoutComponentRepresentation {
  if (component.assembly?.length || component.partOfComponentId || !isRectangularFootprint(component)) {
    return { kind: "geometry" };
  }
  if (draft.components.some((candidate) => candidate.partOfComponentId === component.id)) {
    return { kind: "geometry" };
  }

  const nameAndDescriptor = `${component.name} ${component.modelDescriptor ?? ""}`.toLowerCase();
  if (component.category === "sofa" && /(转角|组合|sectional|corner|modular|l[- ]?shaped)/.test(nameAndDescriptor)) return { kind: "geometry" };
  if (component.category === "sofa" && !/(沙发|sofa|couch)/.test(nameAndDescriptor)) return { kind: "geometry" };
  if (component.category === "table" && !/(餐桌|dining\s*table)/.test(nameAndDescriptor)) return { kind: "geometry" };
  const item = resolveLayoutCatalogItem(component);
  if (!item) return { kind: "geometry" };
  // Existing built-in fallback sofa has its back on local +Z; layout primitives use local -Z.
  const yawCorrectionRadians = item.fileName === "sofa_modern_low.fbx" ? Math.PI : 0;
  return { kind: "catalog", item, yawCorrectionRadians };
}

/** Local canonical bounds of the built-in catalog models, after their Y-up import orientation. */
export function getLayoutCatalogUnitBoxTransform(fileName: string) {
  const bounds = fileName === "sofa_modern_low.fbx"
    ? { min: [-0.97, 0, -0.41] as const, max: [0.97, 1.25, 0.41] as const }
    : fileName === "dining_table_low.fbx"
      ? { min: [-0.875, 0, -0.525] as const, max: [0.875, 0.95, 0.525] as const }
      : null;
  if (!bounds) return null;
  const scale: [number, number, number] = [
    1 / (bounds.max[0] - bounds.min[0]),
    1 / (bounds.max[1] - bounds.min[1]),
    1 / (bounds.max[2] - bounds.min[2]),
  ];
  return {
    position: [-((bounds.min[0] + bounds.max[0]) / 2) * scale[0], -bounds.min[1] * scale[1], -((bounds.min[2] + bounds.max[2]) / 2) * scale[2]] as [number, number, number],
    scale,
  };
}
