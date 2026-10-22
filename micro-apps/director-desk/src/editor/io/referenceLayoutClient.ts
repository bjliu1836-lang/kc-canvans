import { validateLayoutDraftCandidate, type LayoutDraft, type LayoutDraftSource } from "../schema/layoutDraft";
import { imageObservationToLayoutDraft, ImageObservationValidationError, normalizeImageObservation } from "../schema/imageObservationLayout";
import type { ImageObservation } from "../schema/imageObservationLayout";
import { assertMultiViewContract, multiViewToCanonicalObservation, registerGroundViews, selectCanonicalFrame, type DerivedGroundPlacement } from "../schema/multiViewObservation";
import { createLayoutGenerationId, recordLayoutGenerationFailed, recordLayoutGenerationStarted, recordNormalizedLayoutDraft } from "./layoutDiagnostics";

const AUTH_TOKEN_KEY = "KC_CANVAS_AUTH_TOKEN";
const INVALID_LAYOUT_MESSAGE = "图片模型未能返回可用的布景结构，请重试或更换参考图";
const IMAGE_OBSERVATION_FORMAT = "image-observations-v2";
function stableImageFingerprint(url: string) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) { hash ^= url.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${url.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
function readImageAspectRatio(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (ratio?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ratio);
    };
    const timeout = setTimeout(() => finish(undefined), 5000);
    image.crossOrigin = "anonymous";
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : undefined);
    image.onerror = () => finish(undefined);
    image.src = url;
  });
}
const SPATIAL_REVIEW_ITEM_FIELDS = [
  "groundFootprints", "groundContacts", "occludesIds", "supportId", "partOfId", "placement",
  "contactWallSide", "againstSurfaceId", "rearFeature", "bodyExtendsToward", "visibleBbox", "completeBbox",
] as const;
const SPATIAL_REVIEW_CLEARABLE_RELATION_FIELDS = new Set([
  "supportId", "partOfId", "againstSurfaceId", "contactWallSide",
]);

function mergeSpatialReview(base: ImageObservation, value: unknown): ImageObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("空间复核结果无效");
  const patch = value as Record<string, unknown>;
  if (!Array.isArray(patch.items) || patch.items.length > base.items.length) throw new Error("空间复核结果无效");
  const byId = new Map(base.items.map((item) => [item.id, item]));
  for (const candidate of patch.items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("空间复核结果无效");
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !byId.has(item.id)) throw new Error("空间复核包含未知对象");
    const current = byId.get(item.id)!;
    const next: Record<string, unknown> = { ...current };
    for (const key of Object.keys(item)) {
      if (key !== "id" && !(SPATIAL_REVIEW_ITEM_FIELDS as readonly string[]).includes(key)) throw new Error("空间复核修改了对象身份");
      if (key === "id") continue;
      if (item[key] === null && SPATIAL_REVIEW_CLEARABLE_RELATION_FIELDS.has(key)) {
        delete next[key];
      } else {
        next[key] = item[key];
      }
    }
    byId.set(item.id, next as unknown as typeof current);
  }
  const geometryEvidence = patch.geometryEvidence ?? base.geometryEvidence;
  return {
    ...base,
    ...(geometryEvidence ? { geometryEvidence: geometryEvidence as ImageObservation["geometryEvidence"] } : {}),
    items: base.items.map((item) => byId.get(item.id)!),
  };
}

export function shouldRequestSpatialReview(observation: ImageObservation, draft: LayoutDraft): boolean {
  if (observation.items.length === 0) return false;
  const missingComplexFurnitureFootprint = observation.items.some((item) =>
    (() => {
      const identity = `${item.semanticType ?? ""} ${item.name}`;
      const sofaIdentity = item.category === "sofa"
        || (item.category === undefined && /(?:sofa|couch|沙发)/i.test(identity));
      const complexFurniture = /(?:sectional|corner|modular|l[- ]?shaped|转角|组合)/i.test(identity);
      // Image observations are parsed and geometry-validated before this predicate runs.
      const hasUsableFootprint = hasTrustedFootprint(item);
      return sofaIdentity && complexFurniture && !hasUsableFootprint;
    })(),
  );
  if (missingComplexFurnitureFootprint) return true;
  const major = observation.items.filter((item) =>
    item.confidence >= 0.55
    && ["ground", "table", "chair", "sofa", "cabinet", "pillar"].includes(item.category ?? ""));
  const eligible = major.length ? major : observation.items.filter((item) => item.confidence >= 0.65);
  const evidenced = eligible.filter((item) =>
    (item.groundFootprints?.some((footprint) => footprint.confidence >= 0.55) ?? false)
    || (item.groundContacts?.filter((contact) => contact.confidence >= 0.55).length ?? 0) >= 2
    || Boolean(item.supportId || item.partOfId || item.occludesIds?.length));
  const diagnostics = draft.referenceCamera?.fitDiagnostics;
  const trace = diagnostics?.spatialEvidenceTrace;
  const hasConflict = Boolean(
    diagnostics?.rejectionReason === "no-safe-candidate"
    || (diagnostics?.physicalValidity?.hardCollisionCount ?? 0) > 0
    || (trace?.majorOverlapRejects.length ?? 0) > 0
    || (diagnostics?.collisionPairs?.some((pair) => pair.classification !== "allowed") ?? false),
  );
  const coverageInsufficient = eligible.length > 0 && evidenced.length / eligible.length < 0.6;
  return hasConflict || coverageInsufficient || diagnostics?.qualityStatus === "needsReview";
}

function hasTrustedFootprint(item: ImageObservation["items"][number]) {
  return item.groundFootprints?.some((footprint) =>
    footprint.confidence >= 0.55 && footprint.outer.length >= 3,
  ) ?? false;
}

function spatialReviewContext(observation: ImageObservation, draft: LayoutDraft) {
  const ids = new Set(observation.items.map((item) => item.id));
  const trace = draft.referenceCamera?.fitDiagnostics?.spatialEvidenceTrace;
  const pairs = (trace?.majorOverlapRejects ?? [])
    .map((entry) => [entry.firstId, entry.secondId] as [string, string])
    .filter((pair) => pair.every((id) => ids.has(id)))
    .slice(0, 8);
  if (!pairs.length) {
    for (const collision of draft.referenceCamera?.fitDiagnostics?.collisionPairs ?? []) {
      const pair = [collision.firstId, collision.secondId];
      if (collision.classification !== "allowed" && pair.every((id) => ids.has(id))) pairs.push(pair as [string, string]);
      if (pairs.length >= 8) break;
    }
  }
  const missingEvidence: string[] = [];
  if (observation.items.some((item) => !hasTrustedFootprint(item))) missingEvidence.push("non-convex-contact-boundary");
  if (pairs.length || observation.items.some((item) => !item.occludesIds?.length)) missingEvidence.push("visible-gap");
  if (pairs.length || observation.items.some((item) => !item.supportId)) missingEvidence.push("support-contact");
  if (!observation.geometryEvidence?.axes?.length) missingEvidence.push("parallel-lines");
  if (pairs.length) missingEvidence.push("occlusion-order");
  return { conflictPairIds: pairs, missingEvidence: [...new Set(missingEvidence)].slice(0, 5) };
}

function readableLayoutIssue(data: Record<string, unknown>) {
  if (!Array.isArray(data.issues)) return "";
  const issue = data.issues.find((item): item is string => typeof item === "string")?.trim();
  if (!issue || issue.length > 180) return "";
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(issue)) return "";
  if (/(?:\b(?:api[-_ ]?key|token|secret|authorization|bearer)\b|https?:\/\/|data:image\/|[<>{}\[\]`"'\\])/i.test(issue)) return "";
  return issue.replace(/\s+/g, " ");
}

export interface ReferenceLayoutImage extends LayoutDraftSource {
  url: string;
  origin: "local" | "canvas";
  aspectRatio?: number;
}

function readableLayoutError(status: number, data: Record<string, unknown>) {
  const code = typeof data.error === "string" ? data.error : "";
  if (status === 401) return "登录已失效，请返回画布重新登录";
  if (status === 402) return "图片理解模型额度不足，请补充额度后重试";
  if (code === "DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED") return "尚未配置图片理解模型，请联系管理员完成模型配置后重试";
  if (code === "DIRECTOR_LAYOUT_IMAGE_REQUIRED") return "参考图无效，请重新选择图片";
  if (code === "DIRECTOR_LAYOUT_TOO_MANY_IMAGES") return "一次最多选择 3 张参考图";
  if (code === "DIRECTOR_LAYOUT_IMAGES_TOO_LARGE" || code === "DIRECTOR_LAYOUT_REQUEST_TOO_LARGE") return "所选参考图合计过大，请压缩图片后重试（最多 16 MB）";
  if (code === "DIRECTOR_LAYOUT_IMAGES_AMBIGUOUS" || code === "DIRECTOR_LAYOUT_IMAGES_INVALID") return "参考图列表无效，请重新选择图片";
  if (code === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON" || code === "DIRECTOR_LAYOUT_MODEL_JSON_INVALID" || code === "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID") {
    const issue = readableLayoutIssue(data);
    return issue ? `${INVALID_LAYOUT_MESSAGE}（${issue}）` : INVALID_LAYOUT_MESSAGE;
  }
  return typeof data.message === "string" && data.message.trim()
    ? data.message
    : `粗布景生成失败（${status}）`;
}

export async function requestReferenceLayout(
  imageInput: ReferenceLayoutImage | readonly ReferenceLayoutImage[],
  signal?: AbortSignal
): Promise<LayoutDraft> {
  const images = Array.isArray(imageInput) ? [...imageInput] : [imageInput as ReferenceLayoutImage];
  if (!images.length || images.length > 3) throw new Error("请选择 1 到 3 张参考图");
  const primaryImage = images[0];
  const requestImages: Array<ReferenceLayoutImage & { requestUrl: string; requestAspectRatio?: number }> = [];
  let aggregateInlineLength = 0;
  for (const image of images) {
    let requestUrl = image.url;
    if (requestUrl.startsWith("blob:")) {
      const blob = await fetch(requestUrl, { signal }).then((response) => {
        if (!response.ok) throw new Error("无法读取画布连接的参考图");
        return response.blob();
      });
      requestUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取画布连接的参考图"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
    }
    if (!(/^data:image\/(?:png|jpeg|webp);base64,/i.test(requestUrl) || /^https?:\/\//i.test(requestUrl))) {
      throw new Error("参考图格式无效，请重新选择 PNG、JPG 或 WebP 图片");
    }
    if (requestUrl.startsWith("data:image/")) aggregateInlineLength += requestUrl.length;
    const requestAspectRatio = image.aspectRatio ?? await readImageAspectRatio(requestUrl);
    requestImages.push({ ...image, requestUrl, ...(requestAspectRatio ? { requestAspectRatio } : {}) });
  }
  if (aggregateInlineLength > 16 * 1024 * 1024 + 512) {
    throw new Error("所选参考图合计过大，请压缩图片后重试（最多 16 MB）");
  }
  const generationId = createLayoutGenerationId();
  const token = window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  recordLayoutGenerationStarted(generationId);
  let response: Response;
  try {
    response = await fetch("/api/director-layout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        outputFormat: IMAGE_OBSERVATION_FORMAT,
        images: requestImages.map((image, index) => ({
          id: image.sourceId,
          sourceId: image.sourceId,
          url: image.requestUrl,
          fileName: image.fileName,
        })),
      }),
      signal,
    });
  } catch (error) {
    recordLayoutGenerationFailed(generationId, signal?.aborted ? "cancelled" : "network-error");
    throw error;
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = response.status === 401 ? "unauthorized"
      : response.status === 402 ? "quota"
      : data.error === "DIRECTOR_LAYOUT_UPSTREAM_HTTP" ? "upstream-http"
      : data.error === "DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID" ? "upstream-response"
      : data.error === "DIRECTOR_LAYOUT_MODEL_JSON_INVALID" ? "model-json"
      : data.error === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON" ? "model-schema"
      : data.error === "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID" ? "model-schema"
      : response.status >= 500 ? "server-error" : "request-rejected";
    const safeErrors = ["DIRECTOR_LAYOUT_UPSTREAM_HTTP", "DIRECTOR_LAYOUT_UPSTREAM_FAILURE", "DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID", "DIRECTOR_LAYOUT_INVALID_MODEL_JSON", "DIRECTOR_LAYOUT_MODEL_JSON_INVALID", "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID"];
    recordLayoutGenerationFailed(generationId, code, {
      error: typeof data.error === "string" && safeErrors.includes(data.error) ? data.error : undefined,
      issues: Array.isArray(data.issues) ? data.issues : undefined,
      issuePaths: Array.isArray(data.issuePaths) ? data.issuePaths : undefined,
      outputShape: data.outputShape,
      providerEnvelope: data.providerEnvelope,
    });
    throw new Error(readableLayoutError(response.status, data));
  }
  try {
    const legacyResponse = data.observationFormat === undefined && data.draft !== undefined;
    if (images.length > 1 && (legacyResponse || data.observationFormat !== IMAGE_OBSERVATION_FORMAT)) {
      throw new Error("多张参考图需要完整的 image-observations-v2 多视图结果，不能安全解释旧版单图坐标");
    }
    if (data.observationFormat !== undefined && data.observationFormat !== IMAGE_OBSERVATION_FORMAT && data.observationFormat !== "image-observations-v1") {
      throw new Error("图片模型返回了不支持的图像观察格式");
    }
    if (!legacyResponse && data.observationFormat !== IMAGE_OBSERVATION_FORMAT && data.observationFormat !== "image-observations-v1") {
      throw new Error("图片模型未返回可用的图像观察结构");
    }
    if (legacyResponse) {
      const draft = {
        ...validateLayoutDraftCandidate(data.draft, primaryImage, { imageAspectRatio: primaryImage.aspectRatio }),
        diagnosticGenerationId: generationId,
      };
      recordNormalizedLayoutDraft(draft, generationId, data.draft);
      return draft;
    }
    const multiViewContract = data.observationFormat === IMAGE_OBSERVATION_FORMAT
      ? assertMultiViewContract(data.visualObservations, images.map((image) => image.sourceId))
      : null;
    let finalMultiViewContract = multiViewContract;
    const aspectRatios = Object.fromEntries(requestImages.map((image) => [image.sourceId, image.requestAspectRatio]));
    let canonicalFrame = multiViewContract ? selectCanonicalFrame(multiViewContract, aspectRatios) : null;
    let canonicalImage = canonicalFrame
      ? { ...(images.find((image) => image.sourceId === canonicalFrame!.sourceId) ?? images[0]), aspectRatio: requestImages.find((image) => image.sourceId === canonicalFrame!.sourceId)?.requestAspectRatio }
      : images[0];
    const sourceGroupKey = images.map((image) => `${image.sourceId}:${stableImageFingerprint(image.url)}`).sort().join("|");
    const getResolution = (contract: NonNullable<typeof multiViewContract>, frame: NonNullable<typeof canonicalFrame>) => {
      const physicalEntities = contract.entities.filter((entity) => entity.kind !== "surface");
      const visibleInCanonical = new Set(frame.entities.map((entry) => entry.entityId));
      const unresolved = physicalEntities.filter((entity) => !visibleInCanonical.has(entity.id)).map((entity) => ({
        entityId: entity.id,
        name: entity.name,
        sourceId: contract.views.find((view) => view.entities.some((entry) => entry.entityId === entity.id))?.sourceId ?? frame.sourceId,
        sourceFileName: images.find((image) => image.sourceId === (contract.views.find((view) => view.entities.some((entry) => entry.entityId === entity.id))?.sourceId ?? frame.sourceId))?.fileName ?? "历史参考图",
        reason: "该参考视图尚未通过可靠地面配准，暂不生成位置。",
      }));
      return { recognizedCount: physicalEntities.length, locatedCount: physicalEntities.length - unresolved.length, unresolved };
    };
    const convertedObservation = multiViewContract ? multiViewToCanonicalObservation(multiViewContract, canonicalFrame!) as ImageObservation & {
      groundEvidenceSourceIds?: Record<string, string[]>; multiViewRelationReviewEntityIds?: string[]; multiViewGeometryReviewEntityIds?: string[]; derivedGroundPlacements?: DerivedGroundPlacement[];
    } : null;
    const groundEvidenceSourceIds = convertedObservation?.groundEvidenceSourceIds;
    const relationReviewEntityIds = convertedObservation?.multiViewRelationReviewEntityIds ?? [];
    const geometryReviewEntityIds = convertedObservation?.multiViewGeometryReviewEntityIds ?? [];
    const derivedGroundPlacements = (convertedObservation?.derivedGroundPlacements ?? []).map((placement) => ({
      ...placement,
      sourceFileName: images.find((image) => image.sourceId === placement.sourceId)?.fileName ?? "参考图",
    }));
    const observation = normalizeImageObservation(convertedObservation ?? data.visualObservations);
    let finalObservation = observation;
    let resolution = multiViewContract ? getResolution(multiViewContract, canonicalFrame!) : undefined;
    const uncertainEntityIds = multiViewContract?.entities.filter((entity) => entity.uncertain).map((entity) => entity.id) ?? [];
    let draft = imageObservationToLayoutDraft(observation, canonicalImage, {
      ...(canonicalImage.aspectRatio ? { imageAspectRatio: canonicalImage.aspectRatio } : {}),
      ...(multiViewContract ? { sourceGroupKey, layoutResolution: resolution, uncertainEntityIds, relationReviewEntityIds, geometryReviewEntityIds, groundEvidenceSourceIds, derivedGroundPlacements } : {}),
    });
    if (resolution?.unresolved.length && draft.referenceCamera?.fitDiagnostics) draft.referenceCamera = {
      ...draft.referenceCamera,
      fitDiagnostics: { ...draft.referenceCamera.fitDiagnostics, qualityStatus: "needsReview" },
    };
    let spatialReviewMetadata: Record<string, unknown> | undefined;
    if (!signal?.aborted && shouldRequestSpatialReview(observation, draft)) {
      const reviewContext = spatialReviewContext(observation, draft);
      try {
        const reviewResponse = await fetch("/api/director-layout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: JSON.stringify({
            outputFormat: multiViewContract ? IMAGE_OBSERVATION_FORMAT : "image-observations-v1",
            observationStage: "spatial-review",
            images: requestImages.map((image, index) => ({
              id: image.sourceId,
              ...(!multiViewContract ? { role: index === 0 ? "primary" : "supplementary" } : {}),
              sourceId: image.sourceId,
              url: image.requestUrl,
              fileName: image.fileName,
            })),
            baseObservations: multiViewContract ?? observation,
            reviewContext,
          }),
          signal,
        });
        const reviewData = await reviewResponse.json().catch(() => ({})) as Record<string, unknown>;
        spatialReviewMetadata = {
          attempted: true,
          accepted: false,
          ...(typeof reviewData.providerModel === "string" ? { providerModel: reviewData.providerModel } : {}),
          ...(typeof reviewData.promptHash === "string" ? { promptHash: reviewData.promptHash } : {}),
          ...(typeof reviewData.providerFinishReason === "string" ? { providerFinishReason: reviewData.providerFinishReason } : {}),
          ...(reviewData.usage && typeof reviewData.usage === "object" ? { usage: reviewData.usage } : {}),
          ...(typeof reviewData.error === "string" ? { error: reviewData.error } : {}),
        };
        if (reviewResponse.ok && reviewData.observationFormat === IMAGE_OBSERVATION_FORMAT && multiViewContract) {
          const reviewedContract = assertMultiViewContract(reviewData.spatialReviewPatch, images.map((image) => image.sourceId));
          finalMultiViewContract = reviewedContract;
          canonicalFrame = selectCanonicalFrame(reviewedContract, aspectRatios);
          canonicalImage = {
            ...(images.find((image) => image.sourceId === canonicalFrame!.sourceId) ?? images[0]),
            aspectRatio: requestImages.find((image) => image.sourceId === canonicalFrame!.sourceId)?.requestAspectRatio,
          };
          const convertedReviewedObservation = multiViewToCanonicalObservation(reviewedContract, canonicalFrame) as ImageObservation & {
            groundEvidenceSourceIds?: Record<string, string[]>; multiViewRelationReviewEntityIds?: string[]; multiViewGeometryReviewEntityIds?: string[]; derivedGroundPlacements?: DerivedGroundPlacement[];
          };
          const reviewedObservation = normalizeImageObservation(convertedReviewedObservation);
          resolution = getResolution(reviewedContract, canonicalFrame);
          const reviewedDerivedGroundPlacements = (convertedReviewedObservation.derivedGroundPlacements ?? []).map((placement) => ({
            ...placement,
            sourceFileName: images.find((image) => image.sourceId === placement.sourceId)?.fileName ?? "参考图",
          }));
          const reviewedUncertainIds = reviewedContract.entities.filter((entity) => entity.uncertain).map((entity) => entity.id);
          const reviewedDraft = imageObservationToLayoutDraft(reviewedObservation, canonicalImage, {
            ...(canonicalImage.aspectRatio ? { imageAspectRatio: canonicalImage.aspectRatio } : {}),
            sourceGroupKey,
            layoutResolution: resolution,
            uncertainEntityIds: reviewedUncertainIds,
            relationReviewEntityIds: convertedReviewedObservation.multiViewRelationReviewEntityIds ?? [],
            geometryReviewEntityIds: convertedReviewedObservation.multiViewGeometryReviewEntityIds ?? [],
            groundEvidenceSourceIds: convertedReviewedObservation.groundEvidenceSourceIds,
            derivedGroundPlacements: reviewedDerivedGroundPlacements,
          });
          finalObservation = reviewedObservation;
          draft = reviewedDraft;
          spatialReviewMetadata.accepted = true;
          spatialReviewMetadata.qualityStatus = reviewedDraft.referenceCamera?.fitDiagnostics?.qualityStatus ?? "unavailable";
          spatialReviewMetadata.rejectionReason = reviewedDraft.referenceCamera?.fitDiagnostics?.rejectionReason ?? null;
        } else if (reviewResponse.ok && reviewData.observationFormat === "image-observations-v1" && !multiViewContract) {
          const reviewedObservation = mergeSpatialReview(observation, reviewData.spatialReviewPatch);
          const reviewedDraft = imageObservationToLayoutDraft(reviewedObservation, canonicalImage, {
            ...(canonicalImage.aspectRatio ? { imageAspectRatio: canonicalImage.aspectRatio } : {}),
          });
          finalObservation = reviewedObservation;
          draft = reviewedDraft;
          spatialReviewMetadata.accepted = true;
          spatialReviewMetadata.qualityStatus = reviewedDraft.referenceCamera?.fitDiagnostics?.qualityStatus ?? "unavailable";
          spatialReviewMetadata.rejectionReason = reviewedDraft.referenceCamera?.fitDiagnostics?.rejectionReason ?? null;
        }
      } catch (reviewError) {
        if (signal?.aborted || (reviewError instanceof DOMException && reviewError.name === "AbortError")) throw reviewError;
        spatialReviewMetadata = {
          attempted: true,
          accepted: false,
          ...(signal?.aborted ? { error: "cancelled" } : { error: "review-failed" }),
        };
      }
    }
    if (draft.layoutResolution?.unresolved.length && draft.referenceCamera?.fitDiagnostics) draft.referenceCamera = {
      ...draft.referenceCamera,
      fitDiagnostics: { ...draft.referenceCamera.fitDiagnostics, qualityStatus: "needsReview" },
    };
    const normalizedDraft = { ...draft, diagnosticGenerationId: generationId };
    recordNormalizedLayoutDraft(normalizedDraft, generationId, {
      observationFormat: data.observationFormat,
      visualObservations: finalObservation,
      ...(finalMultiViewContract && canonicalFrame ? {
        multiViewObservation: finalMultiViewContract,
        sourceGroupKey,
        frameSelection: { sourceId: canonicalFrame.sourceId, aspectRatio: aspectRatios[canonicalFrame.sourceId] ?? null, registrations: registerGroundViews(finalMultiViewContract, canonicalFrame).map((registration) => ({
          sourceId: registration.sourceId,
          registered: registration.registered,
          ...(registration.registered ? { planeId: registration.planeId, inlierPointIds: registration.inlierPointIds, medianNormalizedCoordinateResidual: registration.medianNormalizedCoordinateResidual } : { reason: registration.reason }),
        })) },
      } : {}),
      ...(spatialReviewMetadata ? { spatialReview: spatialReviewMetadata } : {}),
    });
    return normalizedDraft;
  } catch (error) {
    recordLayoutGenerationFailed(generationId, error instanceof ImageObservationValidationError ? `${error.kind}-error` : "invalid-structure");
    throw error;
  }
}

export function readReferenceImageFile(file: File): Promise<ReferenceLayoutImage> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) {
      reject(new Error("仅支持 PNG、JPG 或 WebP 图片"));
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      reject(new Error("参考图不能超过 12 MB"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败，请重新选择"));
    reader.onload = () => resolve({
      sourceId: `local_${crypto.randomUUID()}`,
      fileName: file.name,
      url: String(reader.result || ""),
      origin: "local",
    });
    reader.readAsDataURL(file);
  });
}
