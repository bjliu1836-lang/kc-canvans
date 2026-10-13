// @ts-expect-error Vitest executes this asset-drift check in Node; the app build intentionally omits Node globals.
import { readFile } from "node:fs/promises";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { MANNEQUIN_POSE_PRESETS } from "../../presets/mannequinPosePresets";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import {
  UE4_MANNEQUIN_BONE_MAP,
  UE4_MANNEQUIN_MODEL_URL,
  getUE4GroundedLabelY,
  getUE4BodyBoneScales,
  getUE4ModelScale,
  getUE4NeutralPoseBoneRotations,
  getUE4PoseBoneRotations,
  getUE4SeatedPelvisSupportHeight,
  resolveDirectorAssetUrl,
} from "./ue4MannequinRig";

declare const process: { cwd(): string };

async function measureSeatedPelvisSupportHeight(bodyType: CharacterBodyType) {
  const bytes = await readFile(`${process.cwd()}/public/models/ue-mannequin-retopology.glb`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/, ""),
  ) as {
    scene?: number;
    scenes: Array<{ nodes?: number[] }>;
    nodes: Array<{
      name?: string;
      children?: number[];
      translation?: [number, number, number];
      rotation?: [number, number, number, number];
      scale?: [number, number, number];
      matrix?: number[];
    }>;
  };
  const nodes = json.nodes.map((node, index) => {
    const object = new Object3D();
    object.name = (node.name ?? String(index)).replace(/ /g, "_");
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
    if (node.matrix) object.matrix.fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
    return object;
  });
  json.nodes.forEach((node, index) => node.children?.forEach((child) => nodes[index].add(nodes[child])));
  const root = new Object3D();
  json.scenes[json.scene ?? 0].nodes?.forEach((node) => root.add(nodes[node]));
  const byName = (name: string) => {
    const object = nodes.find((node) => node.name === name);
    if (!object) throw new Error(`内置 UE4 素体缺少骨骼 ${name}`);
    return object;
  };

  const bodyScales = getUE4BodyBoneScales(bodyType);
  Object.entries(bodyScales).forEach(([name, scale]) => byName(name).scale.multiply(new Vector3(...scale)));
  const sitControls = MANNEQUIN_POSE_PRESETS.find((preset) => preset.id === "sit")?.controls;
  if (!sitControls) throw new Error("缺少 sit 姿态预设");
  const poseRotations = getUE4PoseBoneRotations(sitControls, bodyType);
  Object.entries(poseRotations).forEach(([name, rotation]) => {
    byName(name).quaternion.multiply(new Quaternion().setFromEuler(new Euler(...rotation)));
  });
  root.updateMatrixWorld(true);

  const pelvisY = byName(UE4_MANNEQUIN_BONE_MAP.body).getWorldPosition(new Vector3()).y;
  const leftFootY = byName(UE4_MANNEQUIN_BONE_MAP.leftFoot).getWorldPosition(new Vector3()).y;
  const rightFootY = byName(UE4_MANNEQUIN_BONE_MAP.rightFoot).getWorldPosition(new Vector3()).y;
  return (pelvisY - Math.min(leftFootY, rightFootY)) * getUE4ModelScale(bodyType)[1];
}

it("points to the built-in rigged GLB asset", () => {
  expect(UE4_MANNEQUIN_MODEL_URL).toBe(resolveDirectorAssetUrl(import.meta.env.BASE_URL, "models/ue-mannequin-retopology.glb"));
});

it("resolves the built-in rigged GLB below the embedded director desk base path", () => {
  expect(resolveDirectorAssetUrl("/director-desk/", "models/ue-mannequin-retopology.glb")).toBe(
    "/director-desk/models/ue-mannequin-retopology.glb"
  );
  expect(resolveDirectorAssetUrl("./", "models/ue-mannequin-retopology.glb")).toBe(
    "./models/ue-mannequin-retopology.glb"
  );
});

it("defines the core retopology mannequin bones used by body shapes and pose presets", () => {
  expect(UE4_MANNEQUIN_BONE_MAP).toMatchObject({
    body: "Bip001_Pelvis_03",
    torso: "Bip001_Spine1_05",
    head: "Bip001_Head_055",
    leftShoulder: "Bip001_L_UpperArm_08",
    rightShoulder: "Bip001_R_UpperArm_032",
    leftElbow: "Bip001_L_Forearm_09",
    rightElbow: "Bip001_R_Forearm_033",
    leftHand: "Bip001_L_Hand_010",
    rightHand: "Bip001_R_Hand_034",
    leftHip: "Bip001_L_Thigh_057",
    rightHip: "Bip001_R_Thigh_061",
    leftKnee: "Bip001_L_Calf_058",
    rightKnee: "Bip001_R_Calf_062",
    leftFoot: "Bip001_L_Foot_059",
    rightFoot: "Bip001_R_Foot_063",
  });
});

it("derives visible body silhouettes from one rigged mannequin", () => {
  const adult = getUE4BodyBoneScales("mannequin");
  const female = getUE4BodyBoneScales("female");
  const child = getUE4BodyBoneScales("child");
  const chibi = getUE4BodyBoneScales("chibi");

  expect(adult.Bip001_Spine1_05[1]).toBeGreaterThan(female.Bip001_Spine1_05[1]);
  expect(female.Bip001_Pelvis_03[1]).toBeGreaterThan(adult.Bip001_Pelvis_03[1]);
  expect(child.Bip001_Head_055[0]).toBeGreaterThan(adult.Bip001_Head_055[0]);
  expect(chibi.Bip001_Head_055[0]).toBeGreaterThan(child.Bip001_Head_055[0]);
  expect(getUE4ModelScale("chibi")[1]).toBeLessThan(getUE4ModelScale("mannequin")[1]);
});

it("counter-scales chibi hands so the shortened forearms still leave visible palms", () => {
  const chibi = getUE4BodyBoneScales("chibi");

  expect(chibi.Bip001_L_Hand_010).toEqual(chibi.Bip001_R_Hand_034);
  expect(chibi.Bip001_L_Hand_010[0]).toBeGreaterThan(1.2);
  expect(chibi.Bip001_L_Forearm_09[0] * chibi.Bip001_L_Hand_010[0]).toBeGreaterThanOrEqual(0.88);
  expect(chibi.Bip001_L_Forearm_09[1] * chibi.Bip001_L_Hand_010[1]).toBeGreaterThanOrEqual(0.9);
  expect(chibi.Bip001_L_Forearm_09[2] * chibi.Bip001_L_Hand_010[2]).toBeGreaterThanOrEqual(0.9);
});

it("keeps chibi shoulder anchors outside the rounded torso so hands are not hidden", () => {
  const chibi = getUE4BodyBoneScales("chibi");

  expect(chibi.Bip001_L_Clavicle_07).toEqual(chibi.Bip001_R_Clavicle_031);
  expect(chibi.Bip001_L_Clavicle_07[0]).toBeGreaterThanOrEqual(chibi.Bip001_Pelvis_03[1]);
});

it("keeps the retopology mannequin adult arms at the authored natural length", () => {
  const adult = getUE4BodyBoneScales("mannequin");
  const broad = getUE4BodyBoneScales("broad");
  const muscular = getUE4BodyBoneScales("muscular");

  expect(adult.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
  expect(adult.Bip001_R_UpperArm_032[0]).toBeCloseTo(1);
  expect(adult.Bip001_L_Forearm_09[0]).toBeCloseTo(1);
  expect(adult.Bip001_R_Forearm_033[0]).toBeCloseTo(1);
  expect(broad.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
  expect(muscular.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
});

it("keeps role labels above the retopology GLB body", () => {
  expect(getUE4GroundedLabelY("mannequin")).toBeGreaterThan(1.8);
  expect(getUE4GroundedLabelY("mannequin")).toBeLessThan(2.3);
  expect(getUE4GroundedLabelY("teen")).toBeLessThan(getUE4GroundedLabelY("mannequin"));
  expect(getUE4GroundedLabelY("chibi")).toBeLessThan(getUE4GroundedLabelY("child"));
});

it("keeps seated support anchors calibrated to the bundled GLB skeleton and sit controls", async () => {
  await Promise.all((["mannequin", "female"] as const).map(async (bodyType) => {
    expect(getUE4SeatedPelvisSupportHeight(bodyType)).toBeCloseTo(
      await measureSeatedPelvisSupportHeight(bodyType),
      3,
    );
  }));
});

it("maps existing director pose controls to retopology Bip001 bone rotations", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "body.pitch": -30,
      "torso.pitch": -18,
      "head.pitch": 18,
      "head.yaw": 20,
      "rightShoulder.pitch": 56,
      "leftShoulder.spread": -30,
      "rightShoulder.spread": 30,
      "rightElbow.bend": 80,
      "leftHip.pitch": -18,
      "rightHip.pitch": 24,
      "leftHip.spread": -12,
      "rightHip.spread": 12,
      "rightKnee.bend": 42,
    },
    "mannequin"
  );

  expect(rotations.Bip001_Head_055[0]).toBeGreaterThan(0);
  expect(rotations.Bip001_Head_055[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_Pelvis_03[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_Spine1_05[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_UpperArm_032[2]).toBeLessThan(0);
  expect(rotations.Bip001_L_UpperArm_08[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_UpperArm_032[1]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_Forearm_033[0]).toBeCloseTo(0);
  expect(rotations.Bip001_R_Forearm_033[2]).toBeLessThan(0);
  expect(rotations.Bip001_L_Thigh_057[2]).toBeLessThan(0);
  expect(rotations.Bip001_R_Thigh_061[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_L_Thigh_057[1]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_Thigh_061[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_Calf_062[0]).toBeCloseTo(0);
  expect(rotations.Bip001_R_Calf_062[2]).toBeLessThan(0);
});

it("lets adult UE4 knee bones reach seiza flexion without relaxing other joint limits", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftKnee.bend": 142,
      "rightKnee.bend": 200,
      "leftElbow.bend": 142,
    },
    "female",
  );

  expect(rotations.Bip001_L_Calf_058[2]).toBeCloseTo((-142 * Math.PI) / 180);
  expect(rotations.Bip001_R_Calf_062[2]).toBeCloseTo((-165 * Math.PI) / 180);
  expect(rotations.Bip001_L_Forearm_09[2]).toBeCloseTo((-90 * Math.PI) / 180);

  const compact = getUE4PoseBoneRotations({ "leftKnee.bend": 142 }, "chibi");
  expect(compact.Bip001_L_Calf_058[2]).toBeCloseTo((-58 * Math.PI) / 180);
});

it("keeps the existing 90 degree sit knee rotation unchanged", () => {
  const sit = MANNEQUIN_POSE_PRESETS.find((preset) => preset.id === "sit");
  if (!sit) throw new Error("缺少 sit 姿态预设");

  const rotations = getUE4PoseBoneRotations(sit.controls, "female");
  expect(rotations.Bip001_L_Calf_058[2]).toBeCloseTo(-Math.PI / 2);
  expect(rotations.Bip001_R_Calf_062[2]).toBeCloseTo(-Math.PI / 2);
});

it("maps foot pitch controls for grounded kneel and lunge poses", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftFoot.pitch": 58,
      "rightFoot.pitch": 45,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_Foot_059[2]).toBeCloseTo((58 * Math.PI) / 180);
  expect(rotations.Bip001_R_Foot_063[2]).toBeCloseTo((45 * Math.PI) / 180);
});

it("maps hand roll controls so pose presets can orient palms without changing the arm IK target", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftHand.roll": -35,
      "rightHand.roll": 35,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_Hand_010[1]).toBeCloseTo((-35 * Math.PI) / 180);
  expect(rotations.Bip001_R_Hand_034[1]).toBeCloseTo((35 * Math.PI) / 180);
});

it("maps T-pose arm spread so both retopology arms open outward", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftShoulder.spread": -90,
      "rightShoulder.spread": 90,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_UpperArm_08[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_UpperArm_032[1]).toBeGreaterThan(0);
});

it("calibrates the retopology neutral stance so both hands hang beside the thighs", () => {
  const rotations = getUE4NeutralPoseBoneRotations();

  expect(rotations.Bip001_L_UpperArm_08).toEqual([0, (25 * Math.PI) / 180, 0]);
  expect(rotations.Bip001_R_UpperArm_032).toEqual([0, (-25 * Math.PI) / 180, 0]);
  expect(rotations.Bip001_L_Forearm_09).toEqual([0, 0, (25 * Math.PI) / 180]);
  expect(rotations.Bip001_R_Forearm_033).toEqual([0, 0, (25 * Math.PI) / 180]);
});
