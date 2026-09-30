import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { getCameraPlaybackSnapshot } from "../schema/cameraPlayback";
import { MotionStudio } from "./MotionStudio";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    motionStudioOpen: true,
    cameraPilotMode: "idle",
  });
});

it("presents a beginner-friendly shooting workflow with the final key bindings", () => {
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("region", { name: "运镜工作台" })).toBeInTheDocument();
  expect(screen.getByText(/无需摆放机位/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "播放检查路线" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "播放镜头画面" })).toBeInTheDocument();
  expect(screen.getByText("跟着人物走")).toBeInTheDocument();
  expect(screen.getByText("靠近人物")).toBeInTheDocument();
  expect(screen.getByText("环绕人物")).toBeInTheDocument();
  expect(screen.getByText("空格")).toBeInTheDocument();
  expect(screen.getByText("E")).toBeInTheDocument();
  expect(screen.getByText("上升")).toBeInTheDocument();
  expect(screen.getByText("Q")).toBeInTheDocument();
  expect(screen.getByText("下降")).toBeInTheDocument();
  expect(screen.getByText("播放 / 暂停人物")).toBeInTheDocument();
  expect(screen.queryByText("Shift")).not.toBeInTheDocument();
  expect(screen.queryByText("自由录制")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("录制轨迹还原程度")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "锁定后只保持看向主体" })).toHaveAttribute("aria-pressed", "true");
  const advancedSections = document.querySelectorAll('details[aria-label="高级调整"]');
  expect(advancedSections).toHaveLength(2);
  advancedSections.forEach((section) => expect(section).not.toHaveAttribute("open"));
});

it("plays the completed move from the camera first-person view", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8],
    target: [0, 1, 0],
    fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [3, 2, 4],
    target: [0, 1, 0],
    fov: 42,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "播放镜头画面" }));

  expect(useDirectorStore.getState().viewMode).toBe("camera");
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
});

it("uses the fixed current camera when a character has a route", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  const routePreview = screen.getByRole("button", { name: "播放检查路线" });
  const finishedPreview = screen.getByRole("button", { name: "播放镜头画面" });
  expect(routePreview).toBeDisabled();
  expect(finishedPreview).toBeEnabled();
  expect(screen.getByText("固定机位已就绪：可直接看镜头画面和导出 MP4；添加 2 个镜头点后可检查路线。")).toBeInTheDocument();

  await user.click(finishedPreview);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
  expect(useDirectorStore.getState().viewMode).toBe("camera");
});

it("applies close framing to a fixed camera's real playback view and clears a stale FOV override", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({ ...state, finishedShotFov: 36 });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  const originalKeyframe = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[0];
  expect(originalKeyframe).toBeDefined();
  useDirectorStore.getState().updateCameraMotionKeyframe("cam_1", originalKeyframe!.id, {
    targetMode: "object",
    targetObjectId: "char_default_a",
    targetBodyPart: "chest",
  });
  const beforeCamera = useDirectorStore.getState().project.cameras[0];
  const beforeView = getCameraPlaybackSnapshot(beforeCamera, useDirectorStore.getState().project.objects, 0);
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await waitFor(() => expect(screen.getByRole("combobox", { name: "镜头预设跟踪主体" })).toHaveValue("char_default_a"));
  await user.click(within(screen.getByRole("group", { name: "镜头景别" })).getByRole("button", { name: "特写" }));

  const afterCamera = useDirectorStore.getState().project.cameras[0];
  const afterView = getCameraPlaybackSnapshot(afterCamera, useDirectorStore.getState().project.objects, 0);
  const beforeDistance = Math.hypot(...beforeView.position.map((value, axis) => value - beforeView.target[axis]));
  const afterDistance = Math.hypot(...afterView.position.map((value, axis) => value - afterView.target[axis]));
  expect(afterDistance).toBeLessThan(beforeDistance);
  expect(afterCamera.motionPath?.keyframes).toHaveLength(1);
  expect(afterCamera.targetMode).toBe("manual");
  expect(afterCamera.motionPath?.keyframes[0]).toMatchObject({
    id: originalKeyframe!.id,
    targetMode: "object",
    targetObjectId: "char_default_a",
    targetBodyPart: "head",
  });
  expect(getCameraPlaybackSnapshot(
    afterCamera,
    useDirectorStore.getState().project.objects,
    0,
    undefined,
    (_object, bodyPart) => bodyPart === "head" ? [0, 3, 0] : [0, 1, 0]
  ).target).toEqual([0, 3, 0]);
  expect(useDirectorStore.getState().finishedShotFov).toBeNull();
});

it("automatically creates a hidden motion camera when the scene has no placed camera", async () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      cameras: [],
      activeCameraId: null,
      objects: state.project.objects.filter((item) => item.kind !== "camera"),
    },
  });

  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [5, 3, 2], target: [0, 1, 0], fov: 46 })} />);

  await waitFor(() => expect(screen.getByRole("region", { name: "运镜工作台" })).toBeInTheDocument());
  const nextState = useDirectorStore.getState();
  expect(nextState.project.cameras).toHaveLength(1);
  expect(nextState.project.cameras[0]).toMatchObject({
    name: "自动运镜镜头",
    isVirtual: true,
    fov: 46,
    target: [0, 1, 0],
  });
  expect(nextState.project.objects.some((item) => item.kind === "camera")).toBe(false);
  expect(nextState.project.activeCameraId).toBe(nextState.project.cameras[0].id);
});

it("starts pilot mode and records the current view as a numbered waypoint", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [3, 2, 7], target: [0, 1, 0], fov: 44 })} />);

  await user.click(screen.getByRole("button", { name: "开始掌镜" }));
  expect(useDirectorStore.getState().cameraPilotMode).toBe("pilot");

  useDirectorStore.getState().stopCameraPilot();
  await user.click(screen.getByRole("button", { name: "添加当前视角为轨迹点" }));

  expect(screen.getByRole("button", { name: "选择轨迹点 1" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[0]).toMatchObject({
    position: [3, 2, 7],
    target: [0, 1, 0],
    fov: 44,
  });
});

it("hands pilot startup to the viewport so pointer lock can be requested in the click gesture", async () => {
  const user = userEvent.setup();
  const onStartPilot = vi.fn();
  render(
    <MotionStudio
      getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })}
      onStartPilot={onStartPilot}
    />
  );

  await user.click(screen.getByRole("button", { name: "开始掌镜" }));

  expect(onStartPilot).toHaveBeenCalledWith(null);
});

it("keeps character controls in the dedicated bottom transport instead of duplicating them", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
    cameraMotionProgress: 0.4,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.queryByRole("slider", { name: "全局动作时间轴" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /记录角色01在当前时间的位置/ })).not.toBeInTheDocument();
});

it("keeps reached and approaching waypoint states visible while route preview is paused", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    cameraMotionPlaying: false,
    cameraMotionProgress: 0.5,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "smooth",
          easing: "ease-in-out",
          keyframes: [
            { id: "paused_point_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "paused_point_2", time: 0.5, position: [3, 2, 5], target: [0, 1, 0], fov: 46 },
            { id: "paused_point_3", time: 1, position: [5, 2, 2], target: [0, 1, 0], fov: 42 },
          ],
        },
      })),
    },
  });

  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("button", { name: "选择轨迹点 1" })).toHaveClass("is-reached");
  expect(screen.getByRole("button", { name: "选择轨迹点 2" })).toHaveClass("is-reached");
  expect(screen.getByRole("button", { name: "选择轨迹点 3" })).toHaveClass("is-approaching");
});

it("inserts a new waypoint from the plus button between two route points", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [6, 2, 2], target: [0, 1, 0], fov: 40,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "在轨迹点 1 和 2 之间插入轨迹点" }));

  expect(screen.getByRole("button", { name: "选择轨迹点 3" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toHaveLength(3);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.5);
});

it("supports visible arbitrary multi-selection for moving points 1, 3, and 6 together", async () => {
  const user = userEvent.setup();
  for (let index = 0; index < 6; index += 1) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
      position: [index, 2, 8 - index], target: [0, 1, 0], fov: 50,
    });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "批量选择并移动轨迹点" }));
  await user.click(screen.getByRole("button", { name: "清空轨迹点选择" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 1" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 3" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 6" }));

  const keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(useDirectorStore.getState().selectedCameraKeyframeIds).toEqual([
    keyframes[0].id,
    keyframes[2].id,
    keyframes[5].id,
  ]);
  expect(screen.getByText("已选 3 个点")).toBeInTheDocument();
});

it("lets every waypoint choose its own moving tracking target", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [3, 2, 4], target: [0, 1, 0], fov: 44,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "选择轨迹点 1" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");

  let keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[0]).toMatchObject({
    targetMode: "object",
    targetObjectId: "char_default_a",
    targetBodyPart: "chest",
    targetFollowMode: "immediate",
  });
  expect(keyframes[1]).toMatchObject({ targetMode: "manual" });
  expect(screen.getByText("这个点会实时看向所选主体")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "轨迹点跟踪身体部位" })).toHaveValue("chest");

  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪身体部位" }), "rightHand");
  await user.click(within(screen.getByRole("group", { name: "轨迹点跟随响应速度" })).getByRole("button", { name: "柔和" }));
  await user.click(within(screen.getByRole("group", { name: "镜头跟踪抖动" })).getByRole("button", { name: "开启防抖" }));
  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[0]).toMatchObject({
    targetBodyPart: "rightHand",
    targetFollowMode: "smooth",
    targetStabilizationEnabled: true,
  });

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  expect(screen.getByRole("combobox", { name: "轨迹点跟踪主体" })).toHaveValue("");
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");

  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[1]).toMatchObject({ targetMode: "object", targetObjectId: "char_default_a" });
});

it("applies a motion parameter preset without replacing route points", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [4, 2, 4], target: [0, 1, 0], fov: 42,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.selectOptions(screen.getByRole("combobox", { name: "运镜参数预设" }), "fast-follow");

  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path).toMatchObject({ duration: 3, interpolation: "smooth", easing: "linear" });
  expect(path?.keyframes).toHaveLength(2);
});

it("generates an editable camera route that follows the selected character", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("combobox", { name: "镜头预设跟踪主体" })).toHaveValue("char_default_a");
  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));

  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path?.keyframes).toHaveLength(3);
  expect(path?.keyframes.every((keyframe) => (
    keyframe.targetMode === "object" && keyframe.targetObjectId === "char_default_a"
  ))).toBe(true);
  expect(useDirectorStore.getState().selectedCameraKeyframeId).toBe(path?.keyframes[0].id);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0);
});

it("keeps non-character template targets centered at every framing", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  const character = state.project.objects.find((object) => object.id === "char_default_a")!;
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      objects: [...state.project.objects, {
        ...character,
        id: "prop_focus",
        name: "道具",
        kind: "prop",
        characterRig: undefined,
      }],
    },
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.selectOptions(screen.getByRole("combobox", { name: "镜头预设跟踪主体" }), "prop_focus");
  await user.click(within(screen.getByRole("group", { name: "镜头景别" })).getByRole("button", { name: "特写" }));
  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes.every((keyframe) => (
    keyframe.targetObjectId === "prop_focus" && keyframe.targetBodyPart === "center"
  ))).toBe(true);
});

it("restores the unique-character template default after a project switch without overriding a same-scene center choice", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  const target = screen.getByRole("combobox", { name: "镜头预设跟踪主体" });
  await waitFor(() => expect(target).toHaveValue("char_default_a"));
  await user.selectOptions(target, "");
  expect(target).toHaveValue("");

  const nextProject = JSON.parse(JSON.stringify(useDirectorStore.getState().project));
  useDirectorStore.getState().replaceProject(nextProject);

  await waitFor(() => expect(target).toHaveValue("char_default_a"));
});

it("keeps an explicitly selected focus target ahead of the single-character default", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    selectedObjectId: "prop_focus",
    selectedObjectIds: ["prop_focus"],
    project: {
      ...state.project,
      objects: [...state.project.objects, {
        id: "prop_focus",
        name: "道具01",
        kind: "prop" as const,
        visible: true,
        locked: false,
        transform: { position: [2, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
      }],
    },
  });

  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("combobox", { name: "镜头预设跟踪主体" })).toHaveValue("prop_focus");
});

it("keeps less common presets under more cameras and shows their contribution metadata", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.queryByRole("button", { name: "套用平行跟拍镜头预设" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "更多镜头" }));
  expect(screen.queryByRole("button", { name: "套用推镜镜头预设" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "套用平行跟拍镜头预设" }));

  const metadata = screen.getByRole("group", { name: "群友预设资料" });
  expect(metadata).toHaveTextContent("平行跟拍 · v1.0.0");
  expect(metadata).toHaveTextContent("贡献者：AIGC 耀光");
  expect(metadata).toHaveTextContent("联系：抖音号：AIJPDM001");
  expect(metadata).toHaveTextContent("适合：人物行进、车辆侧拍");
  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path?.keyframes.every((point) => point.targetObjectId === "char_default_a")).toBe(true);
});

it("scales the generated camera route without changing the tracked subject", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "更多镜头" }));
  await user.click(screen.getByRole("button", { name: "套用左移镜镜头预设" }));
  const smallPath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const smallTravel = Math.abs(smallPath.keyframes[2].position[0] - smallPath.keyframes[0].position[0]);

  const range = screen.getByRole("slider", { name: "镜头预设运动幅度" });
  fireEvent.change(range, { target: { value: "3" } });
  const largePath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const largeTravel = Math.abs(largePath.keyframes[2].position[0] - largePath.keyframes[0].position[0]);

  expect(largeTravel).toBeGreaterThan(smallTravel * 2);
  expect(largePath.keyframes.every((keyframe) => keyframe.targetObjectId === "char_default_a")).toBe(true);
  expect(screen.getByRole("button", { name: "套用左移镜镜头预设" })).toHaveAttribute("aria-pressed", "true");
});

it("updates a community preset route immediately while its range slider moves", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "更多镜头" }));
  await user.click(screen.getByRole("button", { name: "套用平行跟拍镜头预设" }));
  const smallPath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const smallTravel = Math.hypot(
    smallPath.keyframes[2].position[0] - smallPath.keyframes[0].position[0],
    smallPath.keyframes[2].position[1] - smallPath.keyframes[0].position[1],
    smallPath.keyframes[2].position[2] - smallPath.keyframes[0].position[2],
  );

  fireEvent.change(screen.getByRole("slider", { name: "镜头预设运动幅度" }), { target: { value: "2.5" } });
  const largePath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const largeTravel = Math.hypot(
    largePath.keyframes[2].position[0] - largePath.keyframes[0].position[0],
    largePath.keyframes[2].position[1] - largePath.keyframes[0].position[1],
    largePath.keyframes[2].position[2] - largePath.keyframes[0].position[2],
  );

  expect(largeTravel).toBeGreaterThan(smallTravel * 2);
  expect(screen.getByText("250%")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "套用平行跟拍镜头预设" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps hand-edited template routes when replacement is cancelled", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));
  const firstPoint = useDirectorStore.getState().project.cameras[0].motionPath!.keyframes[0];
  useDirectorStore.getState().updateCameraMotionKeyframe("cam_1", firstPoint.id, { position: [9, 2, 8] });
  const routeBeforeReplacement = JSON.stringify(useDirectorStore.getState().project.cameras[0].motionPath);
  const selectedPointBeforeReplacement = useDirectorStore.getState().selectedCameraKeyframeId;
  await waitFor(() => expect(screen.getByText(/已保留手工路线/)).toBeInTheDocument());

  fireEvent.change(screen.getByRole("slider", { name: "镜头预设运动幅度" }), { target: { value: "2" } });
  expect(JSON.stringify(useDirectorStore.getState().project.cameras[0].motionPath)).toBe(routeBeforeReplacement);

  await user.click(screen.getByRole("button", { name: "套用跟拍镜头预设" }));
  expect(screen.getByRole("alert")).toHaveTextContent("这会替换已手工调整的镜头路线。");
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(JSON.stringify(useDirectorStore.getState().project.cameras[0].motionPath)).toBe(routeBeforeReplacement);
  expect(useDirectorStore.getState().selectedCameraKeyframeId).toBe(selectedPointBeforeReplacement);
});

it("clears a pending template replacement and selected template when switching cameras", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  const firstCamera = state.project.cameras[0];
  const secondCamera = {
    ...firstCamera,
    id: "cam_2",
    name: "机位02",
    motionPath: undefined,
  };
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      cameras: [firstCamera, secondCamera],
      activeCameraId: firstCamera.id,
    },
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));
  const firstPoint = useDirectorStore.getState().project.cameras[0].motionPath!.keyframes[0];
  useDirectorStore.getState().updateCameraMotionKeyframe(firstCamera.id, firstPoint.id, { position: [9, 2, 8] });
  await user.click(screen.getByRole("button", { name: "套用跟拍镜头预设" }));
  expect(screen.getByRole("alert")).toHaveTextContent("这会替换已手工调整的镜头路线。");

  useDirectorStore.setState((current) => ({
    ...current,
    project: {
      ...current.project,
      activeCameraId: secondCamera.id,
    },
  }));

  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "套用推镜镜头预设" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "套用跟拍镜头预设" })).toHaveAttribute("aria-pressed", "false");
});

it("enables stabilization for tracked route points while keeping per-waypoint overrides", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  const routeStabilization = screen.getByRole("group", { name: "整条镜头路线防抖" });
  expect(within(routeStabilization).getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.getByText("先为轨迹点选择跟踪主体，防抖才会生效")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "选择轨迹点 1" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");
  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");
  await user.click(within(routeStabilization).getByRole("button", { name: "全部开启" }));
  let keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes.map((keyframe) => keyframe.targetStabilizationEnabled)).toEqual([true, true, false]);
  expect(screen.getByText("已开启 2 / 2 个跟踪点，仍可逐点修改")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  await user.click(within(screen.getByRole("group", { name: "镜头跟踪抖动" })).getByRole("button", { name: "保留抖动" }));
  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes.map((keyframe) => keyframe.targetStabilizationEnabled)).toEqual([true, false, false]);
  expect(screen.getByText("已开启 1 / 2 个跟踪点，仍可逐点修改")).toBeInTheDocument();
});

it("lets users retime an individual middle waypoint to control segment speed", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "自定义" }));
  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  const arrival = screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" });
  await user.clear(arrival);
  await user.type(arrival, "4");
  await user.tab();

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[1].time).toBeCloseTo(4 / 6);
});

it("offers uniform soft and custom timing plus an explicit waypoint hold", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "匀速" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.speedMode).toBe("uniform");
  await user.click(screen.getByRole("button", { name: "柔和" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.speedMode).toBe("soft");

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  expect(screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "停留" }));
  const hold = screen.getByRole("slider", { name: "轨迹点停留时长" });
  fireEvent.change(hold, { target: { value: "1.4" } });

  const point = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[1];
  expect(point).toMatchObject({ pointBehavior: "hold", holdSeconds: 1.4 });
  await user.click(screen.getByRole("button", { name: "自定义" }));
  expect(screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" })).toBeEnabled();
  const cameraEasing = screen.getByRole("group", { name: "镜头段内节奏" });
  await user.click(within(cameraEasing).getByRole("button", { name: "慢起" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.customEasing).toEqual([0.42, 0, 1, 1]);
  expect(within(cameraEasing).getByRole("button", { name: "慢起" })).toHaveAttribute("aria-pressed", "true");
});

it("seeks to the computed arrival when selecting a waypoint in automatic timing modes", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 10,
          loop: false,
          interpolation: "linear",
          easing: "linear",
          speedMode: "uniform",
          keyframes: [
            { id: "uniform_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "uniform_2", time: 0.5, position: [1, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "uniform_3", time: 1, position: [10, 2, 8], target: [0, 1, 0], fov: 50 },
          ],
        },
      })),
    },
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));

  expect(useDirectorStore.getState().cameraMotionProgress).toBeCloseTo(0.1, 4);
  expect(screen.getByRole("button", { name: "选择轨迹点 2" })).toHaveTextContent("1.0s");
});

it("shows a reference video export entry", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "导出运镜" }));
  expect(screen.getByRole("region", { name: "导出运镜设置" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "参考视频画质" })).toHaveValue("720p");
  expect(screen.getByRole("combobox", { name: "参考视频帧率" })).toHaveValue("30");
  expect(screen.getByRole("button", { name: "导出 MP4" })).toBeInTheDocument();
  expect(document.querySelector(".motion-export-background")).toHaveTextContent("将使用纯色背景：#5A5C60");
});

it("keeps a persisted black background until the director explicitly switches to the base export background", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().updateScene({ backgroundColor: "#000000", backgroundBrightness: 0 });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "导出运镜" }));
  expect(document.querySelector(".motion-export-background")).toHaveTextContent("将使用纯色背景：#000000");
  await user.click(screen.getByRole("button", { name: "使用基础背景" }));
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#5A5C60");
  expect(useDirectorStore.getState().project.scene.backgroundBrightness).toBe(1);
});
