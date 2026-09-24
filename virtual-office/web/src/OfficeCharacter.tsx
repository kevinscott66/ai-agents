import type { Activity } from "./activity";
import { typingContact } from "./workstation";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { characterUrl, type CharacterId } from "./characters";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";

type Props = {
  model: CharacterId;
  actorId?: string;
  position: RefObject<THREE.Vector3>;
  yaw: RefObject<number>;
  sit: RefObject<number>;
  walking: RefObject<number>;
  typing?: boolean;
  desk?: { x: number; z: number };
  activity?: Activity;
  look?: RefObject<number>;
  player?: boolean;
};
/** Licensed skinned character. All inputs are presentation-only; no backend imports. */
export function OfficeCharacter({
  model,
  actorId = "backend",
  position,
  yaw,
  sit,
  walking,
  typing = false,
  desk,
  activity = "idle",
  look,
  player = false,
}: Props) {
  const gltf = useLoader(GLTFLoader, characterUrl(model));
  const { gl } = useThree();
  useEffect(() => {
    if (player) return;
    const key = `activity${actorId}`;
    gl.domElement.dataset[key] = activity;
    return () => {
      delete gl.domElement.dataset[key];
    };
  }, [gl, actorId, activity, player]);
  useEffect(() => {
    const attribute = player
      ? "playerCharacter"
      : actorId === "backend"
        ? "backendCharacter"
        : `actor${actorId}`;
    gl.domElement.dataset[attribute] = model;
    return () => {
      delete gl.domElement.dataset[attribute];
    };
  }, [gl, model, player, gltf, actorId]);
  const rig = useMemo(() => {
    const object = clone(gltf.scene),
      mixer = new THREE.AnimationMixer(object);
    object.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
      }
    });
    const actions = Object.fromEntries(
      gltf.animations.map((clip) => {
        const action = mixer.clipAction(clip);
        action.play();
        action.time = (actorId.length * 0.37) % clip.duration;
        action.setEffectiveWeight(0);
        return [clip.name, action];
      }),
    );
    return {
      object,
      mixer,
      actions,
      head: object.getObjectByName("Bip01_Head") as THREE.Bone,
      arms: ["L", "R"].map((side) => ({
        upper: object.getObjectByName(`Bip01_${side}_UpperArm`) as THREE.Bone,
        elbow: object.getObjectByName(`Bip01_${side}_Forearm`) as THREE.Bone,
        hand: object.getObjectByName(`Bip01_${side}_Hand`) as THREE.Bone,
        fingertip: object.getObjectByName(
          `Bip01_${side}_Finger12`,
        ) as THREE.Bone,
        side: side === "L" ? -1 : 1,
      })),
    };
  }, [gltf]);
  const root = useRef<THREE.Group>(null),
    lastSit = useRef(sit.current),
    transition = useRef("standup"),
    clock = useRef(player ? 1.7 : 0),
    handWeight = useRef(0),
    gaze = useRef(0),
    activityTime = useRef(0);
  useEffect(() => {
    activityTime.current = 0;
  }, [activity]);
  const scratch = useMemo(
    () => ({
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      target: new THREE.Vector3(),
      delta: new THREE.Quaternion(),
      worldQ: new THREE.Quaternion(),
      parentQ: new THREE.Quaternion(),
      desired: new THREE.Quaternion(),
      axis: new THREE.Vector3(1, 0, 0),
      palm: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI / 2,
      ),
      tip: new THREE.Vector3(),
    }),
    [],
  );
  useEffect(
    () => () => {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.object);
    },
    [rig],
  );
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.06),
      s = THREE.MathUtils.clamp(sit.current, 0, 1),
      w = THREE.MathUtils.clamp(walking.current, 0, 1);
    clock.current += dt;
    activityTime.current += dt;
    if (root.current) {
      root.current.position.copy(position.current);
      root.current.rotation.y = yaw.current;
      root.current.updateMatrixWorld(true);
    }
    if (Math.abs(s - lastSit.current) > 0.0001)
      transition.current = s > lastSit.current ? "sitdown" : "standup";
    lastSit.current = s;
    for (const action of Object.values(rig.actions))
      action.setEffectiveWeight(0);
    if (s > 0.03 && s < 0.98) {
      const a = rig.actions[transition.current];
      a.paused = true;
      a.time =
        (transition.current === "sitdown" ? s : 1 - s) * a.getClip().duration;
      a.setEffectiveWeight(1);
    } else if (s >= 0.98) {
      rig.actions.seated.setEffectiveWeight(1);
    } else {
      rig.actions.idle.setEffectiveWeight(1 - w);
      rig.actions.walk.setEffectiveWeight(w);
      rig.actions.walk.timeScale = 0.85 + w * 0.35;
    }
    rig.mixer.update(dt);
    handWeight.current = THREE.MathUtils.damp(
      handWeight.current,
      typing && s > 0.98 ? 1 : 0,
      5,
      dt,
    );
    gaze.current = THREE.MathUtils.damp(
      gaze.current,
      (look?.current ?? 0) +
        (activity === "waiting"
          ? -0.12 + Math.sin(clock.current * 0.8) * 0.025
          : activity === "done" && activityTime.current < 1.2
            ? Math.sin((activityTime.current * Math.PI) / 0.6) * 0.12
            : activity === "error"
              ? -0.09
              : 0),
      5,
      dt,
    );
    if (rig.head) {
      rig.head.quaternion.multiply(
        scratch.delta.setFromAxisAngle(scratch.axis, gaze.current),
      );
    }
    rig.object.updateMatrixWorld(true);
    // Bounded CCD on shoulder/elbow, then wrist orientation; no fake productivity events.
    if (handWeight.current > 0.005 && root.current) {
      for (const arm of rig.arms) {
        const weight = handWeight.current;
        const originalUpper = arm.upper.quaternion.clone(),
          originalElbow = arm.elbow.quaternion.clone(),
          originalHand = arm.hand.quaternion.clone();
        const orientPalm = () => {
          arm.hand.parent!.getWorldQuaternion(scratch.parentQ).invert();
          arm.hand.quaternion.copy(scratch.parentQ).multiply(scratch.palm);
          arm.hand.updateWorldMatrix(false, true);
        };
        orientPalm();
        // Solve the wrist from the actual index fingertip, not an arbitrary body offset.
        scratch.tip.set(1.5, 0, 0); // distal phalanx end, skeleton authored in centimetres
        arm.fingertip.localToWorld(scratch.tip);
        arm.hand.getWorldPosition(scratch.b);
        scratch.tip.sub(scratch.b);
        scratch.target
          .set(...typingContact(arm.side, clock.current, desk))
          .sub(scratch.tip);
        for (let iteration = 0; iteration < 24; iteration++)
          for (const joint of [arm.elbow, arm.upper]) {
            joint.getWorldPosition(scratch.a);
            arm.hand.getWorldPosition(scratch.b);
            scratch.b.sub(scratch.a).normalize();
            scratch.c.copy(scratch.target).sub(scratch.a).normalize();
            scratch.delta.setFromUnitVectors(scratch.b, scratch.c);
            joint.getWorldQuaternion(scratch.worldQ);
            joint.parent!.getWorldQuaternion(scratch.parentQ).invert();
            scratch.desired
              .copy(scratch.parentQ)
              .multiply(scratch.delta)
              .multiply(scratch.worldQ);
            joint.quaternion.copy(scratch.desired);
            joint.updateWorldMatrix(false, true);
          }
        orientPalm();
        arm.hand.quaternion.slerpQuaternions(
          originalHand,
          arm.hand.quaternion.clone(),
          weight,
        );
        arm.upper.quaternion.slerpQuaternions(
          originalUpper,
          arm.upper.quaternion.clone(),
          weight,
        );
        arm.elbow.quaternion.slerpQuaternions(
          originalElbow,
          arm.elbow.quaternion.clone(),
          weight,
        );
      }
      if (actorId === "backend" && handWeight.current > 0.99) {
        rig.object.updateMatrixWorld(true);
        const errors = rig.arms.map((arm) => {
          scratch.tip.set(1.5, 0, 0);
          arm.fingertip.localToWorld(scratch.tip);
          return scratch.tip.distanceTo(
            scratch.target.set(...typingContact(arm.side, clock.current, desk)),
          );
        });

        gl.domElement.dataset.typingError = String(Math.max(...errors));
      }
    }
  });
  return (
    <group
      ref={root}
      name={player ? "player-character" : `${actorId}-character`}
    >
      <primitive object={rig.object} dispose={null} />
    </group>
  );
}
