// Shared physical anchors: rendering and hand placement use the same keyboard.
export const DESK = { x: -1.65, z: -2.75 };
export const KEYBOARD = { x: 0, y: 0.829, z: 0.43, keyTop: 0.8535 };
export function typingContact(
  side: number,
  time: number,
): [number, number, number] {
  return [
    DESK.x + KEYBOARD.x + side * 0.1,
    KEYBOARD.keyTop + 0.004 + (1 + Math.sin(time * 8 + side)) * 0.002,
    DESK.z + KEYBOARD.z,
  ];
}
