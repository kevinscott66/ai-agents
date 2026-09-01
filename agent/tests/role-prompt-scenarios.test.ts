import { describe, expect, test } from "bun:test";
import { CHARACTERS } from "../characters/index.ts";

const scenarios = [
  ["ASSIGN_TASK", "передать роли"],
  ["REQUEST_REVIEW", "нужна проверка"],
  ["COMMENT_TASK", "зафиксировать решение"],
  ["EDIT_MESSAGE", "исправления своего сообщения"],
  ["PIN_MESSAGE", "важного долгоживущего объявления"],
  ["FORWARD_MESSAGE", "исходный контекст сообщения"],
  ["SEND_PHOTO", "визуальный артефакт"],
] as const;

describe("role prompt coordination scenarios", () => {
  for (const character of CHARACTERS) {
    test(`${character.key} includes a use case for each coordination tool`, () => {
      for (const [action, context] of scenarios) {
        expect(character.system).toContain(action);
        expect(character.system).toContain(context);
      }
    });
  }

  test("every role uses the internal handoff contract", () => {
    for (const character of CHARACTERS) {
      expect(character.system).toContain("DELEGATE_TO_ROLE");
      expect(character.system).toContain("provider=internal");
      expect(character.system).toContain("GitHub Actions");
      expect(character.system).not.toContain("gh workflow run");
    }
  });
});
