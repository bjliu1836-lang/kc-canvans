import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

function LoadedAsset({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return (
    <Bounds fit clip observe margin={1.25}>
      <primitive object={scene} />
    </Bounds>
  );
}

export function GeneratedAssetPreview({ url }: { url: string }) {
  return (
    <div aria-label="生成模型预览" style={{ height: 240, overflow: "hidden", borderRadius: 8, background: "#101318" }}>
      <Canvas camera={{ position: [2.8, 2.2, 3.2], fov: 38 }}>
        <ambientLight intensity={1.1} />
        <directionalLight position={[3, 5, 4]} intensity={2} />
        <Suspense fallback={null}><LoadedAsset url={url} /></Suspense>
        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}
