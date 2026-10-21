import { Suspense, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ImportedModelErrorBoundary, NormalizedImportedObject } from "../canvas/SceneRoot";

function LoadedAsset({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url);
  return (
    <Bounds fit clip observe margin={1.25}>
      <NormalizedImportedObject object={gltf.scene} />
    </Bounds>
  );
}

export function GeneratedAssetPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <div aria-label="生成模型预览" style={{ height: 240, overflow: "hidden", borderRadius: 8, background: "#101318" }}>
        <Canvas camera={{ position: [2.8, 2.2, 3.2], fov: 38 }}>
          <ambientLight intensity={1.1} />
          <directionalLight position={[3, 5, 4]} intensity={2} />
          <ImportedModelErrorBoundary fallback={<mesh name="unavailable-model-preview"><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial wireframe color="#D9A441" /></mesh>} onError={() => setFailed(true)}>
            <Suspense fallback={null}><LoadedAsset url={url} /></Suspense>
          </ImportedModelErrorBoundary>
          <OrbitControls makeDefault />
        </Canvas>
      </div>
      {failed ? <p className="reference-layout-diagnostic is-warning">模型文件无法预览，请保留简模或重新生成后再采用。</p> : null}
    </>
  );
}
