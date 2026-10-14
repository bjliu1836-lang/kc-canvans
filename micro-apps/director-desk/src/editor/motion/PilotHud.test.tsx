import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { PilotHud, TakeReviewHud } from "./PilotHud";

it("shows Q/E lift controls, action playback shortcut, and an accessible crosshair", () => {
  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      onToggleRecording={() => undefined}
      pointedTargetName="角色01"
      recording={false}
      recordingSeconds={0}
    />
  );

  expect(screen.getByLabelText("掌镜准星，当前对准角色01")).toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("E 上升");
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("Q 下降");
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("空格 播放/暂停");
  expect(screen.getByLabelText("掌镜快捷键")).not.toHaveTextContent("Shift");
  expect(screen.queryByRole("button", { name: "播放人物" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("F 锁定主体");
  expect(screen.getByRole("button", { name: "记录当前轨迹点" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出掌镜模式" })).toBeInTheDocument();
});

it("makes empty space visibly lockable with F", () => {
  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      onToggleRecording={() => undefined}
      pointedTargetName={null}
      recording={false}
      recordingSeconds={0}
    />
  );

  expect(screen.getByLabelText("掌镜准星，按 F 锁定当前空间点")).toBeInTheDocument();
  expect(screen.getByText("空白空间 · 按 F 锁定")).toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("F 锁定主体 / 空间点");
});

it("keeps only exit and waypoint recording actions in the HUD", () => {
  const onExit = vi.fn();
  const onRecord = vi.fn();
  const onToggleRecording = vi.fn();

  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={onExit}
      onRecord={onRecord}
      onToggleRecording={onToggleRecording}
      pointedTargetName={null}
      recording={false}
      recordingSeconds={0}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "退出掌镜模式" }));
  fireEvent.click(screen.getByRole("button", { name: "记录当前轨迹点" }));
  expect(onExit).toHaveBeenCalledOnce();
  expect(onRecord).toHaveBeenCalledOnce();
});

it("shows a distinct start or stop take action without removing manual waypoints", () => {
  const onToggleRecording = vi.fn();
  const { rerender } = render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      onToggleRecording={onToggleRecording}
      pointedTargetName={null}
      recording={false}
      recordingSeconds={0}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "开始拍摄" }));
  expect(onToggleRecording).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "记录当前轨迹点" })).toBeEnabled();

  rerender(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      onToggleRecording={onToggleRecording}
      pointedTargetName={null}
      recording
      recordingSeconds={1.2}
    />
  );
  expect(screen.getByRole("button", { name: "结束拍摄" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "记录当前轨迹点" })).toBeDisabled();
});

it("keeps temporary take playback controls separate from keep, discard, and reshoot", () => {
  const onRestartPlayback = vi.fn();
  const onTogglePlayback = vi.fn();
  render(
    <TakeReviewHud
      duration={1.2}
      holdsLastFrame
      onDiscard={() => undefined}
      onKeep={() => undefined}
      onRestartPlayback={onRestartPlayback}
      onReshoot={() => undefined}
      onTogglePlayback={onTogglePlayback}
      playbackSeconds={0.4}
      playing
    />
  );

  expect(screen.getByRole("status")).toHaveTextContent("临时回放 0.4 / 1.2 秒");
  expect(screen.getByText("这次运镜尚未覆盖已保存路线。")).toBeInTheDocument();
  expect(screen.getByText("保留后，相机将在剩余表演中保持最后机位。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "从头回放这次拍摄" }));
  fireEvent.click(screen.getByRole("button", { name: "暂停这次拍摄回放" }));
  expect(onRestartPlayback).toHaveBeenCalledOnce();
  expect(onTogglePlayback).toHaveBeenCalledOnce();
});
