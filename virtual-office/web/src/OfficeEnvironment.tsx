import { ROSTER, type RoleId } from "./roster";
import { KEYBOARD } from "./workstation";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
type V = [number, number, number];
function Block({
  at,
  size,
  material,
  radius = 0.012,
  rotation = [0, 0, 0],
  onClick,
}: {
  at: V;
  size: V;
  material: THREE.Material;
  radius?: number;
  rotation?: V;
  onClick?: () => void;
}) {
  const geometry = useMemo(
    () =>
      new RoundedBoxGeometry(
        ...size,
        2,
        Math.min(radius, ...size.map((s) => s / 3)),
      ),
    [...size, radius],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      position={at}
      rotation={rotation}
      geometry={geometry}
      material={material}
      castShadow
      receiveShadow
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
    />
  );
}
function KeyboardKeys({ material }: { material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const matrix = new THREE.Matrix4();
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 14; col++) {
        matrix.makeTranslation(
          KEYBOARD.x - 0.26 + col * 0.039,
          KEYBOARD.keyTop - 0.0065,
          KEYBOARD.z - 0.07 + row * 0.043,
        );
        ref.current!.setMatrixAt(row * 14 + col, matrix);
      }
    ref.current!.instanceMatrix.needsUpdate = true;
  }, []);
  return (
    <instancedMesh ref={ref} args={[undefined, material, 56]}>
      <boxGeometry args={[0.032, 0.013, 0.032]} />
    </instancedMesh>
  );
}
function Rod({
  from,
  to,
  r = 0.018,
  material,
}: {
  from: V;
  to: V;
  r?: number;
  material: THREE.Material;
}) {
  const a = new THREE.Vector3(...from),
    b = new THREE.Vector3(...to),
    length = a.distanceTo(b),
    q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.sub(a).normalize(),
    );
  return (
    <mesh
      position={a.add(new THREE.Vector3(...to)).multiplyScalar(0.5)}
      quaternion={q}
      material={material}
      castShadow
    >
      <cylinderGeometry args={[r, r, length, 10]} />
    </mesh>
  );
}
function surface(text: string, kind: "code" | "notes" | "paper") {
  const c = document.createElement("canvas");
  c.width = kind === "paper" ? 512 : 1024;
  c.height = kind === "paper" ? 640 : 640;
  const x = c.getContext("2d")!;
  x.fillStyle =
    kind === "code" ? "#18222b" : kind === "notes" ? "#edf0ec" : "#f1f0e7";
  x.fillRect(0, 0, c.width, c.height);
  if (kind === "paper") {
    x.fillStyle = "#34424b";
    x.font = "bold 25px sans-serif";
    x.fillText("DOBROPALM / ENGINEERING", 35, 60);
    x.font = "18px sans-serif";
    x.fillText("Connection lifecycle", 35, 106);
    for (let i = 0; i < 16; i++) {
      x.fillStyle = i % 5 === 0 ? "#687976" : "#b5bbb5";
      x.fillRect(35, 150 + i * 25, 320 + (i % 3) * 38, 3);
    }
    return new THREE.CanvasTexture(c);
  }
  x.fillStyle = kind === "code" ? "#2c3740" : "#d7e0da";
  x.fillRect(0, 0, 1024, 40);
  x.font = "18px monospace";
  x.fillStyle = kind === "code" ? "#abbcc6" : "#394e48";
  x.fillText("DOBROPALM     /     " + text, 25, 27);
  if (kind === "code") {
    x.fillStyle = "#202c35";
    x.fillRect(0, 40, 155, 600);
    x.font = "14px monospace";
    x.fillStyle = "#82909b";
    [
      "EXPLORER",
      "src",
      "  socket",
      "  client.ts",
      "  tests",
      "package.json",
    ].forEach((s, i) => x.fillText(s, 14, 82 + i * 30));
    const lines = [
      "// MOCK WORKSPACE — visual display",
      "export function reconnect(socket) {",
      "  const delay = retry.nextDelay();",
      "",
      "  socket.onclose = () => {",
      "    state.markDisconnected();",
      "    schedule(() => connect(), delay);",
      "  };",
      "",
      "  socket.onmessage = (event) => {",
      "    const frame = protocol.parse(event);",
      "    world.apply(frame);",
      "  };",
      "}",
      "",
      "// Live agent status is shown in the inspector.",
    ];
    x.font = "18px monospace";
    lines.forEach((s, i) => {
      x.fillStyle = "#62717c";
      x.fillText(String(i + 1), 174, 93 + i * 29);
      x.fillStyle =
        i % 3 === 0 ? "#8fbcac" : i % 3 === 1 ? "#d0ba96" : "#c1cbd1";
      x.fillText(s, 218, 93 + i * 29);
    });
  } else {
    x.fillStyle = "#314d44";
    x.font = "bold 35px sans-serif";
    x.fillText("Connection health", 45, 112);
    x.font = "20px sans-serif";
    x.fillStyle = "#839489";
    x.fillText("LOCAL MOCK / ENGINEERING", 45, 151);
    for (let i = 0; i < 6; i++) {
      x.fillStyle = i % 2 ? "#e2e8e0" : "#f4f6f1";
      x.fillRect(40, 190 + i * 51, 940, 44);
      x.fillStyle = "#687d71";
      x.fillText(
        [
          "Snapshot",
          "Sequence",
          "Heartbeat",
          "Reconnect",
          "Replay",
          "Idempotency",
        ][i],
        60,
        220 + i * 51,
      );
      x.fillStyle = "#3c7560";
      x.fillText("DEMO", 840, 220 + i * 51);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function OfficeEnvironment({
  onInspect,
  chairYaw,
  chairSit,
  overview,
  onSelectRole,
}: {
  onInspect: () => void;
  chairYaw: RefObject<number>;
  chairSit: RefObject<number>;
  overview: boolean;
  onSelectRole: (id: RoleId) => void;
}) {
  const { gl } = useThree();
  const chairRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (chairRef.current && chairSit.current > 0.98)
      chairRef.current.rotation.y = chairYaw.current;
    if (chairRef.current)
      gl.domElement.dataset.chairYaw = String(chairRef.current.rotation.y);
  });
  const loaded = useLoader(THREE.TextureLoader, [
    "/assets/materials/wood_floor_Diffuse.jpg",
    "/assets/materials/wood_floor_nor_gl.jpg",
    "/assets/materials/wood_floor_Rough.jpg",
    "/assets/materials/fabric_pattern_07_nor_gl.jpg",
    "/assets/materials/plastered_wall_02_nor_gl.jpg",
  ]);
  const assets = useMemo(() => {
    const textures = loaded.map((t) => t.clone());
    textures.forEach((t, i) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(i < 3 ? 5 : 2, i < 3 ? 4 : 2);
      t.anisotropy = 4;
      t.needsUpdate = true;
    });
    textures[0].colorSpace = THREE.SRGBColorSpace;
    const woodMap = textures[0].clone();
    woodMap.repeat.set(1, 0.65);
    woodMap.needsUpdate = true;
    textures.push(woodMap);
    const mat = (color: string, roughness = 0.65, metalness = 0) =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const mats = {
      floor: new THREE.MeshStandardMaterial({
        map: textures[0],
        normalMap: textures[1],
        roughnessMap: textures[2],
        roughness: 0.85,
        normalScale: new THREE.Vector2(0.35, 0.35),
      }),
      wood: new THREE.MeshStandardMaterial({
        map: woodMap,
        color: "#a78f78",
        roughness: 0.5,
      }),
      wall: new THREE.MeshStandardMaterial({
        color: "#dedfd9",
        normalMap: textures[4],
        normalScale: new THREE.Vector2(0.15, 0.15),
        roughness: 0.92,
      }),
      cloth: new THREE.MeshStandardMaterial({
        color: "#465758",
        normalMap: textures[3],
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.97,
      }),
      seat: new THREE.MeshStandardMaterial({
        color: "#252e34",
        normalMap: textures[3],
        normalScale: new THREE.Vector2(0.22, 0.22),
        roughness: 0.88,
      }),
      black: mat("#1e272c", 0.42, 0.3),
      chrome: mat("#8a9193", 0.26, 0.85),
      white: mat("#c4c8c6", 0.65),
      paper: mat("#e5e2d5", 0.96),
      blue: mat("#19313f", 0.85),
      glass: new THREE.MeshStandardMaterial({
        color: "#9eb8bc",
        transparent: true,
        opacity: 0.13,
        roughness: 0.14,
        metalness: 0.1,
        depthWrite: false,
      }),
      leaves: mat("#3f5341", 0.8),
      stem: mat("#524c33", 1),
      pot: mat("#bbb2a3", 0.8),
      coffee: mat("#281c13", 0.6),
      lamp: new THREE.MeshBasicMaterial({ color: "#fff5d8" }),
    };
    const screens = [
      surface("socket / client.ts", "code"),
      surface("status", "notes"),
      surface("", "paper"),
    ];
    textures.push(...screens);
    const display = screens.map(
      (t) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false }),
    );
    return { mats, textures, display };
  }, [loaded]);
  useEffect(
    () => () => {
      assets.textures.forEach((t) => t.dispose());
      Object.values(assets.mats).forEach((m) => m.dispose());
      assets.display.forEach((m) => m.dispose());
    },
    [assets],
  );
  const m = assets.mats;
  const monitor = (
    x: number,
    angle: number,
    index: number,
    select = onInspect,
  ) => (
    <group position={[x, 0.815, -0.27]} rotation={[0, angle, 0]}>
      <Block at={[0, 0.008, 0]} size={[0.34, 0.015, 0.22]} material={m.black} />
      <Rod from={[0, 0, 0]} to={[0, 0.32, 0]} r={0.022} material={m.chrome} />
      <Block at={[0, 0.38, 0]} size={[0.74, 0.45, 0.035]} material={m.black} />
      <mesh
        position={[0, 0.38, 0.02]}
        material={assets.display[index]}
        onClick={(e) => {
          e.stopPropagation();
          select();
        }}
      >
        <planeGeometry args={[0.7, 0.41]} />
      </mesh>
      <mesh position={[0.29, 0.18, 0.023]} material={m.lamp}>
        <sphereGeometry args={[0.0025, 6, 4]} />
      </mesh>
    </group>
  );
  const plant = (x: number, z: number) => (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.25, 0]} material={m.pot} castShadow>
        <cylinderGeometry args={[0.23, 0.17, 0.5, 24]} />
      </mesh>
      {Array.from({ length: 11 }, (_, i) => {
        const y = 0.65 + i * 0.07,
          a = i * 2.4,
          px = Math.sin(a) * 0.32,
          pz = Math.cos(a) * 0.32;
        return (
          <group key={i}>
            <Rod
              from={[0, 0.4, 0]}
              to={[px, y, pz]}
              r={0.008}
              material={m.stem}
            />
            <mesh
              position={[px, y, pz]}
              rotation={[0.25, a, 0.5]}
              scale={[0.07, 0.22, 0.024]}
              material={m.leaves}
              castShadow
            >
              <sphereGeometry args={[1, 12, 10]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
  const chair = (x: number, z: number, active = false) => (
    <group
      ref={active ? chairRef : undefined}
      name={active ? "backend-chair" : "station-chair"}
      position={[x, 0, z]}
      rotation={[0, Math.PI, 0]}
    >
      <Rod from={[0, 0.1, 0]} to={[0, 0.48, 0]} r={0.045} material={m.chrome} />
      {Array.from({ length: 5 }, (_, i) => (
        <group key={i} rotation={[0, (i * Math.PI * 2) / 5, 0]}>
          <Rod
            from={[0, 0.12, 0]}
            to={[0.31, 0.075, 0]}
            r={0.024}
            material={m.black}
          />
          <mesh
            position={[0.32, 0.06, 0]}
            rotation={[0, 0, Math.PI / 2]}
            material={m.black}
          >
            <cylinderGeometry args={[0.055, 0.055, 0.07, 14]} />
          </mesh>
        </group>
      ))}
      <Block
        at={[0, 0.49, 0]}
        size={[0.54, 0.085, 0.5]}
        radius={0.04}
        material={m.seat}
      />
      <Block
        at={[0, 0.86, -0.23]}
        size={[0.5, 0.64, 0.085]}
        radius={0.04}
        rotation={[-0.1, 0, 0]}
        material={m.seat}
      />
      <Rod
        from={[0, 0.4, -0.18]}
        to={[0, 1.15, -0.32]}
        r={0.034}
        material={m.black}
      />
      {[-1, 1].map((s) => (
        <group key={s}>
          <Rod
            from={[s * 0.27, 0.4, 0]}
            to={[s * 0.32, 0.72, -0.07]}
            r={0.018}
            material={m.chrome}
          />
          <Block
            at={[s * 0.32, 0.735, 0.01]}
            size={[0.075, 0.045, 0.32]}
            radius={0.02}
            material={m.black}
          />
        </group>
      ))}
    </group>
  );
  const desk = (x: number, z: number, active: boolean, select = onInspect) => (
    <group position={[x, 0, z]}>
      <Block
        at={[0, 0.785, 0]}
        size={[2.7, 0.055, 1.1]}
        radius={0.02}
        material={m.wood}
      />
      {[-1.17, 1.17].map((a) => (
        <group key={a}>
          <Block
            at={[a, 0.395, 0]}
            size={[0.06, 0.75, 0.78]}
            material={m.black}
          />
          <Block
            at={[a, 0.08, 0]}
            size={[0.09, 0.03, 0.8]}
            material={m.chrome}
          />
        </group>
      ))}
      <Block
        at={[0.96, 0.41, 0.05]}
        size={[0.39, 0.71, 0.65]}
        material={m.blue}
      />
      {[0.2, 0.42, 0.64].map((y) => (
        <group key={y}>
          <Block
            at={[0.96, y, 0.38]}
            size={[0.36, 0.008, 0.008]}
            material={m.black}
          />
          <Rod
            from={[0.87, y + 0.07, 0.4]}
            to={[1.05, y + 0.07, 0.4]}
            r={0.009}
            material={m.chrome}
          />
        </group>
      ))}
      {monitor(-0.43, 0.12, active ? 0 : 1, select)}
      {active && monitor(0.4, -0.15, 1, select)}
      <Block
        at={[KEYBOARD.x, KEYBOARD.y, KEYBOARD.z]}
        size={[0.57, 0.025, 0.2]}
        material={m.black}
      />
      <KeyboardKeys material={m.white} />
      <Block
        at={[0.31, 0.818, 0.27]}
        size={[0.24, 0.006, 0.28]}
        material={m.seat}
      />
      <mesh
        position={[0.31, 0.848, 0.26]}
        scale={[0.037, 0.022, 0.06]}
        material={m.black}
        castShadow
      >
        <sphereGeometry args={[1, 20, 12]} />
      </mesh>
      <mesh
        position={[-1, 0.82, 0.2]}
        rotation={[-Math.PI / 2, 0, 0.12]}
        material={assets.display[2]}
      >
        <planeGeometry args={[0.25, 0.32]} />
      </mesh>
      <Rod
        from={[-1.07, 0.83, 0.24]}
        to={[-0.91, 0.83, 0.27]}
        r={0.004}
        material={m.black}
      />
      <mesh position={[0.77, 0.906, 0.26]} material={m.white} castShadow>
        <cylinderGeometry args={[0.055, 0.049, 0.16, 24]} />
      </mesh>
      <mesh
        position={[0.77, 0.987, 0.26]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={m.coffee}
      >
        <circleGeometry args={[0.047, 24]} />
      </mesh>
      <mesh position={[0.83, 0.91, 0.26]} material={m.white}>
        <torusGeometry args={[0.037, 0.009, 8, 16]} />
      </mesh>
      <Rod
        from={[-1.06, 0.8, -0.3]}
        to={[-1.06, 1.2, -0.3]}
        r={0.012}
        material={m.black}
      />
      <Rod
        from={[-1.06, 1.2, -0.3]}
        to={[-0.89, 1.35, -0.13]}
        r={0.012}
        material={m.black}
      />
      <mesh position={[-0.89, 1.32, -0.13]} material={m.black} castShadow>
        <coneGeometry args={[0.11, 0.1, 24]} />
      </mesh>
      <Block
        at={[-0.85, 0.823, -0.02]}
        size={[0.11, 0.017, 0.19]}
        radius={0.01}
        material={m.black}
      />
      <Rod
        from={[-0.4, 0.8, -0.25]}
        to={[-0.3, 0.25, -0.4]}
        r={0.007}
        material={m.black}
      />
    </group>
  );
  return (
    <group name="detailed-office">
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.floor}>
        <planeGeometry args={[20, 20]} />
      </mesh>
      <Block at={[0, 0.44, -10]} size={[20, 0.88, 0.12]} material={m.wall} />
      <Block at={[0, 3.73, -10]} size={[20, 0.14, 0.12]} material={m.wall} />
      <Block at={[-10, 1.9, 0]} size={[0.12, 3.8, 20]} material={m.wall} />
      <Block at={[0, 0.08, -9.87]} size={[20, 0.16, 0.05]} material={m.black} />
      <Block at={[-9.88, 0.08, 0]} size={[0.05, 0.16, 20]} material={m.black} />
      <mesh position={[0, 2.25, -9.925]}>
        <planeGeometry args={[18.3, 2.6]} />
        <meshBasicMaterial color="#b4c6cf" />
      </mesh>
      {Array.from({ length: 16 }, (_, i) => (
        <group key={i}>
          <Block
            at={[-5 + i * 0.65, 1.3 + (i % 4) * 0.1, -9.86]}
            size={[0.51, 0.8 + (i % 4) * 0.2, 0.015]}
            material={i % 2 ? m.white : m.cloth}
            radius={0}
          />
        </group>
      ))}
      {[-9.2, -6.9, -4.6, -2.3, 0, 2.3, 4.6, 6.9, 9.2].map((x) => (
        <Block
          key={x}
          at={[x, 2.25, -9.74]}
          size={[0.065, 2.7, 0.11]}
          material={m.black}
        />
      ))}
      <Block
        at={[0, 0.93, -9.7]}
        size={[18.5, 0.07, 0.25]}
        material={m.white}
      />
      <Block
        at={[0, 3.59, -9.73]}
        size={[18.5, 0.06, 0.1]}
        material={m.black}
      />
      {Array.from({ length: 9 }, (_, i) => (
        <Block
          key={i}
          at={[0, 3.44 - i * 0.039, -9.65]}
          size={[18.3, 0.014, 0.07]}
          rotation={[0.2, 0, 0]}
          material={m.white}
          radius={0}
        />
      ))}
      {ROSTER.map((member) => (
        <group key={member.id}>
          {desk(member.x, member.z, member.id === "backend", () =>
            onSelectRole(member.id),
          )}
          {chair(
            member.x,
            member.z + (member.id === "backend" ? 0.9 : 1.05),
            member.id === "backend",
          )}
        </group>
      ))}
      <Block
        at={[-1.65, 0.8, -3.38]}
        size={[2.9, 1.4, 0.06]}
        material={m.cloth}
      />
      <Block
        at={[-3.13, 0.8, -2.65]}
        size={[0.06, 1.4, 1.5]}
        material={m.cloth}
      />
      <Block
        at={[-1.65, 1.515, -3.38]}
        size={[2.94, 0.027, 0.077]}
        material={m.chrome}
      />
      <mesh position={[-2.56, 1.2, -3.342]} material={assets.display[2]}>
        <planeGeometry args={[0.22, 0.3]} />
      </mesh>
      <Block at={[-9.4, 1.05, -2]} size={[0.75, 2.1, 3]} material={m.wood} />
      {[0.25, 0.8, 1.35, 1.9].map((y) => (
        <Block
          key={y}
          at={[-8.99, y, -2]}
          size={[0.05, 0.04, 2.86]}
          material={m.black}
        />
      ))}
      {Array.from({ length: 22 }, (_, i) => (
        <Block
          key={i}
          at={[-8.94, 0.46 + (i % 3) * 0.55, -3.3 + Math.floor(i / 3) * 0.35]}
          size={[0.25, 0.33, 0.055]}
          material={i % 3 ? m.blue : m.paper}
        />
      ))}
      {[-3, 2.8].map((x) => (
        <group key={x}>
          <Block
            at={[x, 1.9, -9.7]}
            size={[0.25, 3.8, 0.38]}
            material={m.blue}
          />
        </group>
      ))}
      <group visible={!overview}>
        <Block at={[0, 3.78, 0]} size={[20, 0.06, 20]} material={m.black} />
        {[-4, -1.5, 1, 3.5].map((x) =>
          [-3.5, -0.6, 2.3].map((z) => (
            <group key={`${x}:${z}`}>
              <Block
                at={[x, 3.67, z]}
                size={[2.35, 0.075, 2.7]}
                material={m.wall}
              />
              <Block
                at={[x, 3.6, z]}
                size={[0.65, 0.022, 0.36]}
                material={m.white}
              />
              {[-0.22, -0.11, 0, 0.11, 0.22].map((v) => (
                <Block
                  key={v}
                  at={[x + v, 3.58, z]}
                  size={[0.016, 0.01, 0.27]}
                  material={m.black}
                />
              ))}
            </group>
          )),
        )}
        {[-2, 2].map((x) => (
          <group key={x}>
            <Rod
              from={[x - 1, 3.75, -1.8]}
              to={[x - 1, 3.15, -1.8]}
              r={0.004}
              material={m.black}
            />
            <Rod
              from={[x + 1, 3.75, -1.8]}
              to={[x + 1, 3.15, -1.8]}
              r={0.004}
              material={m.black}
            />
            <Block
              at={[x, 3.13, -1.8]}
              size={[2.2, 0.06, 0.14]}
              material={m.black}
            />
            <Block
              at={[x, 3.096, -1.8]}
              size={[2.14, 0.008, 0.11]}
              material={m.lamp}
            />
          </group>
        ))}
      </group>
      <Block
        at={[7.5, 0.34, 1.8]}
        size={[1.25, 0.55, 2.5]}
        radius={0.08}
        material={m.cloth}
      />
      <Block
        at={[8.03, 0.74, 1.8]}
        size={[0.23, 0.72, 2.5]}
        radius={0.07}
        material={m.cloth}
      />
      {[0.8, 2.8].map((z) => (
        <Block
          key={z}
          at={[7.5, 0.65, z]}
          size={[1.25, 0.6, 0.22]}
          radius={0.06}
          material={m.cloth}
        />
      ))}
      <Block at={[5.8, 0.35, 1.8]} size={[0.9, 0.045, 1.4]} material={m.wood} />
      {[1.3, 2.3].map((z) => (
        <Rod
          key={z}
          from={[5.8, 0, z]}
          to={[5.8, 0.34, z]}
          r={0.035}
          material={m.black}
        />
      ))}
      {plant(-4.1, -4)}
      {plant(5, -4.2)}
      {plant(4.7, 3.6)}
    </group>
  );
}
