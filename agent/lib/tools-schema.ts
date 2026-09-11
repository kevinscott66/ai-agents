/**
 * C5/R-A: Anthropic tool_use схема + диспатчер.
 *
 * Аудит 2026-09-11: здесь было написано «все 12 инструментов идут через единый
 * `gateOrDispatch`». Неверно дважды. Инструментов в `TOOL_NAMES` двадцать три;
 * двенадцать — это `INLINE_TOOL_NAMES` из `constants.ts`, то есть ровно тот
 * набор, который через `gateOrDispatch` как раз НЕ идёт (см. разбор у
 * `executeInlineTool` ниже: ни CALLER_RESTRICTED, ни строка permissions к ним
 * не применяются, и минутный бакет «все инструменты агента» их тоже не видит).
 *
 * Через `gateOrDispatch` из `lib/action-dispatch.ts` идут остальные. Эта
 * функция отвечает только за:
 *   1. валидацию/нормализацию сырого LLM-инпута в строгий PayloadFor<T>,
 *   2. сериализацию структурированного результата в короткий JSON-текст
 *      для tool_result.
 */
import { getErrorMessage } from "./errors.ts";
import { INLINE_TOOL_NAMES } from "./constants.ts";
import Anthropic from "@anthropic-ai/sdk";
import type { Telegram } from "telegraf";
import type { ActionType } from "./permissions.ts";
import { agentStopReason, getAutonomy, isToolExposedToRole } from "./permissions.ts";
// Тот же фенс, что ставит сборщик system-промпта. Одна реализация на репозиторий
// — закрывашка, разошедшаяся в двух копиях, это дыра, которую никто не увидит
// (инвариант пришит tests/wiki-prompt-trust-boundary.test.ts).
import { untrusted } from "./agent-prompts.ts";
import {
  gateOrDispatch,
  buildPayload,
  formatGateResult,
} from "./action-dispatch.ts";
import { ALLOWED_REACTIONS } from "./telegram-actions.ts";
import { checkAndConsumeRateLimit } from "./rate-limits.ts";
import {
  wikiSearch,
  wikiRead,
  InvalidSlugError,
  ReservedSlugError,
  type Scope,
} from "./memory.ts";
import { CHARACTERS } from "../characters/index.ts";
import {
  type RunningBot,
  type InputImage,
  type InputDocument,
  TASK_STATUSES,
} from "./types.ts";
import type { HandoffDeps, RespondAsOpts } from "./handoff.ts";
import { db } from "./db.ts";
import { validateQueryDbSql, runQueryDbSandboxed } from "./query-db.ts";
import { renderMetrics } from "./miniapp-metrics.ts";
import { ACTION_STATUSES, isActionStatus, listActions, logToolCall } from "./audit.ts";
import { parseFigmaKey, fetchFigmaSummary, figmaConfigured } from "./figma.ts";
import { parseChannelId, fetchChannelStats, tgstatConfigured } from "./tgstat.ts";
import { fetchGithubStatus, githubConfigured } from "./github.ts";
import { log } from "./log.ts";

const ROLE_KEYS = CHARACTERS.map((c) => c.key);

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "CREATE_TASK",
    description:
      "Создать задачу в трекере команды и (опционально) сразу назначить её на роль. Используй для делегирования работы коллегам по команде.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Краткая формулировка задачи." },
        description: {
          type: "string",
          description: "Развёрнутое описание/контекст.",
        },
        assignedTo: {
          type: "string",
          enum: ROLE_KEYS as unknown as string[],
          description: "Ключ роли-исполнителя.",
        },
        priority: {
          type: "integer",
          description: "0..100, чем больше, тем важнее.",
        },
        parentTaskId: {
          type: "string",
          description: "id родительской задачи (если это подзадача).",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "ASSIGN_TASK",
    description:
      "Зови, когда задача уже существует, но лежит не у той роли: тебе прислали чужую работу, или по ходу выяснилось, что нужен другой профиль (в тексте про UI — это frontend, про схему БД — backend). Переназначает исполнителя, не создавая дубликат. Если задачи ещё нет — DELEGATE_TO_ROLE или CREATE_TASK, а не этот тул.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        assignedTo: {
          type: "string",
          enum: ROLE_KEYS as unknown as string[],
        },
      },
      required: ["taskId", "assignedTo"],
    },
  },
  {
    name: "UPDATE_TASK_STATUS",
    description:
      "Изменить статус задачи (FSM): pending→running→done/failed/awaiting_review и т.д.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        output: { type: "string", description: "Итог работы (если done)." },
        error: { type: "string", description: "Причина (если failed)." },
      },
      required: ["taskId", "status"],
    },
  },
  {
    name: "REQUEST_REVIEW",
    description:
      "Зови вместо UPDATE_TASK_STATUS=done, когда работа сделана, но ты не последняя инстанция: тронул чужую зону, поменял поведение в проде, не уверен в решении. Переводит задачу в awaiting_review — она остаётся видимой команде, пока кто-то не посмотрит. Молчаливый done по спорной работе — то, из-за чего ошибки находят в проде, а не в ревью.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        comment: { type: "string", description: "Краткое сопровождение." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "COMMENT_TASK",
    description:
      "Зови, когда по задаче есть что сказать, но статус менять рано: нашёл причину, но не починил; ждёшь ответа; попробовал подход и он не сработал. Запись видна всем, кто откроет задачу позже, — в том числе тебе самому в следующей сессии с пустым контекстом. Дешевле, чем заново разбираться. Статус не трогает.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        text: { type: "string" },
      },
      required: ["taskId", "text"],
    },
  },
  {
    name: "SEND_MESSAGE",
    description:
      "Отправить новое сообщение в чат. По умолчанию — в текущий чат. Можно ответить на конкретное сообщение (replyToMessageId). Orchestrator может использовать via_userbot:true чтобы опубликовать сообщение от реального аккаунта владельца (@owner_darkside) — только для официальных объявлений и решений от лица владельца; требует approval.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Текст сообщения." },
        replyToMessageId: {
          type: "number",
          description: "ID сообщения, на которое ставится reply.",
        },
        via_userbot: {
          type: "boolean",
          description:
            "T-410: Send as the owner's real account via MTProto userbot (@owner_darkside). Orchestrator-only. Use for: authoritative announcements, owner-decisions, replies that must read as the owner's voice. Do NOT use for routine team messages — that is the Lead bot's job. Requires approval in semi_auto mode.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "SET_REACTION",
    description:
      "Поставить emoji-реакцию на сообщение в Telegram. Лёгкое действие, по умолчанию идёт без approval. Для системных сообщений или произвольного эмодзи (включая Premium, не из bot-API whitelist) — set via_userbot: true.",
    input_schema: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description:
            "Одиночный emoji реакции. Через Bot API допустимы ТОЛЬКО из официального whitelist Telegram: " +
            ALLOWED_REACTIONS.join(" ") +
            ". Через via_userbot: true допустим любой emoji (включая Premium).",
        },
        messageId: {
          type: "number",
          description: "ID сообщения (по умолчанию — то, на которое отвечаем).",
        },
        via_userbot: {
          type: "boolean",
          description:
            "Use the MTProto userbot instead of Bot API. Required for: deleting service messages (joins/leaves/pins), reacting with any emoji (incl. Premium), reacting to messages the bot can't see. Default false.",
        },
      },
      required: ["emoji"],
    },
  },
  {
    name: "EDIT_MESSAGE",
    description:
      "Зови, когда в уже отправленном сообщении ошибка — опечатка, битая ссылка, неверная цифра. Правка на месте лучше, чем ещё одно сообщение «извините, там опечатка»: читателю не нужно склеивать два поста. Нужен messageId своего сообщения. Требует подтверждения в semi_auto/auto.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "number" },
        text: { type: "string" },
      },
      required: ["messageId", "text"],
    },
  },
  {
    name: "PIN_MESSAGE",
    description:
      "Зови, когда сообщение должно оставаться на виду после того, как чат уедет вверх: правила, текущий релиз, ссылка на активный опрос, статус инцидента. Не для «важного на сегодня» — закреп один, и каждый новый вытесняет предыдущий. Видимое действие в группе, требует подтверждения.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "number" },
        disableNotification: { type: "boolean" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "DELETE_MESSAGE",
    description:
      "Удалить сообщение из чата. Необратимое действие, требует подтверждения. Чтобы удалить системное сообщение (вход/выход/закреп/смена фото) — set via_userbot: true.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "number" },
        via_userbot: {
          type: "boolean",
          description:
            "Use the MTProto userbot instead of Bot API. Required for: deleting service messages (joins/leaves/pins), reacting with any emoji (incl. Premium), reacting to messages the bot can't see. Default false.",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "FORWARD_MESSAGE",
    description:
      "Зови, когда важен оригинал с автором и временем: показать команде, что именно написал пользователь, поднять чужое сообщение в тред обсуждения. Пересказ своими словами теряет и авторство, и точную формулировку — а по ней потом разбирают инцидент. Если нужен только смысл, дешевле SEND_MESSAGE.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "number" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "CREATE_POLL",
    description:
      "Создать опрос в чате. options — массив вариантов (2..10, каждый до 100 символов), question — до 300 символов. Требует подтверждения.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
        },
        isAnonymous: { type: "boolean" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "SEND_PHOTO",
    description:
      "Отправить картинку в чат — либо по публичному URL, либо как base64-data. Укажи ровно одно из полей url/base64. Зови, когда картинка УЖЕ существует: ссылка из источника, скриншот, ранее сгенерированный файл. Если картинки ещё нет — сначала GENERATE_IMAGE (растр) или GENERATE_SVG_IMAGE (схема/баннер), они отправляют сами, и звать SEND_PHOTO после них не нужно.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Публичный URL картинки." },
        base64: { type: "string", description: "Картинка в base64 (без data:-префикса)." },
        caption: { type: "string", description: "Подпись к фото." },
        replyToMessageId: { type: "number" },
      },
    },
  },
  {
    name: "SEND_DOCUMENT",
    description:
      "Отправить текстовый файл (документ) в чат — например .md/.txt/.json/.csv с отчётом, аудитом, выгрузкой. Содержимое передаёшь строкой в content, имя файла (с расширением) — в filename. Используй, когда результат большой или его удобнее приложить файлом, а не постить простынёй в чат.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Текстовое содержимое файла." },
        filename: {
          type: "string",
          description: "Имя файла с расширением, напр. audit.md или report.csv.",
        },
        caption: { type: "string", description: "Короткая подпись к файлу." },
        replyToMessageId: { type: "number" },
      },
      required: ["content", "filename"],
    },
  },
  {
    name: "CREATE_TEAM_CHANNEL",
    description:
      "Создать НОВЫЙ Telegram-канал от имени владельца (userbot) и сразу добавить туда ботов команды админами с правом постинга. Только лид (orchestrator). Возвращает chat_id канала (-100…). Параметры: title, about (опц.), roles — массив ролей чьих ботов добавить (напр. [\"smm\",\"design\",\"copy\"]); лид-контролёр добавляется автоматически. Используй для «создай канал и наполняй его командой».",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название канала." },
        about: { type: "string", description: "Описание канала (опц.)." },
        roles: {
          type: "array",
          items: { type: "string", enum: ROLE_KEYS as unknown as string[] },
          description: "Роли, чьих ботов добавить админами (smm/design/copy/…).",
        },
      },
      required: ["title", "roles"],
    },
  },
  {
    name: "PUBLISH_TO_CHANNEL",
    description:
      "Опубликовать пост в созданный командой Telegram-канал (channelId из CREATE_TEAM_CHANNEL). ПРЕВЬЮ: дай coverTitle (+coverSubtitle) — сами отрисуем баннер с логотипом DeLabs (дату подставим). По умолчанию баннер ИЛЛЮСТРИРОВАННЫЙ (яркий фон-арт крипто/AI из пула + чёткий оверлей заголовка/даты/лого). Для серьёзного/официального поста передай coverStyle=clean — строгий тёмный баннер без картинки. Если coverTitle не дашь — баннер сделаем из заголовка поста сами. Баннер идёт картинкой над текстом, ОДНИМ сообщением. Полноценный объём как в образце DeLabs (вводный абзац + 5-6 развёрнутых пунктов), НЕ ужимай. Держи весь текст в пределах ~1900 символов — тогда баннер и текст точно уходят одним постом.\n" +
      "Публикуем через аккаунт-владельца: эмодзи из набора DeLabs становятся АНИМИРОВАННЫМИ автоматически — просто ставь обычные эмодзи (🤑📰🗓️✅🤩🙌😮❌💰🔥👉👇⭐️😎). Подбирай их ПО СМЫСЛУ статуса пункта (✅ ок/подтверждено, 🔥 горячее, ❌ закрыто/провал, 😮 неожиданно, 💰 деньги/доход, 🗓️ дата). 💬 в НАЧАЛЕ строки НЕ ставь: этим эмодзи размечается футер, и такая строка выпадет с карточки на сайте — внутри строки он можно.\n" +
      "ФОРМАТИРОВАНИЕ (Markdown → Telegram HTML, рендерится корректно): **жирный**, *курсив*, ~~зачёркнутый~~, `код`, [текст](https://url) — ссылки, «> » в начале строки — цитата (подряд = одна; «>! » — раскрывающаяся), ||спойлер||. ЗАГОЛОВКИ пунктов/секций — **жирным**, И ВНУТРИ текста выделяй **жирным** самые важные фрагменты (ключевые цифры, суммы, дедлайны, названия, вывод) — не только заголовки. НЕ переусердствуй: 1-2 жирных акцента на пункт. НЕ пиши сырой HTML. НЕ используй разделители-строки «---» / «***» между пунктами — они не нужны.\n" +
      "ЯЗЫК: пиши по-русски, переводи англицизмы — Airdrop→дроп/раздача токенов, eligibility→право на участие/проходишь ли, whitelist→вайтлист/список, listing→листинг/размещение, points→поинты/баллы, document intelligence→анализ документов. ОСТАВЛЯЙ устоявшиеся: Web3, IT, AI, NFT, DeFi, DAO, токен.\n" +
      "СТИЛЬ — человечный, как живой автор, НЕ пресс-релиз. Образцы: @deployladeploy (экспертно-разговорный, ирония, личный опыт) и @delabsru (энергичный, дружеский, по делу).\n" +
      "ВЫБЕРИ ШАБЛОН под пост:\n" +
      "1) Горячий обзор+критика: провокац.заголовок → личный опыт («неделю гонял…») → плюсы/минусы → вердикт (можно неоднозначный).\n" +
      "2) Тех-инструкция+наработка: концепция → твоё решение/код → практ.советы → ссылка.\n" +
      "3) Философский монолог: лирич.вступление → мысль на тему → неожид.поворот → вопрос/CTA читателям.\n" +
      "4) Новость+контекст: коротко о релизе → что это даёт → личное мнение о важности → источник.\n" +
      "5) Лайфхак+решение: проблема → готовый промпт/скрипт → быстрый результат → пример.\n" +
      "6) Дайджест/сводка: приветствие → нумерованный список пунктов (проект → суть → действие) → подпись-концовка. КАЖДЫЙ пункт ОБЯЗАН иметь 2-3 строки описания под заголовком — НЕ оставляй заголовок-строку (напр. «🗓️ #FTX: дедлайн…») без раскрытия: что произошло, что делать, ссылка-источник. Заголовок без описания — брак.\n" +
      "ФУТЕР: для дайджестов в стиле DeLabs заканчивай пост строкой-футером «💬 ЧАТ сообщества | Активности © Copyright 2023-2026 DeLabs🤑». Ссылки в нём (ЧАТ/Активности/DeLabs) мы ПРОСТАВИМ САМИ автоматически — тебе достаточно просто оставить эту строку (без «---» над ней), ссылки писать не нужно.\n" +
      "ТЕМЫ: LLM-модели и их эволюция, AI-агенты/оркестрация, вайбкодинг/Claude Code, оптимизация/память, инструменты разработчика, критика хайпа индустрии, Web3/airdrop-дайджесты (для крипто-канала).\n" +
      "ОТБОР+ФАКТЫ (обязательно для новостей/дайджестов): бери САМОЕ популярное и актуальное за период (по обсуждаемости/охвату), а не случайное. Каждый факт проверь web_search МИНИМУМ по 2 независимым источникам; цифры (суммы, поинты, даты) — только из источника. Сомнительное/непроверяемое НЕ публикуй (лучше меньше пунктов). Подозрение на фейк/скам/неподтверждённый airdrop → выкинь или явно помечай как неподтверждённое. К пунктам — ссылки на источники.\n" +
      "ЧЕЛОВЕЧНОСТЬ: крючок в начале (не «Представляем вашему вниманию»); живая речь, лёгкая самоирония, личный угол («сам недавно…», «честно —…»); короткие абзацы 1-3 строки; **жирным** только ударное; эмодзи 1-2 по делу; конкретика>вода; варьируй длину предложений; концовка — мысль/вывод или ненавязчивый CTA, не «подписывайтесь и лайк». Пиши как для своих.\n" +
      "СТОП — это убивает пост (маркеры ИИ-текста, НЕ употребляй): «является», «представляет собой», «играет важную роль», «важно/необходимо/стоит отметить», «в современном мире», «в эпоху цифровизации», «не секрет, что», «динамично развивается», «откройте для себя», «в заключение». НЕ превращай глаголы в существительные («осуществление внедрения» → «внедрили»). НЕ ставь длинное тире в каждом предложении. НЕ делай всё списком (переизбыток буллетов = робот). НЕ оставляй английских калек и неестественного порядка слов. Гладко-безлико = плохо; нужен живой голос, детали, ирония.",
    input_schema: {
      type: "object",
      properties: {
        channelId: { type: "number", description: "ID канала (из CREATE_TEAM_CHANNEL)." },
        text: { type: "string", description: "Текст поста (Markdown). Человечный стиль — см. описание. Полноценный объём (как образец DeLabs), без искусственного ужимания." },
        coverTitle: { type: "string", description: "Заголовок для дизайнерского баннера-превью (рекомендуется). Коротко, ≤60 симв." },
        coverSubtitle: { type: "string", description: "Подзаголовок баннера (опц.). НЕ дублируй сюда дату — её подставим сами." },
        coverStyle: { type: "string", enum: ["illustrated", "clean"], description: "Стиль баннера: illustrated (по умолч.) — яркая фон-иллюстрация + оверлей; clean — строгий тёмный баннер без картинки (для серьёзных/официальных постов)." },
        coverPrompt: { type: "string", description: "Англ. промпт для ИИ-картинки-превью (опц., альтернатива баннеру)." },
        photoUrl: { type: "string", description: "URL готовой картинки-превью (опц.)." },
        photoBase64: { type: "string", description: "Готовая картинка base64 без префикса (опц.)." },
      },
      required: ["channelId", "text"],
    },
  },
  {
    name: "GENERATE_IMAGE",
    description:
      "Сгенерировать растровое изображение (фотореализм, иллюстрация, портрет, мокап) по текстовому промпту через OpenAI gpt-image-1, и отправить в чат. Для постеров/баннеров/схем/инфографики используй GENERATE_SVG_IMAGE — он бесплатнее и векторнее. Промпт — на английском, ≤4000 символов.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Английский промпт для модели." },
        caption: { type: "string", description: "Подпись к фото в Telegram." },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024", "auto"] },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        background: { type: "string", enum: ["transparent", "opaque", "auto"] },
        replyToMessageId: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "DELEGATE_TO_ROLE",
    description:
      "Делегировать задачу другому агенту команды по его роли. Используй вместо @-mention. role — ключ агента из списка, task — что сделать. Бэкенд синхронно поднимет того агента и опубликует его ответ в чат от его имени.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ROLE_KEYS as unknown as string[],
          description: "Ключ роли-получателя.",
        },
        task: {
          type: "string",
          description: "Что нужно сделать (русский ok).",
        },
        context: {
          type: "string",
          description: "Дополнительный контекст.",
        },
      },
      required: ["role", "task"],
    },
  },
  {
    name: "SPLIT_TASK",
    description:
      "Разделить ОДНУ задачу между несколькими ролями параллельно: создаётся родительская задача и N дочерних, каждая делегируется через DELEGATE_TO_ROLE с _parent_task_id. Только для orchestrator. Используй, когда нужна совместная работа нескольких ролей над одной целью.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Краткая формулировка задачи." },
        description: { type: "string", description: "Развёрнутое описание." },
        roles: {
          type: "array",
          items: { type: "string", enum: ROLE_KEYS as unknown as string[] },
          description: "Список ролей-исполнителей (2+).",
        },
        context: { type: "string", description: "Дополнительный контекст." },
      },
      required: ["title", "roles"],
    },
  },
  {
    name: "LIST_RECENT_MESSAGES",
    description:
      "Получить список недавних сообщений из локальной памяти чата (включая системные [service] сообщения о вход/выход/закреп). Используй ПЕРЕД DELETE_MESSAGE, чтобы узнать message_id системных сообщений, которые нужно удалить через via_userbot: true.",
    input_schema: {
      type: "object",
      properties: {
        since: {
          type: "number",
          description: "Unix-timestamp (ms). Только сообщения с ts >= since. По умолчанию — без ограничения.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["text", "service", "all"] },
          description: "Какие сообщения вернуть: 'service' (системные), 'text' (обычные) или 'all'. По умолчанию ['service'].",
        },
        limit: {
          type: "integer",
          description: "Сколько строк вернуть (1..200, дефолт 50).",
        },
      },
    },
  },
  {
    name: "SEARCH_WIKI",
    description:
      "Поиск по командной вики (FTS5). По умолчанию ищет в '_team' и в твоём личном scope. Возвращает список хитов: scope/slug | title | snippet.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос (слова/фразы)." },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Scope-ы для поиска: '_team' и/или ключи ролей. По умолчанию ['_team', <твоя роль>].",
        },
        limit: {
          type: "integer",
          description: "Сколько хитов вернуть (1..10, дефолт 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "READ_WIKI",
    description:
      "Прочитать полное содержимое страницы вики по (scope, slug). Возвращает markdown или null, если страницы нет.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "'_team' или ключ роли." },
        slug: { type: "string", description: "Slug страницы (как в SEARCH_WIKI)." },
      },
      required: ["scope", "slug"],
    },
  },
  {
    name: "GET_BOT_INFO",
    description:
      "Read-only: вернуть информацию о СВОЁМ боте (id, username, first_name, права в группах) через getMe. Используй, когда нужно знать свой @username/id без вопроса пользователю.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "GET_METRICS",
    description:
      "Read-only: текущие метрики системы (Prometheus-формат): build info, mac_bridge, счётчики действий, latency и т.п. Используй для диагностики состояния, а не для бизнес-аналитики.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "QUERY_DB",
    description:
      "Read-only SQL по операционной БД для backend: SELECT/WITH/EXPLAIN/PRAGMA table_info. Один запрос, авто-LIMIT. Приватные таблицы (messages, wiki, audit, approvals, content_calendar, agent_prompts) ЗАКРЫТЫ. Для логов — GET_LOGS, для вики — SEARCH_WIKI. Валидация схем/индексов/планов запросов.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Один read-only запрос (SELECT/WITH/EXPLAIN/PRAGMA)." },
        limit: { type: "integer", description: "Лимит строк (1..200, дефолт 50)." },
      },
      required: ["sql"],
    },
  },
  {
    name: "GET_GITHUB_STATUS",
    description:
      "Read-only: статус репозитория проекта на GitHub — последние запуски CI (workflow runs: status/conclusion/branch), открытые PR (номер/заголовок/draft/ветка), последние коммиты (sha/сообщение/автор). Для backend/qa: «прошёл ли CI», «что висит в PR». Параметров нет (репо фиксирован на сервере).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "GET_CHANNEL_STATS",
    description:
      "Read-only: статистика Telegram-канала из TGStat (подписчики, средний охват, дневной охват, ER%, ERR24%, число постов, упоминания, репосты, CI-индекс). Для SMM-аналитики. Параметр: channel (@username или ссылка t.me). Работает по каналам, доступным на тарифе TGStat.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "@username канала или ссылка t.me/…" },
      },
      required: ["channel"],
    },
  },
  {
    name: "GET_FIGMA_FILE",
    description:
      "Read-only: прочитать дизайн-файл Figma по ссылке и вернуть компактную сводку (имя, страницы, top-level фреймы и компоненты, счётчики стилей/компонентов). Для designer: понять структуру макета, когда пользователь прислал ссылку Figma. Параметр: fileUrl (ссылка) или fileKey.",
    input_schema: {
      type: "object",
      properties: {
        fileUrl: { type: "string", description: "Ссылка на файл Figma." },
        fileKey: { type: "string", description: "Ключ файла (если без ссылки)." },
      },
    },
  },
  {
    name: "GET_PROMPT_HISTORY",
    description:
      "Read-only: история версий system-промпта роли (aieng/аудит изменений). Возвращает version/edited_by/edited_at/applied/reason + превью (≤200 симв), без полного дампа промпта. Параметры: agentKey (роль), limit (1..50, дефолт 10).",
    input_schema: {
      type: "object",
      properties: {
        agentKey: { type: "string", description: "Ключ роли (orchestrator/backend/…)." },
        limit: { type: "integer", description: "Сколько версий (1..50, дефолт 10)." },
      },
      required: ["agentKey"],
    },
  },
  {
    name: "GET_LOGS",
    description:
      "Read-only: последние действия агентов из audit-лога (agent/action/status/error). Для диагностики «что реально происходило / какие были ошибки». Фильтры: agentKey, status (напр. 'error'), limit (1..50, дефолт 20). Без payload/переписки.",
    input_schema: {
      type: "object",
      properties: {
        agentKey: {
          type: "string",
          enum: ROLE_KEYS as unknown as string[],
          description: "Фильтр по роли (опц.). Только существующий ключ роли, напр. 'design' (не 'designer').",
        },
        status: {
          type: "string",
          enum: ["attempted", "ok", "error", "forbidden", "pending_approval", "rate_limited"],
          description: "Фильтр по статусу (опц.). Только из списка; «неуспех» — это 'error', не 'failed'.",
        },
        limit: { type: "integer", description: "Сколько записей (1..50, дефолт 20)." },
      },
    },
  },
  {
    name: "LIST_SCHEDULED_POSTS",
    description:
      "Read-only: список запланированных (status='scheduled') постов из контент-календаря: id, channel, scheduled_at, overdue, content (текст поста). Опционально фильтр по channel. Автопубликации нет: overdue=true означает, что время прошло, а пост НЕ отправлен. Для SMM/контент-планирования.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Фильтр по каналу (опционально)." },
      },
    },
  },
  {
    name: "CANCEL_SCHEDULED_POST",
    description:
      "Отменить запланированный пост по id (status scheduled → cancelled). Обратимо только пере-планированием. Сначала найди id через LIST_SCHEDULED_POSTS.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id запланированного поста." },
      },
      required: ["id"],
    },
  },
  {
    name: "WRITE_WIKI",
    description:
      "Записать (создать/перезаписать) страницу в вики. scope — только '_team' или твой собственный ключ роли. Используй для долгоживущих заметок: решения, чек-листы, контекст проекта.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "'_team' или твой собственный ключ роли." },
        slug: { type: "string", description: "Slug страницы (можно с подпапкой: 'projects/foo')." },
        title: { type: "string", description: "Заголовок страницы." },
        content: { type: "string", description: "Тело в markdown." },
      },
      required: ["scope", "slug", "title", "content"],
    },
  },
  {
    name: "MAC_RUN_CLAUDE",
    description:
      "Stage A: запустить Claude Code CLI на личном MacBook оператора в указанном проекте. Mac-демон спавнит `claude` с заданным prompt'ом и режимом разрешений. Только orchestrator может вызывать; пользователь должен быть в whitelist MAC_USER_IDS. Начинай с plan, если не уверен: это единственный режим, который ничего не исполняет.",
    input_schema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Абсолютный путь к рабочей папке на Mac. Демон пускает только пути внутри разрешённых корней оператора — это не весь диск: `/`, `/tmp` и домашний каталог целиком отклоняются, это самая частая причина отказа тула. Корень — папка с проектами оператора, обычно вида `/Users/<имя>/programs/...`. Точного списка ты не знаешь заранее: если промахнулся, ошибка `project_not_allowed` вернёт разрешённые корни — возьми путь оттуда и повтори, а не перебирай соседние каталоги наугад. Несуществующую папку под разрешённым корнем демон создаст сам.",
        },
        prompt: { type: "string", description: "Промпт для Claude CLI." },
        mode: {
          type: "string",
          enum: ["ask", "accept_edits", "plan", "auto", "bypass"],
          description: "plan = только планирование, ничего не исполняется; ask = каждое действие требует подтверждения на Mac; accept_edits = правки применяются сами, опасные команды всё равно спрашивают; auto = синоним accept_edits (на CLI отображается в тот же acceptEdits, отдельного «всё без спроса» здесь нет); bypass = обход всех проверок разрешений на машине владельца: требует MAC_ALLOW_BYPASS=true И подтверждения человека при любой autonomy.",
        },
      },
      required: ["project", "prompt", "mode"],
    },
  },
  {
    name: "MAC_STOP",
    description:
      "Остановить запущенный процесс Claude на Mac, отправив SIGINT. Используй когда нужно прервать долго выполняющуюся команду Mac Control.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "GENERATE_SVG_IMAGE",
    description:
      "Напиши валидный SVG (width/height в px, тёмные тексты на светлом фоне или наоборот, viewBox), бэкенд отрендерит его в PNG и отправит как фото. Размер SVG ≤ 200KB. Полезно для постеров, баннеров, схем, инфографики, мокапов UI.",
    input_schema: {
      type: "object",
      properties: {
        svg: { type: "string", description: "Полный SVG-документ, начинающийся с <svg ...>." },
        caption: { type: "string", description: "Подпись к итоговой картинке." },
        replyToMessageId: { type: "number" },
      },
      required: ["svg"],
    },
  },
  {
    name: "SCHEDULE_POST",
    description:
      "Записать пост в SMM-календарь на определённое время. НЕ отправляет: автопубликации в проекте нет, в назначенный момент пост публикуется через PUBLISH_TO_CHANNEL. Не обещай пользователю, что пост уйдёт сам.",
    input_schema: {
      type: "object",
      properties: {
        channel: { 
          type: "string", 
          description: "ID канала или username (@channel_name)" 
        },
        content: { 
          type: "string", 
          description: "Текст поста для отправки" 
        },
        scheduledAt: {
          type: "number",
          description: "Когда отправить пост: Unix-время в МИЛЛИСЕКУНДАХ (как Date.now()). Секунды тоже принимаются и домножаются."
        },
      },
      required: ["channel", "content", "scheduledAt"],
    },
  },
];

export interface ExecCtx {
  agentKey: string;
  chatId: number;
  /** T-240: bot id for per-bot-per-chat rate limiting. */
  botId?: number;
  telegram?: Telegram;
  triggerMessageId?: number;
  /** C10: resolver from role-key → RunningBot, used by DELEGATE_TO_ROLE. */
  resolveAgent?: (role: string) => RunningBot | undefined;
  /** C10: deps bundle for the recursive respondAs call. */
  handoffDeps?: HandoffDeps;
  /** C10 (test seam): override respondAs implementation. */
  respondAsImpl?: (
    opts: RespondAsOpts,
    deps: HandoffDeps,
  ) => Promise<import("./handoff.ts").HandoffOutcome | string | null>;
  /**
   * C13 anti-pingpong: full ordered delegation chain so far (root first → current
   * agent last). Forwarded into dispatch for DELEGATE_TO_ROLE cycle check.
   */
  delegationChain?: string[];
  /**
   * S1: общий на весь ход счётчик handoff-вызовов. Заводится в tool-loop (один
   * на ход, независимо от входа) и доезжает до DELEGATE_TO_ROLE, чтобы тот
   * тратил его, а не открывал новый запас на каждую ветку.
   */
  handoffBudget?: { n: number; max: number };
  /**
   * Вложения ЭТОГО хода пользователя (картинки и текстовые документы).
   * Прокидываются в делегата: в истории от них остаётся только «[image]» /
   * «[файл: x.md]». См. комментарий в DispatchCtx.
   */
  inputImages?: InputImage[];
  inputDocuments?: InputDocument[];
  /** Stage-A: triggering Telegram user_id, used by MAC_RUN_CLAUDE whitelist. */
  triggerUserId?: string;
  /**
   * T-410 (T-303 HIGH #2): request-id propagated from the ingress (telegram
   * update, Mini App HTTP, mac-bridge, scheduler tick) through dispatch and
   * audit_log. When omitted, gateOrDispatch lazily generates one.
   */
  requestId?: string;
}

interface ToolResult {
  ok: boolean;
  taskId?: string;
  approvalId?: string;
  actionId?: string;
  status?: string;
  reason?: string;
  error?: string;
  [extra: string]: unknown;
}

function fmt(r: ToolResult): string {
  return JSON.stringify(r);
}

/**
 * Инструменты, которые executeTool отдаёт в gateOrDispatch. Экспортируется
 * ради инварианта в тестах: TOOLS = TOOL_NAMES ∪ INLINE_TOOL_NAMES.
 */
export const TOOL_NAMES = new Set<string>([
  "SEND_MESSAGE",
  "CREATE_TASK",
  "ASSIGN_TASK",
  "UPDATE_TASK_STATUS",
  "REQUEST_REVIEW",
  "COMMENT_TASK",
  "SET_REACTION",
  "EDIT_MESSAGE",
  "PIN_MESSAGE",
  "DELETE_MESSAGE",
  "FORWARD_MESSAGE",
  "CREATE_POLL",
  "SEND_PHOTO",
  "SEND_DOCUMENT",
  "CREATE_TEAM_CHANNEL",
  "PUBLISH_TO_CHANNEL",
  "GENERATE_SVG_IMAGE",
  "GENERATE_IMAGE",
  "DELEGATE_TO_ROLE",
  "WRITE_WIKI",
  "SPLIT_TASK",
  "LIST_RECENT_MESSAGES",
  "MAC_RUN_CLAUDE",
  "MAC_STOP",
  // 2026-08-02: инструмент был объявлен в TOOLS, получил payload-валидатор и
  // case в диспатчере — но не попал сюда, поэтому executeTool отбивал его на
  // `unknown tool` ДО gateOrDispatch: ни строки в agent_actions, ни ошибки в
  // дайджесте. Модель видела инструмент, вызывала его и получала отказ.
  "SCHEDULE_POST",
]);

/**
 * Инструменты, которые executeTool обслуживает сам (короткое замыкание до
 * gateOrDispatch): read-only справочники и запросы. Держим списком, чтобы
 * тест мог утверждать TOOLS = TOOL_NAMES ∪ INLINE_TOOL_NAMES — иначе новый
 * инструмент снова молча провалится в «unknown tool».
 */
/**
 * Инлайновые тулзы, переживающие autonomy=locked: только чтение собственной
 * вики команды. Список намеренно крошечный — всё остальное под стоп-краном
 * владельца молчит (см. комментарий в executeTool).
 */
const LOCKED_EXEMPT_INLINE_TOOLS = new Set<string>(["SEARCH_WIKI", "READ_WIKI"]);

// Набор переехал в lib/constants.ts (лист) — причина в докблоке там же.
// Реэкспорт оставлен, чтобы все существующие импорты продолжили работать.
export { INLINE_TOOL_NAMES };

const ROLE_KEYS_SET = new Set<string>(ROLE_KEYS);

/**
 * Диспатчер tool_use. Возвращает короткий JSON-текст для tool_result.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ExecCtx,
): Promise<string> {
  const i = (input ?? {}) as Record<string, unknown>;

  // Аудит 2026-08-04: инлайновые инструменты замыкаются ДО gateOrDispatch, то
  // есть ни CALLER_RESTRICTED, ни строка permissions к ним не применяются вовсе.
  // Для них ROLE_EXPOSED_TOOLS оставался только фильтром выдачи в промпте, а
  // список тулзов — не граница безопасности: он держится на том, что модель не
  // назовёт неотданный ей инструмент. У QUERY_DB (произвольный SELECT по
  // операционной БД, без chat-скоупа) это была ЕДИНСТВЕННАЯ преграда — при том
  // что шапка ROLE_EXPOSED_TOOLS прямо обещает in-handler проверку.
  //
  // Проверка здесь, а не ещё двумя хардкодами: закрывается весь класс сразу,
  // и следующая инлайновая тулза не повторит историю CANCEL_SCHEDULED_POST
  // (мутация в read-only блоке, мимо гейта — SEC-audit 2026-06-10 F1).
  // Точечные проверки в GET_PROMPT_HISTORY и CANCEL_SCHEDULED_POST оставлены
  // намеренно: они дают конкретную формулировку отказа и переживут случайное
  // удаление записи из ROLE_EXPOSED_TOOLS.
  if (INLINE_TOOL_NAMES.has(name) && !isToolExposedToRole(name, ctx.agentKey)) {
    return fmt({
      ok: false,
      error: `forbidden: ${name} недоступен роли ${ctx.agentKey}`,
    });
  }

  // Аудит 2026-08-09: пауза и выключение действовали ровно на половину
  // инструментов. Оба флага во всём проде читались из одного места —
  // evaluateGate (lib/permissions.ts), а инлайновые тулзы до гейта не доходят.
  // Поэтому остановленный агент продолжал ходить в QUERY_DB (произвольный
  // SELECT по операционной БД), GET_LOGS, GET_PROMPT_HISTORY — и, что хуже,
  // в CANCEL_SCHEDULED_POST, то есть мутировать календарь. Для `disabled` это
  // особенно грубо: статус ставится через approved CHANGE_AGENT_STATUS и
  // документирован как «агент полностью инертен».
  if (INLINE_TOOL_NAMES.has(name)) {
    const stop = agentStopReason(ctx.agentKey);
    if (stop) return fmt({ ok: false, error: `agent ${stop}` });

    // Autonomy `locked` — это стоп-кран владельца на чат, и гейт по нему
    // отказывает ВСЕМУ, включая read-only: LIST_RECENT_MESSAGES убрали из
    // набора исключений именно затем, чтобы история чата не утекала «потому
    // что это же просто чтение» (T-313, finding #9; сам набор с 2026-08-10
    // зовётся LOW_FRICTION_ACTIONS и стоит уже ПОД проверкой `locked`, а не
    // над ней). Инлайновый путь при этом
    // отдавал куда больше: весь QUERY_DB по операционной БД, логи, историю
    // системных промптов — и отменял запланированные посты. Исключение одно —
    // собственная вики команды: ни PII, ни денег, ни мутации, а без неё агент
    // в locked-чате перестаёт помнить даже свои же заметки.
    if (!LOCKED_EXEMPT_INLINE_TOOLS.has(name) && getAutonomy(ctx.chatId, ctx.agentKey) === "locked") {
      return fmt({ ok: false, error: "autonomy locked" });
    }

    // Аудит 2026-09-11: третий слой того же класса. Лимитер зовётся только
    // внутри гейта (`checkRateLimit` в action-dispatch.ts), а бакет «все
    // инструменты агента» (ALL_AGENT_TOOLS_RULE, 60/мин) задуман общим для
    // всего, что агент делает. Инлайновая ветка до него не доходила, поэтому
    // минутное окно обходилось простым выбором инструмента из этого списка:
    // внутри одного прогона потолок оставался (MAX_CALLS_PER_TOOL_PER_RUN=8 в
    // tool-loop.ts), а межпрогонного не было вовсе — цикл ходов, ретраи и
    // несколько чатов параллельно упирались только в него.
    //
    // Дороже всего это стоило у QUERY_DB (произвольный SELECT по операционной
    // БД, без chat-скоупа) и у CANCEL_SCHEDULED_POST — единственной мутации в
    // списке. Считаем и коммитим одним синхронным вызовом: `checkRateLimit`
    // оставляет окно гонки между проверкой и коммитом, а здесь его закрыть
    // нечем — своей резервации у инлайнового пути нет.
    const rl = checkAndConsumeRateLimit(ctx.agentKey, name);
    if (!rl.ok) {
      const reason = rl.reason ?? "rate limited";
      const retryInMs = rl.retryInMs ?? 0;
      // Отказ пишется в журнал ровно так же, как это делает гейтованный путь
      // (`action-dispatch.ts`, ветка `!rl.ok`): `log.info` плюс строка со
      // статусом `rate_limited`. Иначе получилась бы дыра ровно того вида, о
      // котором предупреждает комментарий у аудита QUERY_DB ниже: отсутствие
      // записей читается как отсутствие запросов. И `checkRateLimitStorm`
      // (alerting.ts) считает шторм по этим самым строкам — тихий отказ он бы
      // не увидел вовсе, хотя зациклившийся агент — это ровно тот случай,
      // ради которого сигнал написан. Вход в payload не кладём: у инлайновых
      // тулз он не аудируется нигде (у QUERY_DB — только усечённый SQL и
      // только на своей ветке), и отказ не повод заводить исключение.
      log.info("rate limited", {
        agentKey: ctx.agentKey,
        actionType: name,
        reason,
        retryInMs,
        requestId: ctx.requestId ?? null,
      });
      try {
        logToolCall(name, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId ?? null,
          payload: {},
          status: "rate_limited",
          error: reason,
          requestId: ctx.requestId ?? null,
        });
      } catch (e) {
        log.warn("[inline] не удалось записать аудит отказа лимитера", {
          actionType: name,
          error: getErrorMessage(e),
        });
      }
      return fmt({
        ok: false,
        error: `rate_limited: ${reason}`,
        retryInMs,
      });
    }
  }

  // C11: read-only wiki tools — pure reads, no gate, no audit-log. Общий
  // минутный бакет агента с 2026-09-11 их всё-таки считает (см. выше).
  if (name === "SEARCH_WIKI") {
    const query = String(i.query ?? "").trim();
    if (!query) return fmt({ ok: false, error: "query is required" });
    const explicitScopes = Array.isArray(i.scopes)
      ? (i.scopes as unknown[]).map((x) => String(x))
      : null;
    const rawScopes = explicitScopes ?? ["_team", ctx.agentKey];
    const isScope = (s: string) => s === "_team" || ROLE_KEYS_SET.has(s);
    // Аудит 2026-08-29: неизвестный scope в явном списке — это отказ, а не
    // тихая отбраковка. Полный промах фильтра ("no valid scopes") модель
    // видела и раньше, а вот частичный — нет: ["_team","backend","bakcend"]
    // отдавал хиты первых двух так, будто искали по всем трём, и модель
    // делала единственный доступный ей вывод — «в bakcend совпадений нет».
    // Опечатка в имени роли — самый вероятный источник такого списка, и
    // именно она получалась неотличимой от пустой выдачи. Рядом стоящие
    // соседи ведут себя так же: READ_WIKI ниже отвечает `unknown scope: …`,
    // LIST_RECENT_MESSAGES отбивает неизвестные `kinds`.
    //
    // Умолчание `["_team", ctx.agentKey]` проверке не подлежит: его составили
    // мы, а не модель, и `ctx.agentKey` в теории может не быть ролью — падать
    // на собственном значении по умолчанию было бы хуже, чем сузить поиск.
    if (explicitScopes) {
      const unknown = explicitScopes.filter((s) => !isScope(s));
      if (unknown.length > 0) {
        return fmt({
          ok: false,
          error: `unknown scope: ${unknown.join(", ")}`,
        });
      }
    }
    const scopes = rawScopes.filter(isScope);
    if (scopes.length === 0) {
      return fmt({ ok: false, error: "no valid scopes" });
    }
    const rawLimit = typeof i.limit === "number" ? (i.limit as number) : 5;
    const limit = Math.max(1, Math.min(10, Math.floor(rawLimit)));
    try {
      const hits = wikiSearch(query, scopes as Scope[], limit);
      // Аудит 2026-08-11: см. READ_WIKI ниже — то же содержимое, тот же фенс.
      // Заголовок и выдержка отдельными полями не возвращаются намеренно: они
      // целиком лежат внутри `line`, и вторая, незаграждённая копия того же
      // текста сделала бы фенс украшением. scope/slug остаются машинными —
      // грамматика slug'а проверена, и именно ими агент зовёт READ_WIKI.
      const formatted = hits.map((h) => ({
        scope: h.scope,
        slug: h.slug,
        line: untrusted(`wiki:${h.scope}/${h.slug}`, `${h.title} | ${h.snippet}`),
      }));
      return fmt({ ok: true, hits: formatted, count: formatted.length });
    } catch (e) {
      const msg = getErrorMessage(e);
      return fmt({ ok: false, error: msg });
    }
  }
  if (name === "READ_WIKI") {
    const scope = String(i.scope ?? "");
    const slug = String(i.slug ?? "").trim();
    if (!scope || !slug) {
      return fmt({ ok: false, error: "scope and slug are required" });
    }
    if (!(scope === "_team" || ROLE_KEYS_SET.has(scope))) {
      return fmt({ ok: false, error: `unknown scope: ${scope}` });
    }
    try {
      const content = wikiRead(scope as Scope, slug);
      // Аудит 2026-08-11: страница уходила в контекст модели голым текстом.
      // 2026-08-10 фенс поставили на пути «push» (индексы, общий лог и хиты
      // поиска в system-промпте), а этот путь — «pull» — остался открыт, хотя
      // отдаёт больше: не выдержку в 1200 символов, а СТРАНИЦУ ЦЕЛИКОМ, и
      // страницу выбирает модель. Рядом с tool_result к тому же нет
      // WIKI_TRUST_BOUNDARY, который на том пути объясняет, как это читать.
      // Пишет в вики не человек: компактор решает сам, без подтверждения, а
      // `_team` один на все чаты.
      return fmt({
        ok: true,
        scope,
        slug,
        content:
          content === null ? null : untrusted(`wiki:${scope}/${slug}`, content),
      });
    } catch (e) {
      // `log` сюда попадает не по недоразумению: системный промпт показывает
      // модели раздел «последние записи в общем логе» с меткой
      // `wiki:_team/log.md`, и на вопрос «а что было в прошлом месяце» она
      // тянется за полной версией. Полной версии здесь нет и быть не должно —
      // штатные читатели берут хвост 64 КБ именно потому, что файл растёт до
      // мегабайта, а мегабайт кириллицы в tool_result роняет ход целиком.
      if (e instanceof ReservedSlugError) {
        return fmt({ ok: false, error: `reserved_slug: ${e.message}` });
      }
      if (e instanceof InvalidSlugError) {
        return fmt({ ok: false, error: "invalid_slug" });
      }
      const msg = getErrorMessage(e);
      return fmt({ ok: false, error: msg });
    }
  }

  // ── Read-only role-tools (T-710..712) — без gate/approval, как wiki-чтение ──
  if (name === "GET_BOT_INFO") {
    if (!ctx.telegram) return fmt({ ok: false, error: "no telegram context" });
    try {
      const me = await ctx.telegram.getMe();
      return fmt({
        ok: true,
        id: me.id,
        username: me.username,
        first_name: me.first_name,
        can_join_groups: me.can_join_groups,
        can_read_all_group_messages: me.can_read_all_group_messages,
      });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "GET_METRICS") {
    try {
      const text = renderMetrics();
      // Прометей-текст бывает длинным — отдаём срез, чтобы не жечь контекст.
      const MAX = 3000;
      return fmt({
        ok: true,
        format: "prometheus",
        metrics: text.length > MAX ? text.slice(0, MAX) + "\n…(truncated)" : text,
      });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "QUERY_DB") {
    // Валидация, readonly-соединение и таймаут живут в lib/query-db.ts —
    // там же расписано, почему одного префикса и денилиста мало.
    //
    // Аудит 2026-08-04: пишем строку в agent_actions. Раньше единственный
    // тул, читающий операционную БД целиком, не оставлял следа нигде, кроме
    // текстового лога процесса. Строки ответа в result НЕ кладём — только
    // счётчик: аудит не должен становиться вторым хранилищем выгрузки.
    const audit = (
      sql: string,
      status: "ok" | "error",
      extra: { result?: unknown; error?: string },
    ) => {
      try {
        logToolCall("QUERY_DB", {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId ?? null,
          payload: { sql: sql.slice(0, 1000) },
          status,
          result: extra.result,
          error: extra.error ?? null,
          requestId: ctx.requestId ?? null,
        });
      } catch (e) {
        // Аудит не должен ронять сам вызов — но и молчать о своём отказе
        // тоже не должен, иначе дыра в журнале выглядит как отсутствие
        // запросов.
        log.warn("[QUERY_DB] не удалось записать аудит", {
          error: getErrorMessage(e),
        });
      }
    };
    const v = validateQueryDbSql(i.sql, i.limit);
    if (!v.ok) {
      audit(String(i.sql ?? ""), "error", { error: v.error });
      return fmt({ ok: false, error: v.error });
    }
    const res = await runQueryDbSandboxed(v.sql, v.limit);
    audit(
      v.sql,
      res.ok ? "ok" : "error",
      res.ok
        ? { result: { count: res.count, truncated: res.truncated ?? false } }
        : { error: res.error },
    );
    return fmt(res);
  }
  if (name === "GET_GITHUB_STATUS") {
    if (!githubConfigured()) {
      return fmt({ ok: false, error: "GITHUB_READ_TOKEN не настроен на сервере" });
    }
    try {
      const status = await fetchGithubStatus();
      return fmt({ ok: true, ...status });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "GET_CHANNEL_STATS") {
    if (!tgstatConfigured()) {
      return fmt({ ok: false, error: "TGSTAT_TOKEN не настроен на сервере" });
    }
    const channelId = parseChannelId(String(i.channel ?? i.channelId ?? ""));
    if (!channelId) {
      return fmt({ ok: false, error: "укажи channel (@username или ссылку t.me)" });
    }
    try {
      const stats = await fetchChannelStats(channelId);
      return fmt({ ok: true, channel: channelId, ...stats });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "GET_FIGMA_FILE") {
    if (!figmaConfigured()) {
      return fmt({ ok: false, error: "FIGMA_TOKEN не настроен на сервере" });
    }
    const key = parseFigmaKey(String(i.fileUrl ?? i.fileKey ?? ""));
    if (!key) {
      return fmt({ ok: false, error: "укажи fileUrl (ссылку Figma) или fileKey" });
    }
    try {
      const summary = await fetchFigmaSummary(key);
      return fmt({ ok: true, ...summary });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "GET_PROMPT_HISTORY") {
    // SEC-audit 2026-06-10 (F3): system-prompt previews are restricted IP —
    // consistent with UPDATE_AGENT_PROMPT (aieng-only) + the QUERY_DB denylist
    // that blocks agent_prompts. Only aieng/orchestrator may read prompt history.
    if (ctx.agentKey !== "aieng" && ctx.agentKey !== "orchestrator") {
      return fmt({ ok: false, error: "forbidden: GET_PROMPT_HISTORY restricted to aieng/orchestrator" });
    }
    const agentKey = String(i.agentKey ?? "").trim();
    if (!agentKey || !ROLE_KEYS_SET.has(agentKey)) {
      return fmt({ ok: false, error: "valid agentKey is required" });
    }
    try {
      const rawLimit = typeof i.limit === "number" ? (i.limit as number) : 10;
      const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
      const rows = db
        .prepare(
          `SELECT version, edited_by, edited_at, applied_at, rejected_at, closed_at,
                  reason, prompt
           FROM agent_prompts WHERE agent_key = ?
           ORDER BY version DESC LIMIT ?`,
        )
        .all(agentKey, limit) as Array<{
        version: number;
        edited_by: string;
        edited_at: number;
        applied_at: number | null;
        rejected_at: number | null;
        closed_at: number | null;
        reason: string;
        prompt: string;
      }>;
      // Метаданные версий + короткое превью (не дампим полный системный промпт).
      const history = rows.map((r) => ({
        version: r.version,
        edited_by: r.edited_by,
        edited_at: r.edited_at,
        applied: r.applied_at != null,
        // Аудит 2026-08-27: до колонки `rejected_at` (миграция 048) отказ и
        // «ещё не решено» приходили сюда одинаково — `applied: false`. Роль
        // читала историю правок system prompt'ов и не могла отличить версию,
        // которую владелец ЗАРУБИЛ, от той, что просто ждёт очереди, — то есть
        // могла переспросить ровно то, в чём ей уже отказали.
        rejected: r.rejected_at != null,
        // Аудит 2026-09-10: четвёртого исхода не было, а он есть — заявка может
        // кончиться ничем (протухла по TTL либо исполнение упало уже после
        // одобрения). Складывать его в «rejected» нельзя по той же причине, по
        // которой заведена сама колонка: роль прочтёт это как решение владельца
        // и не переспросит, хотя владелец не сказал ничего. Складывать в
        // «pending» — врать, что решение ещё впереди: заявки уже нет.
        closed: r.closed_at != null,
        status:
          r.applied_at != null
            ? "applied"
            : r.rejected_at != null
              ? "rejected"
              : r.closed_at != null
                ? "closed"
                : "pending",
        reason: r.reason,
        preview: r.prompt.slice(0, 200) + (r.prompt.length > 200 ? "…" : ""),
        length: r.prompt.length,
      }));
      return fmt({ ok: true, agentKey, count: history.length, history });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "GET_LOGS") {
    try {
      // Аудит 2026-08-20: оба фильтра — закрытые множества, но неизвестное
      // значение уходило в WHERE как есть и давало пустую выборку с ok:true.
      // Модель по здравому смыслу пишет `designer` (роль называется `design`)
      // или `failed` (в большинстве API «неуспех» зовётся так) — и получает
      // «count: 0», из которого докладывает пользователю «ошибок нет», хотя
      // они есть. Тот же класс ошибки уже чинили в /audit (commands.ts) и
      // закрыт в GET_PROMPT_HISTORY выше; GET_LOGS оставался последним.
      const agentKey =
        typeof i.agentKey === "string" && i.agentKey.trim() ? i.agentKey.trim() : undefined;
      if (agentKey !== undefined && !ROLE_KEYS_SET.has(agentKey)) {
        return fmt({
          ok: false,
          error: `unknown agentKey ${JSON.stringify(agentKey)}; допустимые: ${ROLE_KEYS.join(", ")}`,
        });
      }
      const status =
        typeof i.status === "string" && i.status.trim() ? i.status.trim() : undefined;
      if (status !== undefined && !isActionStatus(status)) {
        return fmt({
          ok: false,
          error: `unknown status ${JSON.stringify(status)}; допустимые: ${ACTION_STATUSES.join(", ")}`,
        });
      }
      const rawLimit = typeof i.limit === "number" ? (i.limit as number) : 20;
      const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
      // SEC-audit F4 (T-725): scope to the caller's chat — no cross-chat leak.
      const rows = listActions({ agentKey, status, limit, chatId: ctx.chatId });
      // S-by-design: компактная проекция структурированного audit-лога БЕЗ
      // payload/result (там могла быть переписка) — секретов нет, только факт
      // действия и его статус/ошибка. Это НЕ сырой stdout.
      const logs = rows.map((a) => ({
        ts: a.created_at,
        agent: a.agent_key,
        action: a.action_type,
        status: a.status,
        error: a.error ?? undefined,
      }));
      return fmt({ ok: true, count: logs.length, logs });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "LIST_SCHEDULED_POSTS") {
    try {
      const channel =
        typeof i.channel === "string" && i.channel.trim() ? i.channel.trim() : null;
      // T-722: scope to the caller's chat (no cross-tenant enumeration).
      const where: string[] = ["status = 'scheduled'", "chat_id = ?"];
      const args: (string | number)[] = [ctx.chatId];
      if (channel) {
        where.push("channel = ?");
        args.push(channel);
      }
      const whereSql = where.join(" AND ");
      const total = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM content_calendar WHERE ${whereSql}`)
          .get(...args) as { n: number }
      ).n;
      const now = Date.now();
      /*
       * Аудит 2026-09-11: фильтр по каналу отказывал молча. Сравнение — точное
       * равенство без нормализации (`channel = ?`), а SCHEDULE_POST принимает
       * канал в любом виде: «@delabs», «-1001234567890», «delabs». Спросив
       * расписание «@delabs» там, где посты легли под числовым id, модель
       * получала `{ok:true, count:0, total:0, posts:[]}` — неотличимо от
       * «ничего не запланировано». Дальше она честно докладывала владельцу, что
       * расписание пусто, и планировала поверх уже запланированного.
       *
       * Второй запрос — без фильтра, только по чату. Он и отличает «постов
       * нет» от «есть, но под другим написанием канала», и в ответ уходит
       * список реальных написаний: подсказка без него была бы такой же
       * догадкой, как и сам фильтр.
       */
      const channelsHere = channel
        ? (db
            .prepare(
              `SELECT DISTINCT channel FROM content_calendar
               WHERE status = 'scheduled' AND chat_id = ? LIMIT 20`,
            )
            .all(ctx.chatId) as Array<{ channel: string }>).map((r) => r.channel)
        : [];
      /*
       * Аудит 2026-08-13: было `ORDER BY scheduled_at ASC LIMIT 50`, то есть
       * пятьдесят САМЫХ СТАРЫХ записей. Из статуса 'scheduled' строка не
       * уходит никогда — публикатора в проекте нет вовсе (см. комментарий у
       * handleSchedulePost), и в ARCHIVE_SPECS таблицы тоже нет. Значит
       * просроченные записи копятся в голове выдачи навсегда, а новая, начиная
       * с пятьдесят первой, не видна ни в списке — ни, следовательно, в
       * CANCEL_SCHEDULED_POST, который просит найти id «через
       * LIST_SCHEDULED_POSTS». Ровно эту форму бага уже чинили очереди
       * одобрений (tests/approval-expiry.test.ts: «свежего в выдаче нет вовсе —
       * его вытеснили старые»), только там нашёлся санитар, а здесь его нет.
       *
       * Порядок: сначала будущее по хронологии, затем просроченное от
       * свежего к древнему. Обе половины даёт одно выражение — для будущей
       * строки ABS(s - now) = s - now (растёт по времени), для прошлой
       * = now - s (растёт вглубь прошлого).
       *
       * Аудит 2026-08-29: ключ был неполным. Посты на одну и ту же минуту
       * (а SCHEDULE_POST принимает минуты, так что совпадение — обычное дело)
       * ложились в произвольном порядке, и на границе LIMIT 50 это решало,
       * какой из них вообще попадёт в выдачу. Два одинаковых вызова могли
       * вернуть разные наборы, а модель — «отменить» не тот пост. `id ASC`
       * замыкает ключ: он уникален (PRIMARY KEY), значит порядок полный.
       */
      const rows = db
        .prepare(
          `SELECT id, channel, scheduled_at, status, payload FROM content_calendar
           WHERE ${whereSql}
           ORDER BY (scheduled_at < ?) ASC, ABS(scheduled_at - ?) ASC, id ASC
           LIMIT ?`,
        )
        .all(...args, now, now, 50) as Array<{
        id: string;
        channel: string;
        scheduled_at: number;
        status: string;
        payload: string;
      }>;
      /*
       * Аудит 2026-08-21: текст поста возвращается вместе со строкой.
       *
       * SCHEDULE_POST кладёт его в content_calendar.payload
       * (`{"content": …}`, dispatch/misc.ts), но не читал этот столбец никто:
       * выдача была `SELECT id, channel, scheduled_at, status`, QUERY_DB держит
       * таблицу в денилисте, других SELECT'ов у неё нет. То есть текст писался
       * навсегда в один конец.
       *
       * Само по себе это была бы просто лишняя запись, но нота ниже велит
       * «публикуй заново через PUBLISH_TO_CHANNEL» — действие, для которого
       * нужен текст, а взять его модели неоткуда. Инструмент требовал того,
       * чего сам не давал; вероятный исход — пост, сочинённый заново.
       *
       * Отдавать безопасно: выдача уже сужена до своего чата (`chat_id = ?`
       * выше, T-722) и до ролей smm/orchestrator (permissions.ts) — тех же
       * двоих, кто эту строку и завёл. Новых глаз текст не получает.
       *
       * Бюджет: пятьдесят постов по 4096 символов — это 200 КБ в контекст на
       * один tool_result. Отдаём, пока суммарно не набралось CONTENT_BUDGET,
       * дальше `content: null` с меткой content_omitted — молчаливая обрезка
       * читалась бы как «текста у записи нет».
       */
      const CONTENT_BUDGET = 8000;
      let contentSpent = 0;
      let anyContentHidden = false;
      const posts = rows.map((r) => {
        let content: string | null = null;
        let unreadable = false;
        let omitted = false;
        try {
          const parsed = JSON.parse(r.payload) as { content?: unknown };
          if (typeof parsed.content === "string") content = parsed.content;
        } catch {
          // Строка старше миграции или правленая руками — не роняем весь
          // список из-за одной битой ячейки, помечаем её и идём дальше.
          unreadable = true;
        }
        if (content !== null) {
          if (contentSpent + content.length > CONTENT_BUDGET) {
            content = null;
            omitted = true;
          } else {
            contentSpent += content.length;
          }
        }
        if (omitted || unreadable) anyContentHidden = true;
        return {
          id: r.id,
          channel: r.channel,
          scheduled_at: r.scheduled_at,
          status: r.status,
          overdue: r.scheduled_at < now,
          content,
          ...(omitted ? { content_omitted: true } : {}),
          ...(unreadable ? { content_unreadable: true } : {}),
        };
      });
      // Считаем по всей выборке, а не по странице: смысл счётчика — «сколько
      // всего пропущено», и обрезка LIMIT'ом его занижать не должна.
      const overdueCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM content_calendar
             WHERE ${whereSql} AND scheduled_at < ?`,
          )
          .get(...args, now) as { n: number }
      ).n;
      return fmt({
        ok: true,
        count: posts.length,
        // Обрезку называем вслух: молчаливый LIMIT читается как «это всё».
        total,
        truncated: total > rows.length,
        overdue_count: overdueCount,
        posts,
        // Про пустой content говорим вслух: иначе он читается как «пост без
        // текста», а не как «текст сюда не поместился / не читается».
        ...(anyContentHidden
          ? {
              content_note:
                "у части записей content=null: content_omitted=true — текст не поместился в бюджет выдачи, content_unreadable=true — payload не разобрался. Не сочиняй текст за них",
            }
          : {}),
        // Строка со вчерашней датой и статусом 'scheduled' читается моделью как
        // «запланировано и уйдёт», хотя не уйдёт и не ушло: публикатора в
        // проекте нет (см. handleSchedulePost). Говорим это словами.
        // Пустой ответ на фильтр по каналу — почти всегда расхождение в
        // написании, а не пустое расписание. Называем это вслух и отдаём
        // написания, которые в этом чате есть на самом деле.
        ...(channel && total === 0 && channelsHere.length > 0
          ? {
              channel_note: `по каналу «${channel}» записей нет, но в этом чате запланированы посты для: ${channelsHere.join(", ")} — фильтр сверяется точной строкой, без нормализации. Повтори запрос с одним из этих написаний или без фильтра`,
            }
          : {}),
        ...(overdueCount > 0
          ? {
              note: "записи с overdue=true не были отправлены: автопубликации в проекте нет, время прошло. Не выдавай их за опубликованные — либо публикуй заново через PUBLISH_TO_CHANNEL (текст поста лежит в поле content), либо снимай через CANCEL_SCHEDULED_POST",
            }
          : {}),
      });
    } catch (e) {
      return fmt({ ok: false, error: getErrorMessage(e) });
    }
  }
  if (name === "CANCEL_SCHEDULED_POST") {
    // SEC-audit 2026-06-10 (F1, HIGH): this is a MUTATION (UPDATE) that sat in
    // the read-only block, bypassing the gate — any role / prompt-injected agent
    // could cancel posts. Mirror SCHEDULE_POST ownership: only smm/orchestrator.
    // (Full approval-gating + per-channel scoping tracked in T-722.)
    // Аудит 2026-08-21: единственная МУТАЦИЯ среди инлайновых тулзов не писала
    // ни строки в agent_actions. Инлайновый блок замыкается до gateOrDispatch,
    // а журнал ведёт диспатчер — ту же дыру у читающего QUERY_DB закрыли
    // функцией logToolCall (аудит 2026-08-04) с формулировкой «любое другое
    // действие с последствиями строку пишет». Отмена — пишет теперь тоже.
    //
    // Цена молчания: пост пропадает из LIST_SCHEDULED_POSTS (фильтр
    // status='scheduled'), а GET_LOGS читает ровно agent_actions и на вопрос
    // «кто снял» отвечает пустотой. Оставался только log.info в stdout юнита —
    // он ротируется и в Mini App не виден.
    //
    // В payload кладём id и НЕ кладём тело поста: аудит не должен становиться
    // вторым хранилищем содержимого (тот же принцип, что у QUERY_DB, который
    // пишет SQL, но не строки ответа).
    const auditCancel = (
      postId: string,
      status: "ok" | "error",
      error?: string,
    ) => {
      try {
        logToolCall("CANCEL_SCHEDULED_POST", {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId ?? null,
          payload: { id: postId },
          status,
          error: error ?? null,
          requestId: ctx.requestId ?? null,
        });
      } catch (e) {
        // Аудит не роняет само действие, но и молчать о своём отказе не
        // должен: дыра в журнале выглядит как отсутствие отмен.
        log.warn("[CANCEL_SCHEDULED_POST] не удалось записать аудит", {
          error: getErrorMessage(e),
        });
      }
    };
    const id = String(i.id ?? "").trim();
    if (ctx.agentKey !== "smm" && ctx.agentKey !== "orchestrator") {
      // Строку тут НЕ пишем осознанно: до этой проверки уже отработал
      // isToolExposedToRole с тем же списком ["smm","orchestrator"]
      // (запись CANCEL_SCHEDULED_POST в permissions.ts), поэтому ветка
      // недостижима через executeTool и
      // осталась как defense-in-depth. Журналирование отказов самого
      // exposure-гейта — вопрос общий для всех тулзов, не этой правки.
      return fmt({ ok: false, error: "forbidden: CANCEL_SCHEDULED_POST restricted to smm/orchestrator" });
    }
    if (!id) {
      auditCancel("", "error", "id is required");
      return fmt({ ok: false, error: "id is required" });
    }
    try {
      // T-722: scope cancel to the caller's chat — can't cancel another chat's post.
      const res = db
        .prepare(
          `UPDATE content_calendar SET status = 'cancelled'
           WHERE id = ? AND status = 'scheduled' AND chat_id = ?`,
        )
        .run(id, ctx.chatId);
      if (res.changes === 0) {
        // Аудит 2026-08-29: `changes === 0` даёт три разные причины, а ответ
        // был один на всех. «Пост уже снят» — это цель ДОСТИГНУТА, а модель
        // читала «такого поста нет» и шла искать несуществующее заново.
        //
        // Разделяем не всё: чужой чат наружу обязан выглядеть ровно как
        // выдуманный id, иначе перебором id можно выяснить, что соседний чат
        // такой пост планировал. Точная причина уезжает в agent_actions —
        // журнал читает оператор, а не вызывающая роль.
        const own = db
          .prepare(`SELECT status FROM content_calendar WHERE id = ? AND chat_id = ?`)
          .get(id, ctx.chatId) as { status: string } | undefined;
        if (own) {
          const msg = `post is already '${own.status}', nothing to cancel`;
          auditCancel(id, "error", msg);
          return fmt({ ok: false, error: msg, id, status: own.status });
        }
        const elsewhere = db.prepare(`SELECT 1 FROM content_calendar WHERE id = ?`).get(id);
        auditCancel(
          id,
          "error",
          elsewhere ? "post belongs to another chat" : "no post with this id",
        );
        return fmt({ ok: false, error: "no scheduled post with this id in this chat" });
      }
      log.info("[scheduled-post] cancelled", { agentKey: ctx.agentKey, id });
      auditCancel(id, "ok");
      return fmt({ ok: true, id, status: "cancelled" });
    } catch (e) {
      const msg = getErrorMessage(e);
      auditCancel(id, "error", msg);
      return fmt({ ok: false, error: msg });
    }
  }

  if (!TOOL_NAMES.has(name)) {
    return fmt({ ok: false, error: `unknown tool: ${name}` });
  }
  const at = name as ActionType;

  // Telegram-инструменты без telegram-контекста — короткое замыкание ДО gate.
  const isTgTool =
    at === "SEND_MESSAGE" ||
    at === "SET_REACTION" ||
    at === "EDIT_MESSAGE" ||
    at === "PIN_MESSAGE" ||
    at === "DELETE_MESSAGE" ||
    at === "FORWARD_MESSAGE" ||
    at === "CREATE_POLL" ||
    at === "SEND_PHOTO" ||
    at === "SEND_DOCUMENT" ||
    at === "GENERATE_SVG_IMAGE" ||
    at === "GENERATE_IMAGE";
  if (isTgTool && !ctx.telegram) {
    return fmt({ ok: false, error: "no telegram context" });
  }

  const built = buildPayload(at, i, ctx);
  if (!built.ok) return fmt({ ok: false, error: built.error });
  // Stage A: thread triggering user_id into MAC payloads so the dispatcher can
  // apply the MAC_USER_IDS whitelist check. SEC-audit LOW-2: MAC_STOP also needs
  // it — without injection isUserAllowed(undefined) was always false, so the
  // emergency kill-switch was dead (failed closed). Inject for both.
  if (at === "MAC_RUN_CLAUDE" || at === "MAC_STOP") {
    const p = built.payload as { _userId?: string; _delegated?: boolean };
    p._userId = ctx.triggerUserId;
    // Аудит 2026-08-13: делегат теперь видит triggerUserId (раньше терял его и
    // получал тихий forbidden). Раз путь ожил — он обязан отличаться от прямого
    // обращения человека: opt-in MAC_AUTONOMOUS давался оркестратору, которому
    // владелец сам написал, а не любой роли, попросившей оркестратора.
    //
    // Признак делегирования — ЧУЖОЙ ключ в цепочке, а не её непустота. Прямой
    // ход владельца тоже приходит с цепочкой: message-handler засевает её как
    // `[def.key]` для анти-пингпонга C13. По длине `> 0` делегированным
    // оказался бы каждый ход, включая тот, что владелец набрал руками, — то
    // есть MAC_AUTONOMOUS перестал бы работать вообще, всегда требуя карточку.
    // Делегированные ходы приходят либо как `[...chain, role]` из
    // DELEGATE_TO_ROLE, либо как `[triggerAgentKey, target]` из каскада по
    // @-упоминанию: в обоих в цепочке есть кто-то кроме исполнителя.
    p._delegated = (ctx.delegationChain ?? []).some((k) => k !== ctx.agentKey);
  }

  try {
    const res = await gateOrDispatch(at, built.payload, {
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      telegram: ctx.telegram,
      triggerMessageId: ctx.triggerMessageId,
      resolveAgent: ctx.resolveAgent,
      handoffDeps: ctx.handoffDeps,
      respondAsImpl: ctx.respondAsImpl,
      delegationChain: ctx.delegationChain,
      handoffBudget: ctx.handoffBudget,
      inputImages: ctx.inputImages,
      inputDocuments: ctx.inputDocuments,
      triggerUserId: ctx.triggerUserId,
      requestId: ctx.requestId,
      // T-240: без botId checkPerBotPerChatRateLimit сразу возвращает {ok:true}
      // (rate-limits.ts:258) — то есть весь per-bot-per-chat лимит был
      // выключен для tool-пути и падал открытым, без единой строки в логе.
      // handoff.ts:223 старательно прокидывает botId делегата — сюда.
      botId: ctx.botId,
    });
    return formatGateResult(at, res);
  } catch (e) {
    const msg = getErrorMessage(e);
    return fmt({ ok: false, error: msg });
  }
}
