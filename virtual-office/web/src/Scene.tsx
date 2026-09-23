import type { LiveSnapshot } from "./live-client";
import { ROSTER, seatNumber, type RoleId } from "./roster";
import { TeamMembers } from "./TeamMembers";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { Agent } from "../../contracts/protocol";
import { findPath, slide, type Point } from "./movement";
import type { Appearance } from "./characters";
import { OfficeCharacter } from "./OfficeCharacter";
import { OfficeEnvironment } from "./OfficeEnvironment";

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
    ctx.fillRect(0, 0, 512, 128);
    const member = ROSTER.find((m) => m.id === "backend")!;
    ctx.fillStyle = member.accent;
    ctx.fillRect(0, 0, 10, 128);
    ctx.fillStyle = "#28392e";
    ctx.font = "bold 31px system-ui";
    ctx.fillText(member.name + " / " + member.role, 25, 50);
    ctx.fillStyle = "#707968";
    ctx.font = "22px system-ui";
    const status = {
      OFFLINE: "НЕ В СЕТИ",
      IDLE: "ДОСТУПЕН",
      THINKING: "ГОТОВИТ ОТВЕТ",
      READING: "ЧИТАЕТ",
      RESEARCHING: "ИССЛЕДУЕТ",
      CODING: "ПИШЕТ КОД",
      TERMINAL: "В ТЕРМИНАЛЕ",
      TESTING: "ТЕСТИРУЕТ",
      REVIEWING: "ПРОВЕРЯЕТ",
      WAITING: "ОЖИДАЕТ РЕШЕНИЯ",
      WAITING_TOOL: "ЖДЁТ ИНСТРУМЕНТ",
      COMMUNICATING: "ОБЩАЕТСЯ",
      MEETING: "НА ВСТРЕЧЕ",
      ERROR: "ОШИБКА",
      DONE: "ОТВЕТ ГОТОВ",
    }[agent.state];
    ctx.fillText("МЕСТО " + seatNumber(member.id) + " · " + status, 25, 93);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [agent.state]);
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame(() => {
    sprite.current?.position.set(position.current.x, 2.22, position.current.z);
  });
  return (
    <sprite ref={sprite} scale={[1.55, 0.388, 1]} onClick={onClick}>
      <spriteMaterial map={texture} depthTest={false} />
    </sprite>
  );
}
function Simulation({
  liveSnapshot,
  focusedRole,
  onSelectRole,
  appearance,
  agent,
  interacting,
  onNear,
  onInteract,
  overview,
  low,
  onMotion,
  stale,
}: {
  liveSnapshot?: LiveSnapshot | null;
  focusedRole: RoleId | null;
  onSelectRole: (id: RoleId) => void;
  appearance: Appearance;
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
    pitch = useRef(0.36),
    pointer = useRef<{ x: number; y: number } | null>(null);
  const player = useRef(new THREE.Vector3(0, 0, 2.7)),
    pyaw = useRef(Math.PI),
    psit = useRef(0),
    speed = useRef(0);
  const npc = useRef(new THREE.Vector3(-1.65, 0, -1.85)),
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
      dx =
        !interacting && !focusedRole
          ? Number(k.has("KeyD") || k.has("ArrowRight")) -
            Number(k.has("KeyA") || k.has("ArrowLeft"))
          : 0,
      dz =
        !interacting && !focusedRole
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
        nsit.current = 0;
        path.current = findPath(
          npc.current,
          idle ? { x: 0.9, z: -8.6 } : { x: -1.65, z: -1.85 },
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
          path.current = findPath(npc.current, { x: -1.65, z: -1.85 });
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
          if (npc.current.distanceTo(new THREE.Vector3(-1.65, 0, -1.85)) < 0.15)
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
      path.current = findPath(npc.current, { x: -1.65, z: -1.85 });
      transition("walking");
    }
    if (mode.current === "sitting") {
      nsit.current = THREE.MathUtils.damp(nsit.current, 1, 5, dt);
      nyaw.current = THREE.MathUtils.damp(nyaw.current, Math.PI, 6, dt);
      if (nsit.current > 0.98) {
        nsit.current = 1;
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
    if (focusedRole) {
      const member = ROSTER.find((m) => m.id === focusedRole)!;
      v.set(member.x + 1.9, 1.7, member.z + 0.05);
      camera.position.lerp(v, 1 - Math.exp(-dt * 4));
      camera.lookAt(member.x - 0.35, 1.15, member.z + 1.05);
    } else if (interacting) {
      v.set(npc.current.x + 1.9, 1.7, npc.current.z - 1.0);
      camera.position.lerp(v, 1 - Math.exp(-dt * 4));
      camera.lookAt(npc.current.x - 0.35, 1.15, npc.current.z);
    } else if (overview) {
      v.set(10, 13, 13);
      camera.position.lerp(v, 1 - Math.exp(-dt * 4));
      camera.lookAt(-1.5, 0, 0);
    } else {
      const distance = 3.3;
      v.set(
        player.current.x + Math.sin(angle.current) * distance,
        Math.min(3.3, 1.2 + Math.sin(pitch.current) * distance),
        player.current.z + Math.cos(angle.current) * distance,
      );
      camera.position.lerp(v, 1 - Math.exp(-dt * 7));
      camera.lookAt(player.current.x, 1.05, player.current.z);
    }
  });
  return (
    <>
      <OfficeCharacter
        model={appearance.player}
        position={player}
        yaw={pyaw}
        sit={psit}
        walking={speed}
        player
      />
      <OfficeCharacter
        model={appearance.backend}
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
      {!interacting && (
        <Label
          agent={agent}
          position={npc}
          onClick={() => {
            if (reported.current) onInteract();
          }}
        />
      )}
      <TeamMembers onSelect={onSelectRole} liveSnapshot={liveSnapshot} />
      <OfficeEnvironment
        overview={overview}
        onSelectRole={onSelectRole}
        chairYaw={nyaw}
        chairSit={nsit}
        onInspect={() => {
          if (reported.current) onInteract();
        }}
      />
      <ambientLight intensity={1.15} />
      <hemisphereLight args={["#dce7f0", "#b3a897", 2.0]} />
      <directionalLight position={[2, 3, 4]} intensity={1.1} color="#e5ebf0" />
      <directionalLight
        position={[-4, 3.1, -8]}
        intensity={1.6}
        castShadow={!low}
        shadow-mapSize={[1536, 1536]}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-normalBias={0.04}
      />
    </>
  );
}
function RenderBudget({ onDegrade }: { onDegrade: (value: boolean) => void }) {
  const { advance, gl } = useThree();
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
        onDegrade(true);
        slow = 0;
      }
      last = now;
      const started = performance.now();
      advance(now / 1000);
      // Local diagnostics for browser QA; no telemetry service or React updates.
      gl.domElement.dataset.renderFrames = String(
        Number(gl.domElement.dataset.renderFrames ?? 0) + 1,
      );
      gl.domElement.dataset.drawCalls = String(gl.info.render.calls);
      gl.domElement.dataset.triangles = String(gl.info.render.triangles);
      gl.domElement.dataset.renderMs = String(performance.now() - started);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [advance, gl, onDegrade]);
  return null;
}
export default function Scene(props: {
  liveSnapshot?: LiveSnapshot | null;
  focusedRole: RoleId | null;
  onSelectRole: (id: RoleId) => void;
  appearance: Appearance;
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
  const [degraded, setDegraded] = useState(false);
  useEffect(() => setDegraded(false), [props.low]);
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
        dpr={props.low || degraded ? 0.75 : Math.min(devicePixelRatio, 1.25)}
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
        <RenderBudget onDegrade={setDegraded} />
        <Simulation {...props} />
      </Canvas>
    </div>
  );
}
