import { describe, expect, it } from "vitest";
import {
  applyCameraFramingToPath,
  CAMERA_PATH_TEMPLATES,
  createCameraPathTemplate,
  getCameraPathTemplatesByGroup,
} from "./cameraPathTemplates";

const snapshot = { position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 };

describe("camera path templates", () => {
  it("provides all requested beginner camera moves", () => {
    expect(CAMERA_PATH_TEMPLATES.map((item) => item.label)).toEqual([
      "推镜", "拉镜", "左摇镜", "右摇镜", "俯仰抬镜", "俯拍压镜",
      "左移镜", "右移镜", "环绕摇臂升镜", "跟拍", "平行跟拍", "手持晃镜",
      "过肩绕正面", "近景半环绕", "环绕摇臂降镜", "低机位追拍", "俯视跟拍", "横移揭示",
    ]);
  });

  it("keeps community presets separate with complete contribution metadata", () => {
    expect(getCameraPathTemplatesByGroup("official").map((item) => item.label)).toEqual([
      "推镜", "拉镜", "左摇镜", "右摇镜", "俯仰抬镜", "俯拍压镜", "左移镜", "右移镜",
    ]);
    const community = getCameraPathTemplatesByGroup("community");
    expect(community.map((item) => item.label)).toEqual([
      "环绕摇臂升镜", "跟拍", "平行跟拍", "手持晃镜", "过肩绕正面",
      "近景半环绕", "环绕摇臂降镜", "低机位追拍", "俯视跟拍", "横移揭示",
    ]);
    for (const template of community) {
      expect(template.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(template.suitableFor).toBeTruthy();
      expect(template.contribution).toEqual(expect.objectContaining({
        contributorName: "AIGC 耀光",
        contact: "抖音号：AIJPDM001",
        sourceUrl: null,
        license: expect.any(String),
      }));
    }
  });

  it("keeps every preset id unique", () => {
    expect(new Set(CAMERA_PATH_TEMPLATES.map((item) => item.id)).size).toBe(CAMERA_PATH_TEMPLATES.length);
  });

  it("creates visible parallel motion even when tracking a fixed point", () => {
    const path = createCameraPathTemplate({
      cameraId: "cam",
      focusAt: () => [0, 1, 0],
      snapshot,
      templateId: "parallel-follow",
    });
    expect(new Set(path.keyframes.map((item) => item.position.join(","))).size).toBeGreaterThan(1);
  });

  it("generates an editable route that tracks the selected object per waypoint", () => {
    const path = createCameraPathTemplate({
      cameraId: "cam_1",
      focusAt: (progress) => [progress * 4, 1, 0],
      snapshot,
      targetObjectId: "char_1",
      templateId: "follow",
    });

    expect(path.keyframes).toHaveLength(3);
    expect(path.keyframes.map((item) => item.time)).toEqual([0, .5, 1]);
    expect(path.keyframes.every((item) => item.targetObjectId === "char_1" && item.targetMode === "object")).toBe(true);
    expect(path.keyframes[2].position[0]).toBeGreaterThan(path.keyframes[0].position[0]);
  });

  it("scales the spatial range of a generated push route", () => {
    const small = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: .5, templateId: "push-in" });
    const large = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: 2, templateId: "push-in" });
    const smallTravel = Math.abs(small.keyframes[0].position[2] - small.keyframes[2].position[2]);
    const largeTravel = Math.abs(large.keyframes[0].position[2] - large.keyframes[2].position[2]);

    expect(largeTravel).toBeGreaterThan(smallTravel * 3);
  });

  it("keeps community camera distance separate from motion amplitude", () => {
    for (const template of getCameraPathTemplatesByGroup("community")) {
      const small = createCameraPathTemplate({
        cameraId: "cam",
        focusAt: () => [0, 1, 0],
        snapshot,
        scale: 0.5,
        templateId: template.id,
      });
      const large = createCameraPathTemplate({
        cameraId: "cam",
        focusAt: () => [0, 1, 0],
        snapshot,
        scale: 2,
        templateId: template.id,
      });
      const smallMaximumDistance = Math.max(...small.keyframes.map((item) => Math.hypot(
        item.position[0],
        item.position[1] - 1,
        item.position[2],
      )));
      const largeMaximumDistance = Math.max(...large.keyframes.map((item) => Math.hypot(
        item.position[0],
        item.position[1] - 1,
        item.position[2],
      )));

      expect(largeMaximumDistance, template.label).toBeLessThan(smallMaximumDistance * 1.8);
    }

    const small = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: 0.5, templateId: "follow" });
    const large = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: 2, templateId: "follow" });
    const smallTravel = Math.abs(small.keyframes[2].position[2] - small.keyframes[0].position[2]);
    const largeTravel = Math.abs(large.keyframes[2].position[2] - large.keyframes[0].position[2]);
    expect(largeTravel).toBeGreaterThan(smallTravel * 3.5);
  });

  it("derives full-body framing from subject size instead of a high director view", () => {
    const highSnapshot = { position: [0, 80, 80] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 };
    const defaultView = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, subjectHeight: 2.6, templateId: "follow" });
    const highView = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot: highSnapshot, subjectHeight: 2.6, templateId: "follow" });
    const defaultDistance = Math.hypot(...defaultView.keyframes[1].position.map((value, axis) => value - [0, 1, 0][axis]));
    const highDistance = Math.hypot(...highView.keyframes[1].position.map((value, axis) => value - [0, 1, 0][axis]));
    expect(highDistance).toBeCloseTo(defaultDistance, 5);
  });

  it("brings close framing toward the target while preserving a hand route's timing and holds", () => {
    const full = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, framing: "full", subjectHeight: 2.6, templateId: "follow" });
    const close = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, framing: "close-up", subjectHeight: 2.6, templateId: "follow" });
    expect(Math.hypot(...close.keyframes[1].position.map((value, axis) => value - [0, 1, 0][axis]))).toBeLessThan(
      Math.hypot(...full.keyframes[1].position.map((value, axis) => value - [0, 1, 0][axis]))
    );

    const handRoute = {
      ...full,
      keyframes: full.keyframes.map((keyframe, index) => ({
        ...keyframe,
        pointBehavior: index === 1 ? "hold" as const : "pass" as const,
        holdSeconds: index === 1 ? 1.2 : 0,
      })),
    };
    const reframed = applyCameraFramingToPath({ framing: "medium", path: handRoute, subjectHeight: 2.6 });
    expect(reframed.keyframes.map((keyframe) => keyframe.id)).toEqual(handRoute.keyframes.map((keyframe) => keyframe.id));
    expect(reframed.keyframes.map((keyframe) => keyframe.time)).toEqual(handRoute.keyframes.map((keyframe) => keyframe.time));
    expect(reframed.keyframes[1]).toMatchObject({ pointBehavior: "hold", holdSeconds: 1.2 });
  });

  it("creates deterministic multi-point handheld motion", () => {
    const first = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, templateId: "handheld" });
    const second = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, templateId: "handheld" });

    expect(first).toEqual(second);
    expect(first.keyframes).toHaveLength(7);
    expect(new Set(first.keyframes.map((item) => item.position.join(","))).size).toBeGreaterThan(3);
  });
});
