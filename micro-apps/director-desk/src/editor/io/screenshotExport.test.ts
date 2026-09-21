import { parseProject } from "./importProjectJson";
import { buildCameraShotPrompt, buildScreenshotMeta } from "./screenshotExport";
import { serializeProject } from "./exportProjectJson";
import { createDefaultDirectorProject } from "../store/directorStore";

it("captures the required metadata for camera-mode screenshots", () => {
  expect(
    buildScreenshotMeta({
      mode: "camera",
      cameraId: "cam_1",
      fov: 50,
      position: [0, 2.2, 9],
      target: [0, 1.2, 0],
    })
  ).toEqual({
    mode: "camera",
    cameraId: "cam_1",
    fov: 50,
    position: [0, 2.2, 9],
    target: [0, 1.2, 0],
  });
});

it("builds an editable shot prompt from the recorded camera direction", () => {
  expect(buildCameraShotPrompt({
    metadataVersion: 1,
    mode: "camera",
    cameraId: "cam_1",
    fov: 50,
    position: [0, 2.2, 9],
    target: [0, 1.2, 0],
    aspectRatio: "16:9",
    viewDirection: [0, -0.1104, -0.9939],
  })).toBe("3D导演台镜头参考，画幅 16:9，视野角 FOV 50°，相机朝向：水平 180°，俯仰 -6.3°，保持当前构图与主体关系。");
});

it("round-trips the project JSON without losing objects or cameras", () => {
  const json = serializeProject(createDefaultDirectorProject());
  const project = parseProject(json);

  expect(project.cameras[0].name).toBe("机位01");
  expect(project.objects.some((item) => item.kind === "character")).toBe(true);
});

it("round-trips capture-time camera metadata through project JSON", () => {
  const source = createDefaultDirectorProject();
  source.cameras[0]!.captures = [{
    id: "cam_1-capture-01",
    index: 1,
    name: "机位01-截图01",
    dataUrl: "data:image/png;base64,camera-preview",
    metadata: {
      metadataVersion: 1,
      mode: "camera",
      cameraId: "cam_1",
      cameraName: "机位01",
      fov: 42,
      position: [1, 2, 7],
      target: [0, 1, 0],
      aspectRatio: "16:9",
      viewDirection: [-0.1, -0.05, -0.99],
    },
  }];

  const project = parseProject(serializeProject(source));

  expect(project.cameras[0]?.captures?.[0]?.metadata).toEqual(source.cameras[0]?.captures?.[0]?.metadata);
});
