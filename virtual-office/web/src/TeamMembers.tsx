import type { LiveSnapshot } from "./live-client";
import { useEffect, useMemo, useRef, Suspense } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { OfficeCharacter } from "./OfficeCharacter";
import { ROSTER, seatNumber, type Member, type RoleId } from "./roster";
function MemberSeat({
  status,
  member,
  onSelect,
}: {
  status?: string;
  member: Member;
  onSelect: (id: RoleId) => void;
}) {
  const position = useRef(new THREE.Vector3(member.x, 0, member.z + 1.05)),
    yaw = useRef(Math.PI),
    sit = useRef(1),
    walking = useRef(0);
  const sprite = useRef<THREE.Sprite>(null);
  const label = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const x = c.getContext("2d")!;
    x.fillStyle = "#f3f1e8";
    x.fillRect(0, 0, 512, 128);
    x.fillStyle = member.accent;
    x.fillRect(0, 0, 10, 128);
    x.fillStyle = "#28392e";
    x.font = "bold 31px system-ui";
    x.fillText(member.name + " / " + member.role, 25, 50);
    x.font = "22px system-ui";
    x.fillStyle = "#707968";
    x.fillText(
      "МЕСТО " + seatNumber(member.id) + " · " + (status ?? "НЕ ПОДКЛЮЧЁН"),
      25,
      93,
    );
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [member, status]);
  useEffect(() => () => label.dispose(), [label]);
  useFrame(({ camera }) => {
    if (sprite.current)
      sprite.current.visible =
        camera.position.distanceTo(position.current) < 11 &&
        camera.position.distanceTo(position.current) > 3;
  });
  return (
    <group name={`seat-${member.id}`}>
      <Suspense fallback={null}>
        <OfficeCharacter
          actorId={member.id}
          model={member.model}
          position={position}
          yaw={yaw}
          sit={sit}
          walking={walking}
        />
      </Suspense>
      <sprite
        ref={sprite}
        position={[member.x, 2.1, member.z + 1.05]}
        scale={[1.55, 0.388, 1]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(member.id);
        }}
      >
        <spriteMaterial map={label} />
      </sprite>
    </group>
  );
}
export function TeamMembers({
  onSelect,
  liveSnapshot,
}: {
  onSelect: (id: RoleId) => void;
  liveSnapshot?: LiveSnapshot | null;
}) {
  return (
    <>
      {ROSTER.filter((m) => m.id !== "backend").map((member) => (
        <MemberSeat
          key={member.id}
          member={member}
          onSelect={onSelect}
          status={
            liveSnapshot === undefined
              ? undefined
              : {
                  THINKING: "ГОТОВИТ ОТВЕТ",
                  DONE: "ОТВЕТ ГОТОВ",
                  ERROR: "ОШИБКА",
                  OFFLINE: "НЕ В СЕТИ",
                  IDLE: "ДОСТУПЕН",
                }[
                  liveSnapshot?.agents.find((a) => a.agentId === member.id)
                    ?.state ?? "OFFLINE"
                ]
          }
        />
      ))}
    </>
  );
}
