import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { characterUrl, type CharacterId } from "./characters";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";

type Props = {
  model: CharacterId;
  position: RefObject<THREE.Vector3>;
  yaw: RefObject<number>;
  sit: RefObject<number>;
  walking: RefObject<number>;
  typing?: boolean;
  look?: RefObject<number>;
  player?: boolean;
};
/** Licensed skinned character. All inputs are presentation-only; no backend imports. */
export function OfficeCharacter({
  model,
  position,
  yaw,
  sit,
  walking,
  typing = false,
  look,
  player = false,
}: Props) {
  const gltf = useLoader(GLTFLoader, characterUrl(model));
  const { gl } = useThree();
  useEffect(() => {
    const attribute = player ? "playerCharacter" : "backendCharacter";
    gl.domElement.dataset[attribute] = model;
    return () => {
      delete gl.domElement.dataset[attribute];
    };
  }, [gl, model, player, gltf]);
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
        side: side === "L" ? 1 : -1,
      })),
    };
  }, [gltf]);
  const root = useRef<THREE.Group>(null),
    lastSit = useRef(sit.current),
    transition = useRef("standup"),
    clock = useRef(player ? 1.7 : 0),
    handWeight = useRef(0),
    gaze = useRef(0);
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
      look?.current ?? 0,
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
          originalElbow = arm.elbow.quaternion.clone();
        scratch.target.set(
          arm.side * 0.16,
          0.825 + Math.sin(clock.current * 8 + arm.side) * 0.003,
          0.63,
        );
        root.current.localToWorld(scratch.target);
        for (let iteration = 0; iteration < 5; iteration++)
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
    }
  });
  return (
    <group ref={root} name={player ? "player-character" : "backend-character"}>
      <primitive object={rig.object} dispose={null} />
    </group>
  );
}
