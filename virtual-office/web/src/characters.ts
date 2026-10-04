/** Presentation presets only: choosing a look never changes an agent's role or state. */
export const CHARACTERS = [
  {
    id: "kai",
    label: "Мужчина · Синяя футболка",
    hair: "Короткая светлая стрижка",
    clothes: "Синяя футболка и светлые джинсы",
    shoes: "Тёмные кеды",
  },
  {
    id: "mira",
    label: "Женщина · Мятная футболка",
    hair: "Светлые волосы, пучок",
    clothes: "Мятная футболка и светлые джинсы",
    shoes: "Лёгкая обувь без каблука",
  },
  {
    id: "leo",
    label: "Мужчина · Поло и шорты",
    hair: "Небрежная короткая стрижка",
    clothes: "Полосатое поло и шорты",
    shoes: "Серые кеды",
  },
  {
    id: "noah",
    label: "Мужчина · Красный лонгслив",
    hair: "Короткие русые волосы",
    clothes: "Красный лонгслив и джинсы",
    shoes: "Серые кеды",
  },
  {
    id: "nika",
    label: "Женщина · Худи",
    hair: "Чёлка и хвост",
    clothes: "Тёмное худи и клетчатая юбка",
    shoes: "Высокие кеды",
  },
  {
    id: "ren",
    label: "Мужчина · Спортивная куртка",
    hair: "Объёмная тёмная стрижка",
    clothes: "Красная спортивная куртка и свободные брюки",
    shoes: "Белые кроссовки",
  },
  {
    id: "omar",
    label: "Мужчина · Графичная футболка",
    hair: "Длинные волосы, хвост",
    clothes: "Графичная футболка и свободные джинсы",
    shoes: "Тёмные кроссовки",
  },
  {
    id: "eva",
    label: "Женщина · Деним",
    hair: "Длинные распущенные волосы",
    clothes: "Серая футболка и джинсы",
    shoes: "Коричневые ботильоны",
  },
  {
    id: "luna",
    label: "Женщина · Розовая рубашка",
    hair: "Светлые волосы, высокий хвост",
    clothes: "Розовая рубашка и широкие джинсы",
    shoes: "Тёмные ботинки",
  },
  {
    id: "jules",
    label: "Мужчина · Светлый трикотаж",
    hair: "Тёмная стрижка назад",
    clothes: "Светлый свитер и тёмные брюки",
    shoes: "Коричневые кеды",
  },
  {
    id: "mei",
    label: "Женщина · Яркий топ",
    hair: "Асимметричное тёмное каре",
    clothes: "Яркий топ и тёмные брюки",
    shoes: "Балетки",
  },
  {
    id: "alex",
    label: "Женщина · Карго",
    hair: "Светлые волосы, собранные в пучок",
    clothes: "Кожаная куртка и карго",
    shoes: "Высокие ботинки",
  },
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
  backend: "noah",
};
export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTERS.some((c) => c.id === value);
}
export function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(
      localStorage.getItem("office.appearance.v2") ?? "null",
    );
    if (saved && isCharacterId(saved.player) && isCharacterId(saved.backend))
      return { player: saved.player, backend: saved.backend };
  } catch {
    /* Storage can be unavailable; the office still works. */
  }
  return { ...DEFAULT_APPEARANCE };
}
export function characterUrl(id: CharacterId) {
  return `${import.meta.env.BASE_URL ?? "/"}assets/characters/${id}.glb`;
}
