import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { Agent } from "../../contracts/protocol";
import { findPath, slide, type Point } from "./movement";

type Vec = [number, number, number];
const COLORS = {
  wood: "#a77d54",
  ivory: "#e9e5d9",
  metal: "#303a37",
  green: "#52634e",
  skin: "#bd9275",
};
function Box({
  at,
  size,
  color,
  roughness = 0.8,
  ...props
}: { at: Vec; size: Vec; color: string; roughness?: number } & Partial<
  React.ComponentProps<"mesh">
>) {
  return (
    <mesh position={at} receiveShadow castShadow {...props}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  );
}
function Sphere({ at, scale, color }: { at: Vec; scale: Vec; color: string }) {
  return (
    <mesh position={at} scale={scale} castShadow>
      <sphereGeometry args={[1, 20, 16]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
}
function Cylinder({
  at,
  r = 0.03,
  h = 0.5,
  color = COLORS.metal,
}: {
  at: Vec;
  r?: number;
  h?: number;
  color?: string;
}) {
  return (
    <mesh position={at} castShadow>
      <cylinderGeometry args={[r, r, h, 16]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}
function Plant({ at, scale = 1 }: { at: Vec; scale?: number }) {
  return (
    <group position={at} scale={scale}>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.16, 0.4, 24]} />
        <meshStandardMaterial color="#c8b9a2" />
      </mesh>
      <Cylinder at={[0, 0.72, 0]} h={1} r={0.025} color="#655b3d" />
      {Array.from({ length: 9 }, (_, i) => (
        <group
          key={i}
          rotation={[0, i * 2.4, 0]}
          position={[0, 0.58 + i * 0.07, 0]}
        >
          <Sphere
            at={[0.14, 0.13, 0]}
            scale={[0.27, 0.1, 0.11]}
            color={i % 2 ? "#657651" : "#40543b"}
          />
        </group>
      ))}
    </group>
  );
}
function Monitor({
  at,
  active = false,
  onInspect,
}: {
  at: Vec;
  active?: boolean;
  onInspect?: () => void;
}) {
  return (
    <group
      position={at}
      onClick={
        onInspect
          ? (e) => {
              e.stopPropagation();
              onInspect();
            }
          : undefined
      }
    >
      <Box at={[0, 0.015, 0]} size={[0.34, 0.025, 0.22]} color="#3c4442" />
      <Cylinder at={[0, 0.17, 0]} h={0.3} r={0.028} />
      <Box at={[0, 0.39, 0]} size={[0.86, 0.5, 0.035]} color="#202a28" />
      <Box
        at={[0, 0.39, 0.022]}
        size={[0.81, 0.45, 0.006]}
        color={active ? "#142a27" : "#404c45"}
      />
      {active &&
        Array.from({ length: 9 }, (_, i) => (
          <Box
            key={i}
            at={[-0.16 + (i % 3) * 0.04, 0.55 - i * 0.04, 0.027]}
            size={[0.32 + (i % 3) * 0.07, 0.009, 0.002]}
            color={i % 3 ? "#6b9589" : "#c0b98b"}
          />
        ))}
    </group>
  );
}
function Chair({ at, yaw = 0 }: { at: Vec; yaw?: number }) {
  return (
    <group position={at} rotation={[0, yaw, 0]}>
      <Cylinder at={[0, 0.25, 0]} h={0.45} r={0.045} />
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, (i * Math.PI * 2) / 5, 0]}>
          <Box
            at={[0.15, 0.065, 0]}
            size={[0.34, 0.04, 0.04]}
            color="#434b45"
          />
          <Sphere
            at={[0.32, 0.055, 0]}
            scale={[0.055, 0.055, 0.035]}
            color="#272c29"
          />
        </group>
      ))}
      <Box at={[0, 0.5, 0]} size={[0.57, 0.12, 0.54]} color="#777b69" />
      <Box at={[0, 0.85, -0.23]} size={[0.54, 0.58, 0.085]} color="#777b69" />
      {[-1, 1].map((i) => (
        <group key={i}>
          <Cylinder at={[i * 0.34, 0.62, -0.05]} h={0.32} r={0.018} />
          <Box
            at={[i * 0.34, 0.78, 0]}
            size={[0.075, 0.04, 0.37]}
            color="#3e4540"
          />
        </group>
      ))}
    </group>
  );
}
function Desk({
  at,
  active = false,
  onInspect,
}: {
  at: Vec;
  active?: boolean;
  onInspect?: () => void;
}) {
  return (
    <group position={at}>
      <Box at={[0, 0.78, 0]} size={[2.7, 0.065, 1.1]} color={COLORS.wood} />
      {[-1.13, 1.13].map((x) => (
        <group key={x}>
          <Box
            at={[x, 0.39, 0]}
            size={[0.065, 0.75, 0.72]}
            color={COLORS.metal}
          />
        </group>
      ))}
      <Monitor at={[-0.35, 0.82, -0.3]} active={active} onInspect={onInspect} />
      <group rotation={[0, -0.2, 0]}>
        <Monitor at={[0.58, 0.82, -0.19]} />
      </group>
      <Box
        at={[-0.3, 0.825, 0.27]}
        size={[0.54, 0.025, 0.18]}
        color="#dedbd1"
      />
      {Array.from({ length: 12 }, (_, i) => (
        <Box
          key={i}
          at={[-0.54 + i * 0.043, 0.84, 0.27]}
          size={[0.028, 0.008, 0.12]}
          color="#b5b6ac"
        />
      ))}
      <Sphere
        at={[0.19, 0.845, 0.27]}
        scale={[0.045, 0.026, 0.07]}
        color="#ddd9cc"
      />
      <Cylinder at={[1, 0.9, 0.23]} r={0.063} h={0.17} color="#ede8da" />
      <mesh position={[1, 0.99, 0.23]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.052, 20]} />
        <meshBasicMaterial color="#533c2d" />
      </mesh>
      <Box
        at={[-1.02, 0.83, 0.18]}
        size={[0.09, 0.018, 0.18]}
        color="#313c35"
      />
    </group>
  );
}
function Environment({ onInspect }: { onInspect: () => void }) {
  return (
    <group>
      <Box at={[0, -0.08, 0]} size={[12, 0.15, 10]} color="#a89072" />
      {Array.from({ length: 26 }, (_, i) => (
        <Box
          key={i}
          at={[-5.75 + i * 0.45, 0.002, 0]}
          size={[0.442, 0.012, 10]}
          color={["#baa080", "#bda484", "#b79c7b", "#c0a787"][i % 4]}
        />
      ))}
      <Box at={[0, 1.8, -5]} size={[12, 3.6, 0.15]} color="#e7e4d9" />
      <Box at={[-6, 1.8, 0]} size={[0.15, 3.6, 10]} color="#dad9cd" />
      <Box at={[0, 0.045, -2]} size={[6.8, 0.025, 4.5]} color="#c2c4b6" />
      <Box at={[0, 2.13, -4.89]} size={[8.4, 2.15, 0.04]} color="#cbdde0" />
      {Array.from({ length: 5 }, (_, i) => (
        <group key={i}>
          <Box
            at={[-4.2 + i * 2.1, 2.1, -4.82]}
            size={[0.075, 2.3, 0.08]}
            color="#777f73"
          />
          <Box
            at={[-3.5 + i * 1.55, 1.45, -4.84]}
            size={[0.8, 0.45 + (i % 3) * 0.22, 0.02]}
            color={i % 2 ? "#b7c6c4" : "#adbcbd"}
          />
        </group>
      ))}
      <Box at={[0, 1.02, -4.78]} size={[8.6, 0.1, 0.36]} color="#dfdbcd" />
      <Box at={[0, 3.24, -4.8]} size={[8.6, 0.08, 0.1]} color="#777f73" />
      <Desk at={[-1.65, 0, -2.75]} active onInspect={onInspect} />
      <Chair at={[-1.65, 0, -1.7]} yaw={Math.PI} />
      <Desk at={[3.7, 0, -2.8]} />
      <Chair at={[3.7, 0, -1.8]} yaw={Math.PI} />
      <Box at={[-5.4, 1.05, -2]} size={[0.75, 2.1, 3]} color="#c1ae8e" />
      {[0.3, 0.85, 1.4, 1.95].map((y) => (
        <Box
          key={y}
          at={[-4.98, y, -2]}
          size={[0.1, 0.06, 2.85]}
          color="#806c50"
        />
      ))}
      {Array.from({ length: 15 }, (_, i) => (
        <Box
          key={i}
          at={[-4.95, 0.5 + (i % 3) * 0.55, -3.2 + Math.floor(i / 3) * 0.52]}
          size={[0.19, 0.3, 0.13]}
          color={["#777e6b", "#b8a582", "#d7c9ab", "#8e6553"][i % 4]}
        />
      ))}
      <Box at={[4.95, 0.35, 1.8]} size={[1.25, 0.65, 2.5]} color="#9faaa0" />
      <Box at={[5.48, 0.7, 1.8]} size={[0.22, 0.8, 2.5]} color="#9faaa0" />
      {[0.8, 2.8].map((z) => (
        <Box
          key={z}
          at={[4.95, 0.67, z]}
          size={[1.25, 0.65, 0.26]}
          color="#939f95"
        />
      ))}
      <Box at={[2.8, 0.35, 1.8]} size={[0.9, 0.07, 1.4]} color="#7b6249" />
      {[1.3, 2.3].map((z) => (
        <Cylinder key={z} at={[2.8, 0.18, z]} h={0.35} r={0.035} />
      ))}
      <Box at={[2.8, 0.405, 1.7]} size={[0.32, 0.035, 0.4]} color="#d7c4a5" />
      <Plant at={[-4.1, 0, -4]} />
      <Plant at={[5, 0, -4.2]} />
      <Plant at={[4.7, 0, 3.6]} scale={1.15} />
      <Box at={[0.8, 0.01, 3]} size={[2.5, 0.018, 1.2]} color="#b7b6a2" />
      {[-2, 2].map((x) => (
        <group key={x}>
          <Box at={[x, 3.5, -1.8]} size={[2.1, 0.035, 0.13]} color="#575d51" />
          <mesh position={[x, 3.47, -1.8]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[2, 0.1]} />
            <meshBasicMaterial color="#fff4cf" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Initial articulated mannequin. Presentation-only joints, never agent authority. */
function Person({
  position,
  yaw,
  sit,
  walking,
  typing,
  look,
  shirt = COLORS.green,
}: {
  position: RefObject<THREE.Vector3>;
  yaw: RefObject<number>;
  sit: RefObject<number>;
  walking: RefObject<number>;
  typing?: boolean;
  look?: RefObject<number>;
  shirt?: string;
}) {
  const root = useRef<THREE.Group>(null),
    hip = useRef<THREE.Group>(null),
    head = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null),
    rightLeg = useRef<THREE.Group>(null),
    leftKnee = useRef<THREE.Group>(null),
    rightKnee = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null),
    rightArm = useRef<THREE.Group>(null),
    leftElbow = useRef<THREE.Group>(null),
    rightElbow = useRef<THREE.Group>(null);
  const phase = useRef(0);
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.06);
    phase.current += d * (walking.current > 0.05 ? 7 : 1);
    const t = phase.current,
      s = sit.current,
      w = walking.current;
    if (root.current) {
      root.current.position.copy(position.current);
      root.current.rotation.y = yaw.current;
    }
    if (hip.current)
      hip.current.position.y =
        1.01 - s * 0.31 + Math.abs(Math.sin(t)) * 0.025 * w;
    if (head.current) {
      head.current.rotation.y = THREE.MathUtils.damp(
        head.current.rotation.y,
        look?.current ?? 0,
        5,
        d,
      );
      head.current.rotation.x = s * 0.08;
    }
    [leftLeg, rightLeg].forEach((ref, i) => {
      if (ref.current)
        ref.current.rotation.x =
          -s * 1.48 + Math.sin(t + i * Math.PI) * 0.48 * w * (1 - s);
    });
    [leftKnee, rightKnee].forEach((ref, i) => {
      if (ref.current)
        ref.current.rotation.x =
          s * 1.48 + Math.max(0, Math.sin(t + i * Math.PI)) * 0.5 * w * (1 - s);
    });
    [leftArm, rightArm].forEach((ref, i) => {
      if (ref.current) {
        ref.current.rotation.x =
          -s * 0.48 - Math.sin(t + i * Math.PI) * 0.4 * w * (1 - s);
        ref.current.rotation.z = (i ? 1 : -1) * 0.1;
      }
    });
    [leftElbow, rightElbow].forEach((ref, i) => {
      if (ref.current)
        ref.current.rotation.x =
          -s * (typing ? 1.06 : 0.15) +
          (typing ? Math.sin(t * 8 + i) * 0.05 * s : 0);
    });
  });
  const limb = (length: number, r: number, color: string) => (
    <mesh position={[0, -length / 2, 0]} castShadow>
      <capsuleGeometry args={[r, length - r * 2, 6, 12]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
  return (
    <group ref={root}>
      <group ref={hip}>
        <Sphere at={[0, 0.23, 0]} scale={[0.225, 0.32, 0.125]} color={shirt} />
        <Sphere
          at={[0, -0.035, 0]}
          scale={[0.2, 0.125, 0.12]}
          color="#353c3b"
        />
        <group ref={head} position={[0, 0.57, 0]}>
          <Cylinder at={[0, -0.03, 0]} r={0.06} h={0.13} color={COLORS.skin} />
          <Sphere
            at={[0, 0.1, 0]}
            scale={[0.115, 0.155, 0.112]}
            color={COLORS.skin}
          />
          <Sphere
            at={[0, 0.2, -0.022]}
            scale={[0.122, 0.083, 0.104]}
            color="#3b332d"
          />
          <Sphere
            at={[0, 0.1, 0.111]}
            scale={[0.024, 0.035, 0.028]}
            color={COLORS.skin}
          />
          {[-1, 1].map((i) => (
            <group key={i}>
              <Sphere
                at={[i * 0.046, 0.13, 0.101]}
                scale={[0.016, 0.011, 0.012]}
                color="#2f302a"
              />
              <Sphere
                at={[i * 0.115, 0.1, 0]}
                scale={[0.024, 0.04, 0.022]}
                color={COLORS.skin}
              />
            </group>
          ))}
        </group>
        {[-1, 1].map((side, i) => (
          <group
            key={side}
            position={[side * 0.1, 0, 0]}
            ref={i ? rightLeg : leftLeg}
          >
            {limb(0.46, 0.085, "#353c3b")}
            <group position={[0, -0.46, 0]} ref={i ? rightKnee : leftKnee}>
              {limb(0.44, 0.066, "#353c3b")}
              <Sphere
                at={[0, -0.445, 0.055]}
                scale={[0.08, 0.06, 0.16]}
                color="#e0ded5"
              />
            </group>
          </group>
        ))}
        {[-1, 1].map((side, i) => (
          <group
            key={side}
            position={[side * 0.225, 0.42, 0]}
            ref={i ? rightArm : leftArm}
          >
            {limb(0.29, 0.066, shirt)}
            <group position={[0, -0.29, 0]} ref={i ? rightElbow : leftElbow}>
              {limb(0.27, 0.048, shirt)}
              <Sphere
                at={[0, -0.29, 0]}
                scale={[0.043, 0.068, 0.025]}
                color={COLORS.skin}
              />
            </group>
          </group>
        ))}
      </group>
    </group>
  );
}
function Label({
  agent,
  position,
  onClick,
}: {
  agent: Agent;
  position: RefObject<THREE.Vector3>;
  onClick: () => void;
}) {
  const sprite = useRef<THREE.Sprite>(null);
  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f3f1e8";
    ctx.beginPath();
    ctx.roundRect(0, 0, 512, 128, 16);
    ctx.fill();
    ctx.fillStyle = "#28392e";
    ctx.font = "bold 32px system-ui";
    ctx.fillText("BACKEND", 28, 50);
    ctx.fillStyle = "#667862";
    ctx.font = "24px system-ui";
    ctx.fillText(`${agent.state}  ·  MOCK`, 28, 91);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [agent.state]);
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame(() => {
    sprite.current?.position.set(position.current.x, 2.22, position.current.z);
  });
  return (
    <sprite ref={sprite} scale={[1.45, 0.362, 1]} onClick={onClick}>
      <spriteMaterial map={texture} depthTest={false} />
    </sprite>
  );
}
function Simulation({
  agent,
  interacting,
  onNear,
  onInteract,
  overview,
  low,
  onMotion,
  stale,
}: {
  stale: boolean;
  agent: Agent;
  interacting: boolean;
  onNear: (near: boolean) => void;
  onInteract: () => void;
  overview: boolean;
  low: boolean;
  onMotion: (s: string) => void;
}) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>()),
    angle = useRef(0),
    pitch = useRef(0.46),
    pointer = useRef<{ x: number; y: number } | null>(null);
  const player = useRef(new THREE.Vector3(0, 0, 2.7)),
    pyaw = useRef(Math.PI),
    psit = useRef(0),
    speed = useRef(0);
  const npc = useRef(new THREE.Vector3(-1.65, 0, -1.7)),
    nyaw = useRef(Math.PI),
    nsit = useRef(1),
    nspeed = useRef(0),
    look = useRef(0);
  const mode = useRef("seated"),
    path = useRef<Point[]>([]),
    nextAmbient = useRef(8),
    time = useRef(0),
    reported = useRef(false);
  const velocity = useRef(new THREE.Vector2());
  const v = new THREE.Vector3();
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,select,button")
      )
        return;
      if (
        [
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "KeyE",
        ].includes(e.code)
      ) {
        e.preventDefault();
        keys.current.add(e.code);
        if (e.code === "KeyE" && !e.repeat && reported.current && !interacting)
          onInteract();
      }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => {
      keys.current.clear();
      pointer.current = null;
    };
    const pd = (e: PointerEvent) => {
      if (e.button === 0) {
        pointer.current = { x: e.clientX, y: e.clientY };
        gl.domElement.setPointerCapture(e.pointerId);
      }
    };
    const pm = (e: PointerEvent) => {
      if (pointer.current) {
        angle.current -= (e.clientX - pointer.current.x) * 0.006;
        pitch.current = THREE.MathUtils.clamp(
          pitch.current + (e.clientY - pointer.current.y) * 0.003,
          0.2,
          0.95,
        );
        pointer.current = { x: e.clientX, y: e.clientY };
      }
    };
    const pu = () => {
      pointer.current = null;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    gl.domElement.addEventListener("pointerdown", pd);
    gl.domElement.addEventListener("pointermove", pm);
    gl.domElement.addEventListener("pointerup", pu);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      gl.domElement.removeEventListener("pointerdown", pd);
      gl.domElement.removeEventListener("pointermove", pm);
      gl.domElement.removeEventListener("pointerup", pu);
    };
  }, [gl, interacting, onInteract]);
  useEffect(() => {
    if (interacting) keys.current.clear();
  }, [interacting]);
  const transition = (m: string) => {
    if (mode.current !== m) {
      mode.current = m;
      onMotion(m);
    }
  };
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.06);
    time.current += dt;
    const k = keys.current,
      dx = !interacting
        ? Number(k.has("KeyD") || k.has("ArrowRight")) -
          Number(k.has("KeyA") || k.has("ArrowLeft"))
        : 0,
      dz = !interacting
        ? Number(k.has("KeyS") || k.has("ArrowDown")) -
          Number(k.has("KeyW") || k.has("ArrowUp"))
        : 0;
    const input = new THREE.Vector2(dx, dz);
    if (input.length() > 0) input.normalize();
    const moveX =
        input.x * Math.cos(angle.current) + input.y * Math.sin(angle.current),
      moveZ =
        -input.x * Math.sin(angle.current) + input.y * Math.cos(angle.current);
    velocity.current.x = THREE.MathUtils.damp(
      velocity.current.x,
      moveX * 2,
      9,
      dt,
    );
    velocity.current.y = THREE.MathUtils.damp(
      velocity.current.y,
      moveZ * 2,
      9,
      dt,
    );
    const p = slide(
      player.current,
      velocity.current.x * dt,
      velocity.current.y * dt,
    );
    player.current.set(p.x, 0, p.z);
    speed.current = velocity.current.length() / 2;
    if (speed.current > 0.04) {
      const target = Math.atan2(velocity.current.x, velocity.current.y);
      pyaw.current +=
        Math.atan2(
          Math.sin(target - pyaw.current),
          Math.cos(target - pyaw.current),
        ) * Math.min(dt * 10, 1);
    }
    const near = player.current.distanceTo(npc.current) < 2.15;
    if (near !== reported.current) {
      reported.current = near;
      onNear(near);
    }
    const idle = agent.state === "IDLE" && !interacting && !stale;
    if (
      mode.current === "seated" &&
      idle &&
      time.current > nextAmbient.current
    ) {
      transition("standing");
    }
    if (mode.current === "standing") {
      nsit.current = THREE.MathUtils.damp(nsit.current, 0, 5, dt);
      if (nsit.current < 0.03) {
        path.current = findPath(
          npc.current,
          idle ? { x: 0.9, z: -3.8 } : { x: -1.65, z: -1.7 },
        );
        transition("walking");
      }
    }
    if (mode.current === "walking") {
      if (interacting) {
        nspeed.current = 0;
      } else {
        if (
          !idle &&
          path.current.length > 0 &&
          path.current.at(-1)?.x !== -1.65
        )
          path.current = findPath(npc.current, { x: -1.65, z: -1.7 });
        const target = path.current[0];
        if (target) {
          const x = target.x - npc.current.x,
            z = target.z - npc.current.z,
            d = Math.hypot(x, z);
          nspeed.current = THREE.MathUtils.damp(nspeed.current, 1, 5, dt);
          if (d < 0.06) path.current.shift();
          else {
            const step = Math.min(d, dt * 0.9 * nspeed.current);
            npc.current.x += (x / d) * step;
            npc.current.z += (z / d) * step;
            const y = Math.atan2(x, z);
            nyaw.current +=
              Math.atan2(
                Math.sin(y - nyaw.current),
                Math.cos(y - nyaw.current),
              ) * Math.min(dt * 7, 1);
          }
        } else {
          nspeed.current = 0;
          if (npc.current.distanceTo(new THREE.Vector3(-1.65, 0, -1.7)) < 0.15)
            transition("sitting");
          else {
            nextAmbient.current = time.current + 4;
            transition("window");
          }
        }
      }
    }
    if (
      mode.current === "window" &&
      (!idle || time.current > nextAmbient.current)
    ) {
      path.current = findPath(npc.current, { x: -1.65, z: -1.7 });
      transition("walking");
    }
    if (mode.current === "sitting") {
      nsit.current = THREE.MathUtils.damp(nsit.current, 1, 5, dt);
      nyaw.current = THREE.MathUtils.damp(nyaw.current, Math.PI, 6, dt);
      if (nsit.current > 0.98) {
        nextAmbient.current = time.current + 12;
        transition("seated");
      }
    }
    const toward = Math.atan2(
      player.current.x - npc.current.x,
      player.current.z - npc.current.z,
    );
    if (mode.current === "seated") {
      const turn = interacting
        ? THREE.MathUtils.clamp(
            Math.atan2(Math.sin(toward - Math.PI), Math.cos(toward - Math.PI)),
            -1,
            1,
          )
        : 0;
      nyaw.current = THREE.MathUtils.damp(nyaw.current, Math.PI + turn, 5, dt);
    }
    look.current = near
      ? THREE.MathUtils.clamp(
          Math.atan2(
            Math.sin(toward - nyaw.current),
            Math.cos(toward - nyaw.current),
          ),
          -0.7,
          0.7,
        )
      : 0;
    if (mode.current === "seated" && !idle)
      nextAmbient.current = time.current + 8;
    if (overview) {
      v.set(8, 9, 11);
      camera.position.lerp(v, 1 - Math.exp(-dt * 4));
      camera.lookAt(0, 0, -1);
    } else {
      const distance = 4.8;
      v.set(
        player.current.x + Math.sin(angle.current) * distance,
        1.35 + Math.sin(pitch.current) * distance,
        player.current.z + Math.cos(angle.current) * distance,
      );
      camera.position.lerp(v, 1 - Math.exp(-dt * 7));
      camera.lookAt(player.current.x, 1.05, player.current.z);
    }
  });
  return (
    <>
      <Person
        position={player}
        yaw={pyaw}
        sit={psit}
        walking={speed}
        shirt="#a97350"
      />
      <Person
        position={npc}
        yaw={nyaw}
        sit={nsit}
        walking={nspeed}
        typing={
          !stale &&
          !interacting &&
          ["CODING", "TERMINAL", "TESTING"].includes(agent.state)
        }
        look={look}
      />
      <Label
        agent={agent}
        position={npc}
        onClick={() => {
          if (reported.current) onInteract();
        }}
      />
      <Environment
        onInspect={() => {
          if (reported.current) onInteract();
        }}
      />
      <ambientLight intensity={0.85} />
      <hemisphereLight args={["#e2ebed", "#a0957f", 1.65]} />
      <directionalLight
        position={[-3, 7, -3]}
        intensity={3.3}
        castShadow={!low}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-normalBias={0.04}
      />
    </>
  );
}
function RenderBudget({ low }: { low: boolean }) {
  const { advance, setDpr } = useThree();
  useEffect(() => {
    let id = 0,
      last = 0,
      slow = 0;
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      if (document.hidden) {
        last = now;
        return;
      }
      if (now - last < 1000 / 30 - 1) return;
      if (now - last > 60) slow++;
      else slow = Math.max(0, slow - 1);
      if (slow > 30) {
        setDpr(0.75);
        slow = 0;
      }
      last = now;
      advance(now / 1000);
    };
    setDpr(low ? 0.75 : Math.min(devicePixelRatio, 1.25));
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [advance, setDpr, low]);
  return null;
}
export default function Scene(props: {
  stale: boolean;
  agent: Agent;
  interacting: boolean;
  onNear: (v: boolean) => void;
  onInteract: () => void;
  overview: boolean;
  low: boolean;
  onMotion: (s: string) => void;
}) {
  const [lost, setLost] = useState(false);
  return (
    <div
      className="canvas-wrap"
      aria-label="Трёхмерный офис. WASD — движение, мышь — камера, E — разговор."
    >
      {lost && (
        <div className="scene-error">
          3D недоступно. Переключитесь в режим «2D».
        </div>
      )}
      <Canvas
        frameloop="never"
        shadows={!props.low}
        camera={{ position: [0, 4, 7], fov: 53, near: 0.1, far: 60 }}
        gl={{
          antialias: !props.low,
          powerPreference: "low-power",
          alpha: false,
        }}
        fallback={
          <div className="scene-error">
            Браузер не поддерживает WebGL. Используйте «2D».
          </div>
        }
        onCreated={({ gl }) => {
          gl.setClearColor("#e6e5dc");
          gl.domElement.addEventListener("webglcontextlost", () =>
            setLost(true),
          );
        }}
      >
        <fog attach="fog" args={["#e6e5dc", 17, 36]} />
        <RenderBudget low={props.low} />
        <Simulation {...props} />
      </Canvas>
    </div>
  );
}
