import type { DirectorCameraCaptureMetadata } from "../schema/directorProject";

export type ScreenshotMeta = DirectorCameraCaptureMetadata;

export interface ScreenshotResult {
  label: string;
  dataUrl: string;
  meta: ScreenshotMeta;
}

export function buildScreenshotMeta(input: ScreenshotMeta) {
  return input;
}

function formatNumber(value: number) {
  return Number(value.toFixed(1)).toString();
}

function getViewDirection(meta: ScreenshotMeta) {
  if (
    meta.viewDirection?.every((value) => Number.isFinite(value))
    && Math.hypot(...meta.viewDirection) > 0.000001
  ) {
    return meta.viewDirection;
  }

  const direction: [number, number, number] = [
    meta.target[0] - meta.position[0],
    meta.target[1] - meta.position[1],
    meta.target[2] - meta.position[2],
  ];
  const length = Math.hypot(...direction);
  return length > 0.000001
    ? direction.map((value) => value / length) as [number, number, number]
    : null;
}

export function getCameraOrientationDegrees(meta: ScreenshotMeta) {
  const direction = getViewDirection(meta);
  if (!direction) return null;

  const horizontalLength = Math.hypot(direction[0], direction[2]);
  return {
    yaw: Math.atan2(direction[0], direction[2]) * 180 / Math.PI,
    pitch: Math.atan2(direction[1], horizontalLength) * 180 / Math.PI,
  };
}

/** Builds a short local prompt from values recorded with the screenshot. */
export function buildCameraShotPrompt(meta: ScreenshotMeta) {
  const orientation = getCameraOrientationDegrees(meta);
  const parts = [
    "3D导演台镜头参考",
    meta.aspectRatio && meta.aspectRatio !== "auto" ? `画幅 ${meta.aspectRatio}` : null,
    `视野角 FOV ${formatNumber(meta.fov)}°`,
    orientation
      ? `相机朝向：水平 ${formatNumber(orientation.yaw)}°，俯仰 ${formatNumber(orientation.pitch)}°`
      : null,
    "保持当前构图与主体关系",
  ].filter((part): part is string => Boolean(part));

  return `${parts.join("，")}。`;
}

export function buildCaptureFileName(result: ScreenshotResult, index = 0) {
  const labelSlug = result.label.replace(/\s+/g, "-");
  const cameraSuffix = result.meta.cameraId ? `-${result.meta.cameraId}` : "";
  return `storyai-director-desk-${result.meta.mode}${cameraSuffix}-${labelSlug}-${index + 1}.png`;
}

export function downloadDataUrl(dataUrl: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
}

export function downloadCaptureResults(results: ScreenshotResult[]) {
  results.forEach((result, index) => {
    downloadDataUrl(result.dataUrl, buildCaptureFileName(result, index));
  });

  return results.length;
}
