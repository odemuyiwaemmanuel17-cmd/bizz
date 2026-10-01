import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MutableRefObject, type ReactElement } from "react";
import { Canvas, useFrame, type ThreeEvent, type RootState } from "@react-three/fiber";
import { Float, MeshTransmissionMaterial, Environment, ContactShadows } from "@react-three/drei";
import * as THREE from "three";

interface BadgeProps {
  pointer: MutableRefObject<{ x: number; y: number }>;
  hovered: boolean;
  spinning: boolean;
  onToggleSpin: () => void;
  onHoverChange: (hovered: boolean) => void;
  accentHex: string;
}

/** Builds an extruded "H" monogram geometry (cached by accent color). */
function useHGeometry(accentHex: string): THREE.ExtrudeGeometry {
  return useMemo(() => {
    const shape: THREE.Shape = new THREE.Shape();
    // Stylised "H" drawn clockwise, centred at the origin.
    shape.moveTo(-0.75, -1);
    shape.lineTo(-0.4, -1);
    shape.lineTo(-0.4, -0.2);
    shape.lineTo(0.4, -0.2);
    shape.lineTo(0.4, -1);
    shape.lineTo(0.75, -1);
    shape.lineTo(0.75, 1);
    shape.lineTo(0.4, 1);
    shape.lineTo(0.4, 0.2);
    shape.lineTo(-0.4, 0.2);
    shape.lineTo(-0.4, 1);
    shape.lineTo(-0.75, 1);
    shape.closePath();

    const geometry: THREE.ExtrudeGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.35,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.06,
      bevelSegments: 6,
      curveSegments: 12,
    });
    geometry.center();
    return geometry;
  }, [accentHex]);
}

function Badge({ pointer, hovered, spinning, onToggleSpin, onHoverChange, accentHex }: BadgeProps): ReactElement {
  const groupRef: MutableRefObject<THREE.Group | null> = useRef<THREE.Group>(null);
  const ringRef: MutableRefObject<THREE.Mesh | null> = useRef<THREE.Mesh>(null);
  const geometry: THREE.ExtrudeGeometry = useHGeometry(accentHex);

  useFrame((_state: RootState, delta: number) => {
    const group: THREE.Group | null = groupRef.current;
    if (group !== null) {
      // Ease rotation toward the pointer position for a magnetic feel.
      const targetX: number = pointer.current.y * 0.45;
      const targetY: number = pointer.current.x * 0.75;
      group.rotation.x += (targetX - group.rotation.x) * Math.min(1, delta * 4);
      group.rotation.y += (targetY - group.rotation.y) * Math.min(1, delta * 4);
      if (spinning) {
        group.rotation.z += delta * (hovered ? 0.9 : 0.35);
      }
      // Micro-interaction: gentle scale bump while the cursor hovers the badge.
      const targetScale: number = hovered ? 1.06 : 1;
      const nextScale: number = group.scale.x + (targetScale - group.scale.x) * Math.min(1, delta * 6);
      group.scale.setScalar(nextScale);
    }
    if (ringRef.current !== null) {
      ringRef.current.rotation.z -= delta * (spinning ? (hovered ? 1.6 : 0.9) : 0.25);
    }
  });

  const handleClick = (_event: ThreeEvent<MouseEvent>): void => {
    onToggleSpin();
  };

  return (
    <group ref={groupRef}>
      <Float speed={1.6} rotationIntensity={0.25} floatIntensity={1.1}>
        {/* Glassy coin body behind the monogram */}
        <mesh castShadow position={[0, 0, -0.25]}>
          <cylinderGeometry args={[1.45, 1.45, 0.22, 96]} />
          <MeshTransmissionMaterial
            backside
            samples={6}
            thickness={0.45}
            chromaticAberration={0.35}
            anisotropicBlur={0.3}
            distortion={0.25}
            distortionScale={0.4}
            temporalDistortion={0.1}
            iridescence={1}
            iridescenceIOR={1.2}
            iridescenceThicknessRange={[0, 1400]}
            roughness={0.15}
            color={"#c7d2fe"}
          />
        </mesh>
        {/* Extruded H monogram — hover glows, click toggles spin */}
        <mesh
          geometry={geometry}
          onClick={handleClick}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            onHoverChange(true);
          }}
          onPointerOut={() => onHoverChange(false)}
          castShadow
          scale={0.9}
        >
          <meshPhysicalMaterial
            color={accentHex}
            metalness={0.9}
            roughness={0.18}
            clearcoat={1}
            clearcoatRoughness={0.12}
            emissive={accentHex}
            emissiveIntensity={hovered ? 0.45 : 0.12}
          />
        </mesh>
        {/* Orbiting neon ring */}
        <mesh ref={ringRef} position={[0, 0, -0.2]} rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[1.85, 0.035, 24, 128]} />
          <meshBasicMaterial color={"#22d3ee"} toneMapped={false} transparent opacity={0.85} />
        </mesh>
      </Float>
      <ContactShadows position={[0, -2.1, 0]} opacity={0.4} scale={9} blur={2.6} far={3.2} />
    </group>
  );
}

export interface HeroBadgeProps {
  readonly accentHex?: string;
}

/** Full-bleed responsive R3F canvas with mouse-reactive floating badge. */
export default function HeroBadge({ accentHex = "#8b5cf6" }: HeroBadgeProps): ReactElement {
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [spinning, setSpinning] = useState<boolean>(true);
  const [hovered, setHovered] = useState<boolean>(false);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect: DOMRect = event.currentTarget.getBoundingClientRect();
    pointer.current = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    };
  };

  return (
    <div
      className="absolute inset-0 touch-none select-none"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        pointer.current = { x: 0, y: 0 };
        setHovered(false);
      }}
      aria-hidden="true"
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, 0, 6], fov: 42 }}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 6, 4]} intensity={1.4} castShadow />
        <pointLight position={[-4, -2, 2]} intensity={1.2} color={"#6366f1"} />
        <Badge
          pointer={pointer}
          hovered={hovered}
          spinning={spinning}
          onToggleSpin={() => setSpinning((s: boolean) => !s)}
          onHoverChange={setHovered}
          accentHex={accentHex}
        />
        <Environment preset="city" />
      </Canvas>
    </div>
  );
}
