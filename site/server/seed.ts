// seed.ts — seed the DB with real digests + drops on first start
// (only when the respective table is empty). Real data, no placeholders.
//
// Источники в items/url — реальные публикации (theblock, cryptobriefing,
// bloomberg, coindesk, SEC, governance.aave.com и проектные сайты), собранные
// из веб-поиска по июню 2026. URL — только https; при upsert каждый прогоняется
// через safeStoredUrl.

import {
  countActivities,
  countDigests,
  countDrops,
  getDb,
  getMeta,
  setMeta,
  upsertActivity,
  upsertDigest,
  upsertDrop,
} from "./db.ts";
import type { Activity, Digest, Drop } from "./types.ts";

function toIso(date: string): string {
  // Accept "YYYY-MM-DD" and normalise to full ISO at midnight UTC.
  return new Date(`${date}T00:00:00.000Z`).toISOString();
}

const SEED_DIGESTS: Digest[] = [
  {
    id: "btc-eth-correction-etf-outflows-2026-06-12",
    title: "Биткоин держит $63K, эфир проседает — рынок в коррекции",
    date: toIso("2026-06-12"),
    summary:
      "Биткоин с начала года потерял около 30% и торгуется у $63K, эфир — ниже $1700. Спотовые BTC-ETF в США показали рекордную серию оттоков на $4,4 млрд.",
    items: [
      {
        text: "BTC у $63K, ETH тонет — что говорит график доминирования",
        url: "https://blockchainreporter.net/bitcoin-vs-ethereum-btc-holds-63k-while-eth-sinks-and-the-dominance-chart-explains-why/",
      },
      {
        text: "Рекордные оттоки из крипто-ETF в июне 2026",
        url: "https://bitcoinfoundation.org/news/crypto-etfs-news/crypto-etfs-june/",
      },
      {
        text: "Биткоин и эфир отскакивают на новостях о завершении войны",
        url: "https://finance.yahoo.com/personal-finance/investing/article/bitcoin-and-ethereum-prices-today-friday-june-12-2026-prices-rebound-this-morning-after-trump-claims-war-has-ended-115949042.html",
      },
    ],
    sourceCount: 3,
  },
  {
    id: "aave-risk-framework-kelpdao-2026-06-11",
    title: "Aave вводит жёсткий риск-фреймворк после взлома KelpDAO на $292M",
    date: toIso("2026-06-11"),
    summary:
      "После эксплойта KelpDAO на $292M Aave предлагает обязательный фреймворк оценки рисков активов, мостов и сетей. Несоответствующие активы будут отключены.",
    items: [
      {
        text: "Новый риск-фреймворк Aave после эксплойта KelpDAO",
        url: "https://www.theblock.co/post/404136/new-aave-risk-framework-proposed-following-kelpdao-exploit",
      },
      {
        text: "Stani: как Aave V4 откроет «безлимитное» кредитование",
        url: "https://www.cryptotimes.io/2026/06/11/stani-reveals-how-aave-v4-plans-to-unlock-unlimited-lending/",
      },
    ],
    sourceCount: 2,
  },
  {
    id: "sec-atkins-draft-strategic-plan-2026-06-02",
    title: "SEC Аткинса разворачивается к ясным правилам для крипты",
    date: toIso("2026-06-02"),
    summary:
      "SEC опубликовала драфт стратегического плана на 2026–2030 с цифровыми активами в центре: меньше расширительных исков, больше понятных правил. Комментарии принимаются до 2 июля.",
    items: [
      {
        text: "Драфт SEC: курс на ясность для цифровых активов",
        url: "https://www.mofo.com/resources/insights/260610-sec-s-draft-strategic-plan-pivots-to-digital-asset",
      },
      {
        text: "Крипта в стратегическом плане SEC на 2026–2030",
        url: "https://bitcoinmagazine.com/news/sec-highlights-crypto-in-strategic-plan",
      },
      {
        text: "Регулирование крипты в 2026: амбиции SEC и усиление CFTC",
        url: "https://www.theblock.co/post/383241/crypto-regulation-2026-sec-ambitious-agenda-empowered-cftc",
      },
    ],
    sourceCount: 3,
  },
  {
    id: "japan-regulates-crypto-like-stocks-2026-06-11",
    title: "Япония регулирует крипту как акции",
    date: toIso("2026-06-11"),
    summary:
      "Япония приравняла криптоактивы к ценным бумагам и заодно срезала налоги — расчёт на то, что это подтолкнёт рынок к росту.",
    items: [
      {
        text: "Япония приравнивает крипту к акциям",
        url: "https://www.bloomberg.com/news/articles/2026-06-12/japan-moves-to-regulate-crypto-like-stocks-in-market-growth-push",
      },
      {
        text: "Закон со сниженными налогами для роста",
        url: "https://www.coindesk.com/policy/2026/06/11/japan-passes-sweeping-bill-regulating-crypto-like-stocks-with-lower-taxes-to-drive-growth",
      },
    ],
    sourceCount: 2,
  },
  {
    id: "bittensor-tao-ai-rally-2026-06-13",
    title: "Bittensor (TAO) растёт на AI-нарративе и заявках на ETF",
    date: toIso("2026-06-13"),
    summary:
      "Токен TAO прибавил ~16% на фоне AI-события и заявок Grayscale и Bitwise на спотовые TAO-ETF. Сеть выросла с 65 до 128+ сабнетов.",
    items: [
      {
        text: "TAO целит в брейкаут: со-основатель называет это «AI-инфраструктурой»",
        url: "https://www.bitget.com/news/detail/12560605390111",
      },
      {
        text: "TAO-токен и AI-крипто тезис: где сеть в 2026",
        url: "https://yellow.com/news/bittensor-tao-token-ai-crypto-thesis-2026",
      },
    ],
    sourceCount: 2,
  },
  {
    id: "grayscale-canton-coin-etf-s1-2026-06-05",
    title: "Grayscale подал S-1 на спотовый ETF под Canton Coin",
    date: toIso("2026-06-05"),
    summary:
      "Grayscale зарегистрировал в SEC заявку на ETF, держащий токен CC сети Canton (~$38 млрд в обращении). 100 крупнейших кошельков контролируют ~89% предложения.",
    items: [
      {
        text: "Grayscale Canton ETF — форма S-1 (SEC)",
        url: "https://www.sec.gov/Archives/edgar/data/0002138284/000213828426000003/ck0002138284-20260605.htm",
      },
      {
        text: "Grayscale подаёт на Canton ETF для прямого хранения CC",
        url: "https://cryptobriefing.com/grayscale-canton-etf-filing/",
      },
    ],
    sourceCount: 2,
  },
  {
    id: "near-surge-pre-upgrade-2026-06-12",
    title: "NEAR взлетел на 30% перед апгрейдом сети",
    date: toIso("2026-06-12"),
    summary:
      "NEAR прибавил ~30% — рынок закладывается на динамический решардинг, который завезут в июньском апгрейде сети.",
    items: [
      {
        text: "NEAR +30% перед апгрейдом dynamic resharding",
        url: "https://cryptobriefing.com/near-protocol-surges-ai-token-rally/",
      },
      {
        text: "Детали апгрейда и динамика цены",
        url: "https://www.kucoin.com/blog/en-near-price-surges-30-ahead-of-june-2026-dynamic-resharding-upgrade",
      },
    ],
    sourceCount: 2,
  },
  {
    id: "a16z-wall-street-blockchain-355m-2026-06-11",
    title: "a16z вложился в блокчейн для Уолл-стрит",
    date: toIso("2026-06-11"),
    summary:
      "Andreessen Horowitz возглавил раунд на $355M в блокчейн-платформу, которой уже пользуются крупные игроки Уолл-стрит. Институционалы заходят в ончейн всерьёз.",
    items: [
      {
        text: "a16z ведёт раунд $355M",
        url: "https://www.bloomberg.com/news/articles/2026-06-11/andreessen-horowitz-backs-blockchain-used-by-wall-street-giants",
      },
    ],
    sourceCount: 1,
  },
  {
    id: "fhfa-crypto-mortgage-asset-2026-06-09",
    title: "США разрешают учитывать крипту как актив при ипотеке",
    date: toIso("2026-06-09"),
    summary:
      "Директор FHFA Уильям Пулте поручил Fannie Mae и Freddie Mac готовиться учитывать криптовалюту как актив при оформлении ипотеки.",
    items: [
      {
        text: "FHFA: крипта как актив для ипотеки",
        url: "https://finance.yahoo.com/personal-finance/investing/article/bitcoin-and-ethereum-prices-today-thursday-june-11-2026-prices-lifting-off-low-opening-figures-114705725.html",
      },
    ],
    sourceCount: 1,
  },
];

const SEED_DROPS_RAW: Omit<Drop, "id">[] = [
  {
    project: "Polymarket",
    status: "soon",
    deadline: null,
    url: "https://polymarket.com",
    description:
      "Рынок предсказаний. Токена ещё нет, но ставки и объёмы тут гоняют не первый год — один из самых очевидных кандидатов на ретродроп.",
  },
  {
    project: "Backpack",
    status: "active",
    deadline: null,
    url: "https://backpack.exchange",
    description:
      "Биржа от создателей Mad Lads. Баллы капают за торговлю — программа уже идёт, фармить можно прямо сейчас.",
  },
  {
    project: "MetaMask",
    status: "soon",
    deadline: null,
    url: "https://metamask.io",
    description:
      "Главный кошелёк Ethereum. Токен MASK обещают годами — за свопы и активность в самом кошельке.",
  },
  {
    project: "Base",
    status: "soon",
    deadline: null,
    url: "https://base.org",
    description:
      "L2 от Coinbase. Своего токена пока нет, но ончейн-активность тут почти наверняка зачтётся, когда дойдёт до раздачи.",
  },
  {
    project: "Monad",
    status: "active",
    deadline: null,
    url: "https://monad.xyz",
    description:
      "Быстрый L1, совместимый с EVM. Дроп MON уже анонсирован — под раздачу попадают те, кто пользовался Aave, Uniswap, Pendle и другими.",
  },
  {
    project: "LayerZero",
    status: "active",
    deadline: null,
    url: "https://layerzero.network",
    description:
      "Протокол для передачи сообщений между сетями. Засчитывается активность через мосты и приложения, что используют LayerZero под капотом.",
  },
  {
    project: "Hyperliquid",
    status: "active",
    deadline: null,
    url: "https://hyperliquid.xyz",
    description:
      "Perp-DEX на своём L1 с HyperEVM. После первой раздачи ждут второй сезон наград — есть смысл оставаться активным.",
  },
  {
    project: "MegaETH",
    status: "active",
    deadline: null,
    url: "https://megaeth.com",
    description:
      "Быстрый L2 для Ethereum, поднявший $107M. TGE метили на начало 2026 — пока его нет, активность продолжают фармить.",
  },
  {
    project: "Berachain",
    status: "ended",
    deadline: toIso("2026-02-06"),
    url: "https://www.berachain.com",
    description:
      "L1 на Proof-of-Liquidity. Мейннет и раздача BERA прошли в феврале — оставили здесь для истории, поезд уже ушёл.",
  },
  {
    project: "Reya Network",
    status: "active",
    deadline: null,
    url: "https://reya.network",
    description:
      "Торговый L2 — продукт уже работает, баллы начисляют за реальную торговлю. Из тех дропов, где фармить можно прямо сейчас.",
  },
  {
    project: "Silencio",
    status: "active",
    deadline: null,
    url: "https://www.silencio.network",
    description:
      "DePIN: меришь шум вокруг через приложение — за собранные данные капают очки. Низкий порог входа, делать можно с телефона.",
  },
];

const SEED_ACTIVITIES: Activity[] = [
  {
    id: "beep-poluchaem-nagrady-ot-proekta-beep",
    project: "Beep",
    emoji: "🤗",
    title: "Получаем награды от проекта Beep",
    intro:
      "Неделю назад был представлен Beep World Cup Predict Arena — прогнозы на матчи ЧМ за поинты для Airdrop; плюс кампания на Galxe с пулом до $500к в $BEEP к TGE.",
    whatIs:
      "Beep — лаборатория ИИ, разрабатывающая уникальную финансовую платформу.",
    steps: [
      "Заходим в Galxe и подключаем кошелёк.",
      "Выполняем социалки и забираем роль.",
      "Создаём аккаунт на сайте проекта.",
      "My Balances → USDC → депозит.",
      "Меняем режим кошелька на Predict, переносим активы из Treasury.",
      "Первый прогноз на ЧМ — в разделе AI Predict.",
      "Приглашаем реферала.",
    ],
    raised: "N/A",
    investors: "N/A",
    spent: "$0",
    time: "23 мин",
    rewardType: "Аирдроп",
    status: "Подтверждено",
    dateReceive: "TBA",
    url: "https://galxe.com",
    hashtags: ["Beep", "Airdrop", "Crypto", "DeFi", "Blockchain"],
    date: toIso("2026-06-18"),
  },
  {
    id: "earnos-farmim-roli-v-earnos-dlya-droppa",
    project: "EarnOS",
    emoji: "🍒",
    title: "Фармим роли в EarnOS для получения дропа",
    intro:
      "Не скипаем WL их приложения (всё ещё в разработке) и пробуем заработать роли в Discord — XION за такое щедро вознаграждал.",
    whatIs:
      "EarnOS — сервис цифровой рекламы: бренды взаимодействуют с пользователями и дают вознаграждения.",
    steps: [
      "Создаём Google/Apple аккаунт на США/Англия/Канада.",
      "Скачиваем приложение на смартфон.",
      "Регистрируем аккаунт и оставляем заявку (если нет — пробуем другую страну).",
      "Заходим в Discord, проходим базовую верификацию.",
      "Читаем инфу о ролях в #earnos-roles.",
    ],
    raised: "$23,5 млн",
    investors: "1kx, Coinbase Ventures и другие",
    spent: "$0",
    time: "9 мин",
    rewardType: "Аирдроп",
    status: "Подтверждено",
    dateReceive: "TBA",
    url: "https://get.ero.app",
    hashtags: ["EarnOS", "Airdrop", "Crypto", "DeFi", "Blockchain"],
    date: toIso("2026-06-19"),
  },
];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Отметка «эту базу уже разворачивали». Ставится и когда сеять не стали. */
const SEED_MARKER = "seeded_at";

/**
 * Развернуть пустую базу фикстурами — ОДИН раз за жизнь базы.
 *
 * Аудит 2026-08-12: решение принималось по каждой таблице отдельно
 * (`if (countDrops() === 0) …`) на КАЖДОМ старте, а `bootstrap()` зовётся при
 * каждом рестарте сервиса. Значит одной опустевшей таблицы хватало, чтобы в
 * живую базу доехали июньские фикстуры. Замер: база с 9 статьями из ингеста,
 * `DELETE FROM drops`, рестарт → 11 июньских дропов на публичном сайте; то же
 * с digests → девять июньских статей вместо настоящих. Отметки о том, что
 * базу уже разворачивали, не было — пустая таблица через полгода работы
 * выглядела как первый запуск.
 *
 * Теперь: сеем, только если база пуста ЦЕЛИКОМ и отметки нет. Отметку ставим
 * в обоих случаях — база, доросшая до содержимого без фикстур, больше их не
 * получит никогда.
 */
export function seedIfEmpty(): {
  digests: number;
  drops: number;
  activities: number;
} {
  let dig = 0;
  let drp = 0;
  let act = 0;
  const none = { digests: 0, drops: 0, activities: 0 };

  if (getMeta(SEED_MARKER)) return none;

  const existing = countDigests() + countDrops() + countActivities();
  if (existing > 0) {
    // База в работе: фикстуры сюда не подмешиваем, но отмечаем — чтобы
    // будущая чистка таблицы не выглядела первым запуском.
    setMeta(SEED_MARKER, new Date().toISOString());
    console.log(
      `[seed] db already has ${existing} rows — skipping fixtures, marked as bootstrapped`,
    );
    return none;
  }

  // Всё засеивание — одной транзакцией вместе с отметкой SEED_MARKER.
  // Аудит 2026-08-13: три цикла шли по отдельности, и падение посередине
  // оставляло половину фикстур. Следующий запуск видел `existing > 0`,
  // пропускал засеивание и ставил отметку — половина застывала навсегда.
  getDb().transaction(() => {
    if (countDigests() === 0) {
      for (const d of SEED_DIGESTS) {
        upsertDigest(d);
        dig++;
      }
      console.log(`[seed] inserted ${dig} digests`);
    }

    if (countDrops() === 0) {
      SEED_DROPS_RAW.forEach((d, i) => {
        const drop: Drop = { id: `${slug(d.project)}-${i}`, ...d };
        upsertDrop(drop);
        drp++;
      });
      console.log(`[seed] inserted ${drp} drops`);
    }

    if (countActivities() === 0) {
      for (const a of SEED_ACTIVITIES) {
        upsertActivity(a);
        act++;
      }
      console.log(`[seed] inserted ${act} activities`);
    }

    setMeta(SEED_MARKER, new Date().toISOString());
  })();
  return { digests: dig, drops: drp, activities: act };
}
