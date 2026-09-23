/** Presentation presets only: choosing a look never changes an agent's role or state. */
export const CHARACTERS = [
  {
    id: "suit",
    label: "Мужчина · Классический костюм",
    hair: "Тёмные волосы, боковой пробор",
    clothes: "Чёрный костюм, белая рубашка и красный галстук",
    shoes: "Чёрные кожаные туфли",
  },
  {
    id: "shirt",
    label: "Мужчина · Светлая рубашка",
    hair: "Короткая тёмная стрижка",
    clothes: "Светлая рубашка и чёрные брюки",
    shoes: "Туфли на толстой подошве",
  },
  {
    id: "bob",
    label: "Женщина · Бордовый жакет",
    hair: "Светлое каре, очки",
    clothes: "Бордовый жакет, водолазка и тёмные брюки",
    shoes: "Закрытые чёрные полуботинки",
  },
  {
    id: "skirt",
    label: "Женщина · Костюм с юбкой",
    hair: "Тёмная многослойная стрижка",
    clothes: "Серо-коричневый жакет и юбка",
    shoes: "Серые туфли на каблуке",
  },
] as const;
export type CharacterId = (typeof CHARACTERS)[number]["id"];
export type Appearance = { player: CharacterId; backend: CharacterId };
export const DEFAULT_APPEARANCE: Appearance = {
  player: "shirt",
  backend: "bob",
};
export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTERS.some((c) => c.id === value);
}
export function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(
      localStorage.getItem("office.appearance.v1") ?? "null",
    );
    if (saved && isCharacterId(saved.player) && isCharacterId(saved.backend))
      return { player: saved.player, backend: saved.backend };
  } catch {
    /* Storage can be unavailable; the office still works. */
  }
  return { ...DEFAULT_APPEARANCE };
}
export function characterUrl(id: CharacterId) {
  return `/assets/characters/${id}.glb`;
}
