import { readFileSync } from "node:fs";
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BODY_TYPE_OPTIONS } from "./mannequin/bodyTypes";
import { createLayoutCharacterRenderAdapter } from "../schema/layoutDraft";
import { alignUE4MannequinToGround, isolateAndTintUE4MannequinMaterials } from "./UE4MannequinModel";
import { getUE4ModelScale } from "./ue4Mannequin/ue4MannequinRig";
import { applyUE4RestPoseAndRig, captureUE4RestPose } from "./ue4Mannequin/ue4MannequinPoseApplication";

interface LoadedGLTF {
  scene: Group;
}

declare const process: {
  cwd: () => string;
};

async function loadRetopologyMannequin() {
  const binaryModel = readFileSync(`${process.cwd()}/public/models/ue-mannequin-retopology.glb`, "binary");
  const model = Uint8Array.from(binaryModel, (character) => character.charCodeAt(0));
  const arrayBuffer = new ArrayBuffer(model.byteLength);
  new Uint8Array(arrayBuffer).set(model);
  const loader = new GLTFLoader();

  return new Promise<LoadedGLTF>((resolve, reject) => {
    loader.parse(arrayBuffer, "", (gltf) => resolve(gltf as LoadedGLTF), reject);
  });
}

it("isolates cloned mannequin materials before tinting each character instance", () => {
  const sharedMaterial = new MeshStandardMaterial({ color: "#ffffff", name: "Body" });
  const firstModel = new Group();
  const secondModel = new Group();
  const firstMesh = new SkinnedMesh(new BoxGeometry(), sharedMaterial);
  const secondMesh = new SkinnedMesh(new BoxGeometry(), sharedMaterial);

  firstModel.add(firstMesh);
  secondModel.add(secondMesh);

  isolateAndTintUE4MannequinMaterials(firstModel, "#4F8EF7");
  isolateAndTintUE4MannequinMaterials(secondModel, "#E0524D");

  const firstMaterial = firstMesh.material as MeshStandardMaterial;
  const secondMaterial = secondMesh.material as MeshStandardMaterial;

  expect(firstMaterial).not.toBe(sharedMaterial);
  expect(secondMaterial).not.toBe(sharedMaterial);
  expect(firstMaterial).not.toBe(secondMaterial);
  expect(firstMaterial.color.getHexString()).toBe("4f8ef7");
  expect(secondMaterial.color.getHexString()).toBe("e0524d");
});

it("aligns the retopology mannequin root so the lowest visible geometry rests on the ground", () => {
  const scene = new Group();
  const footProbe = new Mesh(new BoxGeometry(0.2, 0.4, 0.2), new MeshStandardMaterial());
  footProbe.position.y = 0.35;
  scene.position.set(1.5, 4, -2);
  scene.add(footProbe);

  alignUE4MannequinToGround(scene);
  scene.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(scene, true);

  expect(scene.position.x).toBeCloseTo(1.5);
  expect(scene.position.z).toBeCloseTo(-2);
  expect(bounds.min.y).toBeCloseTo(0);
});

it("aligns in parent-local space when a body type wrapper scales the mannequin", () => {
  const wrapper = new Group();
  const scene = new Group();
  const footProbe = new Mesh(new BoxGeometry(0.2, 0.4, 0.2), new MeshStandardMaterial());
  footProbe.position.y = 0.35;
  wrapper.scale.set(0.56, 0.56, 0.56);
  wrapper.add(scene);
  scene.add(footProbe);
  wrapper.updateMatrixWorld(true);

  alignUE4MannequinToGround(scene);
  wrapper.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(wrapper, true);

  expect(bounds.min.y).toBeCloseTo(0);
});

it("keeps every real retopology body type grounded after right-panel style switching", async () => {
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  const gltf = await loadRetopologyMannequin();

  const wrapper = new Group();
  const scene = cloneSkeleton(gltf.scene) as Group;
  const restPose = captureUE4RestPose(scene);

  wrapper.add(scene);

  for (const option of BODY_TYPE_OPTIONS) {
    wrapper.scale.set(...getUE4ModelScale(option.bodyType));
    wrapper.updateMatrixWorld(true);

    applyUE4RestPoseAndRig(scene, {
      bodyType: option.bodyType,
      controls: {},
      restPose,
    });
    alignUE4MannequinToGround(scene);
    wrapper.updateMatrixWorld(true);

    const bounds = new Box3().setFromObject(wrapper, true);

    expect(bounds.min.y, option.label).toBeCloseTo(0, 4);
  }
});

it("grounds the real seiza mesh on the supplied cushion top through the layout adapter", async () => {
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  const gltf = await loadRetopologyMannequin();
  const adapter = createLayoutCharacterRenderAdapter({
    id: "char_seiza",
    name: "跪坐人物",
    position: [0.4, 0.12, -0.6],
    height: 1.62,
    rotationYDegrees: -45,
    posture: "kneel",
    kneelVariant: "seiza",
    handGesture: "prayer",
    bodyTypeHint: "female",
    confidence: 0.9,
    uncertain: false,
    visible: true,
  });
  const wrapper = new Group();
  const scene = cloneSkeleton(gltf.scene) as Group;
  const restPose = captureUE4RestPose(scene);
  wrapper.position.set(...adapter.transform.position);
  wrapper.rotation.set(...adapter.transform.rotation);
  wrapper.scale.set(...adapter.transform.scale);
  wrapper.add(scene);

  applyUE4RestPoseAndRig(scene, {
    bodyType: adapter.bodyType,
    controls: adapter.characterRig.controls,
    restPose,
  });
  alignUE4MannequinToGround(scene);
  wrapper.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(wrapper, true);
  const bonePosition = (name: string) => {
    const bone = scene.getObjectByName(name);
    if (!bone) throw new Error(`缺少骨骼 ${name}`);
    return bone.getWorldPosition(new Vector3());
  };
  const pelvis = bonePosition("Bip001_Pelvis_03");
  const leftKnee = bonePosition("Bip001_L_Calf_058");
  const rightKnee = bonePosition("Bip001_R_Calf_062");
  const leftFoot = bonePosition("Bip001_L_Foot_059");
  const rightFoot = bonePosition("Bip001_R_Foot_063");
  expect(bounds.min.y).toBeCloseTo(0.12, 4);
  expect(bounds.max.y - bounds.min.y).toBeLessThan(1.45);
  expect(leftKnee.y - bounds.min.y).toBeLessThan(0.25);
  expect(rightKnee.y - bounds.min.y).toBeLessThan(0.25);
  expect(Math.abs(leftKnee.y - rightKnee.y)).toBeLessThan(0.001);
  expect(pelvis.y - leftFoot.y).toBeLessThan(0.2);
  expect(pelvis.y - rightFoot.y).toBeLessThan(0.2);
  expect(Math.hypot(pelvis.x - leftFoot.x, pelvis.z - leftFoot.z)).toBeLessThan(0.12);
  expect(Math.hypot(pelvis.x - rightFoot.x, pelvis.z - rightFoot.z)).toBeLessThan(0.12);
});
