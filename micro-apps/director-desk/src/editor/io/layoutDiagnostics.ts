import type { DirectorObject } from "../schema/directorProject";
import { createLayoutCharacterRenderAdapter, type LayoutDraft } from "../schema/layoutDraft";

const STORAGE_KEY = "kc.director-layout-diagnostics.v1";
const MAX_RECORDS = 20;
const MAX_STAGES_PER_RECORD = 12;
const MAX_STORAGE_BYTES = 256 * 1024;

export interface LayoutDiagnosticRecord {
  generationId: string;
  draftId: string;
  createdAt: string;
  candidate?: Record<string, unknown>;
  normalized: {
    spaceType?: LayoutDraft["spaceType"];
    componentCount: number;
    characterCount: number;
    characters?: Array<{
      id: string;
      position: [number, number, number];
      height: number;
      rotationYDegrees: number;
      facingDirection?: string;
      posture: string;
      kneelVariant?: string;
      handGesture?: string;
      supportComponentId?: string;
      posePresetId: string;
      controls: Record<string, number>;
    }>;
    components: Array<{
      id: string;
      category: string;
      semanticType?: string;
      position: [number, number, number];
      size: [number, number, number];
      rotationYDegrees: number;
      confidence: number;
      uncertain: boolean;
      supportComponentId?: string;
      assembly?: LayoutDraft["components"][number]["assembly"];
      appearance?: { color?: string; roughness?: number; metalness?: number; frontDirectionDegrees?: number };
    }>;
    observations?: Array<{ componentId?: string; state: string; confidence: number }>;
    relations?: LayoutDraft["relations"];
    validationWarnings?: string[];
    referenceCamera?: {
      position: [number, number, number];
      target: [number, number, number];
      fov: number;
      imageAspectRatio?: number;
      confidence: number;
      source: string;
    };
  };
  stages: Array<Record<string, unknown>>;
}

export function shouldEnableLayoutDiagnostics(isDev: boolean, search: string) {
  if (isDev) return true;
  try {
    return new URLSearchParams(search).get("directorLayoutDiagnostics") === "1";
  } catch {
    return false;
  }
}

function diagnosticsEnabled() {
  return typeof window !== "undefined" && shouldEnableLayoutDiagnostics(import.meta.env.DEV, window.location.search);
}

function readRecords(): LayoutDiagnosticRecord[] {
  if (!diagnosticsEnabled()) return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is LayoutDiagnosticRecord => Boolean(item && typeof item === "object")) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: LayoutDiagnosticRecord[]) {
  if (!diagnosticsEnabled()) return;
  try {
    let bounded = records.slice(-MAX_RECORDS);
    while (bounded.length && new Blob([JSON.stringify(bounded)]).size > MAX_STORAGE_BYTES) bounded = bounded.slice(1);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Diagnostics are best-effort and never block layout generation or application.
  }
}

const CANDIDATE_KEYS = ["spaceType", "observations", "relations", "components", "characters", "referenceCamera", "observationFormat", "visualObservations"] as const;
const COMPONENT_KEYS = ["id", "category", "primitive", "semanticType", "position", "size", "rotationYDegrees", "confidence", "visible", "assembly", "appearance"] as const;
const CHARACTER_KEYS = ["id", "position", "height", "rotationYDegrees", "facingDirection", "supportComponentId", "confidence", "visible", "posture", "bodyType", "handGesture", "kneelVariant"] as const;
const RELATION_KEYS = ["type", "fromId", "toId", "confidence"] as const;
const OBSERVATION_KEYS = ["componentId", "state", "confidence"] as const;
const CAMERA_KEYS = ["position", "target", "fov", "imageAspectRatio", "confidence", "source"] as const;
const ASSEMBLY_KEYS = ["id", "primitive", "position", "size", "color", "roughness", "metalness", "opacity"] as const;
const APPEARANCE_KEYS = ["color", "roughness", "metalness", "frontDirectionDegrees"] as const;
const IMAGE_SURFACE_KEYS = ["id", "kind", "side", "bbox", "confidence", "visibility", "mainColor", "color", "appearance"] as const;
const IMAGE_ITEM_KEYS = ["id", "name", "semanticType", "category", "bbox", "confidence", "visibility", "mainColor", "color", "appearance", "againstSurfaceId", "contactWallSide", "rearFeature", "bodyExtendsToward", "supportId", "partOfId"] as const;
const IMAGE_PERSON_KEYS = ["id", "name", "bbox", "confidence", "visibility", "posture", "facingDirection", "kneelVariant", "handGesture", "supportId"] as const;

function pick(source: unknown, keys: readonly string[]) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const input = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

function boundDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === "string") return value.slice(0, 120);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => boundDiagnosticValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32)
      .map(([key, item]) => [key.slice(0, 48), boundDiagnosticValue(item, depth + 1)])
      .filter(([, item]) => item !== undefined));
  }
  return undefined;
}

/** Keep only known geometry fields; provider prose, evidence, URLs, and arbitrary extras never enter diagnostics. */
function sanitizeCandidate(value: unknown): Record<string, unknown> | undefined {
  const candidate = pick(value, CANDIDATE_KEYS);
  if (!candidate) return undefined;
  if (typeof candidate.observationFormat === "string") candidate.observationFormat = candidate.observationFormat.slice(0, 48);
  const visualObservations = pick(candidate.visualObservations, ["spaceType", "surfaces", "items", "people"]);
  if (visualObservations) {
    if (Array.isArray(visualObservations.surfaces)) {
      visualObservations.surfaces = visualObservations.surfaces.slice(0, 8).map((item) => {
        const surface = pick(item, IMAGE_SURFACE_KEYS) ?? {};
        surface.appearance = pick(surface.appearance, ["color"]);
        return surface;
      });
    } else delete visualObservations.surfaces;
    if (Array.isArray(visualObservations.items)) {
      visualObservations.items = visualObservations.items.slice(0, 30).map((item) => {
        const imageItem = pick(item, IMAGE_ITEM_KEYS) ?? {};
        imageItem.appearance = pick(imageItem.appearance, ["color"]);
        imageItem.rearFeature = pick(imageItem.rearFeature, ["name", "bbox"]);
        return imageItem;
      });
    } else delete visualObservations.items;
    if (Array.isArray(visualObservations.people)) {
      visualObservations.people = visualObservations.people.slice(0, 8).map((item) => pick(item, IMAGE_PERSON_KEYS) ?? {});
    } else delete visualObservations.people;
    candidate.visualObservations = visualObservations;
  } else delete candidate.visualObservations;
  if (Array.isArray(candidate.components)) {
    candidate.components = candidate.components.slice(0, 30).map((item) => {
      const component = pick(item, COMPONENT_KEYS);
      if (!component) return {};
      if (Array.isArray(component.assembly)) component.assembly = component.assembly.slice(0, 24).map((part) => pick(part, ASSEMBLY_KEYS) ?? {});
      component.appearance = pick(component.appearance, APPEARANCE_KEYS);
      return component;
    });
  } else delete candidate.components;
  if (Array.isArray(candidate.characters)) candidate.characters = candidate.characters.slice(0, 8).map((item) => pick(item, CHARACTER_KEYS) ?? {});
  else delete candidate.characters;
  if (Array.isArray(candidate.relations)) candidate.relations = candidate.relations.slice(0, 60).map((item) => pick(item, RELATION_KEYS) ?? {});
  else delete candidate.relations;
  if (Array.isArray(candidate.observations)) candidate.observations = candidate.observations.slice(0, 60).map((item) => pick(item, OBSERVATION_KEYS) ?? {});
  else delete candidate.observations;
  candidate.referenceCamera = pick(candidate.referenceCamera, CAMERA_KEYS);
  const bounded = boundDiagnosticValue(candidate);
  if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) return undefined;
  try {
    return new Blob([JSON.stringify(bounded)]).size <= 48 * 1024 ? bounded as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function tuple3(value: readonly number[]): [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

export function recordNormalizedLayoutDraft(draft: LayoutDraft, generationId: string, candidate: unknown) {
  if (!diagnosticsEnabled()) return;
  const camera = draft.referenceCamera;
  const safeCandidate = sanitizeCandidate(candidate);
  const record: LayoutDiagnosticRecord = {
    generationId,
    draftId: draft.id,
    createdAt: draft.createdAt,
    ...(safeCandidate ? { candidate: safeCandidate } : {}),
    normalized: {
      ...(draft.spaceType ? { spaceType: draft.spaceType } : {}),
      componentCount: draft.components.length,
      characterCount: draft.characters.length,
      characters: draft.characters.map((character) => {
        const adapter = createLayoutCharacterRenderAdapter(character);
        return {
          id: character.id,
          position: tuple3(character.position),
          height: character.height,
          rotationYDegrees: character.rotationYDegrees,
          ...(character.facingDirection ? { facingDirection: character.facingDirection } : {}),
          posture: character.posture,
          ...(character.kneelVariant ? { kneelVariant: character.kneelVariant } : {}),
          ...(character.handGesture ? { handGesture: character.handGesture } : {}),
          ...(character.supportComponentId ? { supportComponentId: character.supportComponentId } : {}),
          posePresetId: adapter.characterRig.posePresetId,
          controls: adapter.characterRig.controls,
        };
      }),
      components: draft.components.map((component) => ({
        id: component.id,
        category: component.category,
        ...(component.semanticType ? { semanticType: component.semanticType } : {}),
        position: tuple3(component.position),
        size: tuple3(component.size),
        rotationYDegrees: component.rotationYDegrees,
        confidence: component.confidence,
        uncertain: component.uncertain,
        ...(component.supportComponentId ? { supportComponentId: component.supportComponentId } : {}),
        ...(component.assembly ? { assembly: component.assembly.map((part) => ({ ...part })) } : {}),
        ...(component.appearance ? { appearance: {
          ...(component.appearance.color ? { color: component.appearance.color } : {}),
          ...(component.appearance.roughness !== undefined ? { roughness: component.appearance.roughness } : {}),
          ...(component.appearance.metalness !== undefined ? { metalness: component.appearance.metalness } : {}),
          ...(component.appearance.frontDirectionDegrees !== undefined ? { frontDirectionDegrees: component.appearance.frontDirectionDegrees } : {}),
        } } : {}),
      })),
      ...(draft.observations ? { observations: draft.observations.map(({ componentId, state, confidence }) => ({ ...(componentId ? { componentId } : {}), state, confidence })) } : {}),
      ...(draft.relations ? { relations: draft.relations.map((relation) => ({ ...relation })) } : {}),
      ...(draft.validationWarnings ? { validationWarnings: [...draft.validationWarnings] } : {}),
      ...(camera ? { referenceCamera: {
        position: tuple3(camera.position),
        target: tuple3(camera.target),
        fov: camera.fov,
        ...(camera.imageAspectRatio ? { imageAspectRatio: camera.imageAspectRatio } : {}),
        confidence: camera.confidence,
        source: camera.source,
        ...(camera.fitDiagnostics ? { fitDiagnostics: { ...camera.fitDiagnostics } } : {}),
      } } : {}),
    },
    stages: [...(readRecords().find((item) => item.generationId === generationId)?.stages ?? []), { phase: "normalized", at: new Date().toISOString() }].slice(-MAX_STAGES_PER_RECORD),
  };
  writeRecords([...readRecords().filter((item) => item.generationId !== generationId), record]);
}

export function createLayoutGenerationId() {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `layout-${id}`;
}

export function recordLayoutGenerationStarted(generationId: string) {
  if (!diagnosticsEnabled()) return;
  const now = new Date().toISOString();
  writeRecords([...readRecords().filter((item) => item.generationId !== generationId), {
    generationId,
    draftId: "",
    createdAt: now,
    normalized: { componentCount: 0, characterCount: 0, components: [] },
    stages: [{ phase: "request-started", at: now }],
  }]);
}

export function recordLayoutGenerationFailed(generationId: string, code: string, evidence?: unknown) {
  if (!diagnosticsEnabled()) return;
  const records = readRecords();
  const index = records.findIndex((item) => item.generationId === generationId);
  if (index < 0) return;
  const record = records[index];
  const safeEvidence = pick(evidence, ["error", "issues", "issuePaths", "outputShape", "providerEnvelope"]);
  const boundedEvidence = safeEvidence ? boundDiagnosticValue(safeEvidence) : undefined;
  records[index] = { ...record, stages: [...record.stages, {
    phase: "request-failed", code, at: new Date().toISOString(), ...(boundedEvidence ? { evidence: boundedEvidence } : {}),
  }].slice(-MAX_STAGES_PER_RECORD) };
  writeRecords(records);
}

function appendStage(generationId: string, stage: Record<string, unknown>) {
  const records = readRecords();
  const index = records.findIndex((record) => record.generationId === generationId);
  if (index < 0) return;
  const record = records[index];
  records[index] = { ...record, stages: [...record.stages, { at: new Date().toISOString(), ...stage }].slice(-MAX_STAGES_PER_RECORD) };
  writeRecords(records);
}

export function recordLayoutReferencePreview(generationId: string, active: boolean, camera?: LayoutDraft["referenceCamera"]) {
  appendStage(generationId, {
    phase: active ? "reference-preview-start" : "reference-preview-end",
    ...(active && camera ? { camera: {
      position: tuple3(camera.position),
      target: tuple3(camera.target),
      fov: camera.fov,
      ...(camera.imageAspectRatio ? { imageAspectRatio: camera.imageAspectRatio } : {}),
    } } : {}),
  });
}

export function recordLayoutDraftApplied(generationId: string, batchId: string, objects: readonly DirectorObject[]) {
  appendStage(generationId, {
    phase: "applied",
    batchId,
    objects: objects.slice(0, 60).map((object) => ({
      id: object.id,
      position: [...object.transform.position],
      rotation: [...object.transform.rotation],
      scale: [...object.transform.scale],
      geometryType: object.geometryType ?? null,
      assembly: object.layoutSource?.assembly?.slice(0, 24).map((part) => ({ ...part })) ?? null,
      color: object.color,
    })),
  });
}

export function readLayoutDiagnosticRecords() {
  return readRecords();
}

export function isLayoutDiagnosticsEnabled() {
  return diagnosticsEnabled();
}

export function downloadLayoutDiagnostics() {
  if (!diagnosticsEnabled() || typeof document === "undefined") return false;
  const records = readRecords();
  const blob = new Blob([JSON.stringify({ version: 1, records }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "director-layout-diagnostics.json";
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
