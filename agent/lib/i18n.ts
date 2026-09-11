/**
 * T-305: Simple map-based i18n system for hardcoded RU/EN strings
 * Supports locale switching and fallbacks
 *
 * Аудит 2026-08-11: словарь ужат до того, что реально читается. Было 22 ключа,
 * потребитель — один (characters/index.ts, три ключа); остальные 19 дублировали
 * строки, которые в своих местах так и остались литералами (tools/userbot-login.ts,
 * miniapp/src/components/*.tsx). Правка такого ключа выглядела правкой текста и
 * не меняла ничего — ловушка, а не перевод. Пустой словарь честнее лишнего.
 *
 * Аудит 2026-08-28: здесь было написано «инвариант держит
 * tests/i18n-dead-keys.test.ts: у каждого ключа есть читатель», а тест сверял
 * `consumerSource.toContain("'" + key + "'")` — то есть ключ, упомянутый в
 * комментарии или в любой другой строке, считался прочитанным. И список
 * потребителей был захардкожен: файл, начавший звать `t()`, в сверку не
 * попадал вовсе. Теперь тест ищет именно вызов `t('ключ'` и отдельно проверяет,
 * что список потребителей не устарел — обходит дерево и смотрит, кто вообще
 * импортирует этот модуль.
 *
 * Английская половина сейчас недостижима: `setLocale` не зовёт никто, локаль
 * всегда 'ru'. Это осознанно оставлено как точка переключения — но пока
 * добавлять en-варианты новых ключей смысла нет, их никто не увидит.
 */
import { log } from "./log.ts";

export type Locale = 'ru' | 'en';

export interface I18nMessages {
  [key: string]: {
    ru: string;
    en: string;
  };
}

// Character system prompts — common elements. Единственное, что читается:
// characters/index.ts собирает из этих трёх строк общую часть промптов.
export const messages: I18nMessages = {
  'characters.team_roster': {
    ru: 'Команда: Lead (оркестратор), PM, Product, Backend, Frontend, Telegram Bot Dev, AI/LLM Engineer, QA, SMM, Copywriter, Designer, Action/Permissions.',
    en: 'Team: Lead (orchestrator), PM, Product, Backend, Frontend, Telegram Bot Dev, AI/LLM Engineer, QA, SMM, Copywriter, Designer, Action/Permissions.'
  },
  'characters.tone': {
    ru: 'Тон: спокойный, уверенный, профессиональный, без воды и эмодзи. Отвечай по-русски, кратко.',
    en: 'Tone: calm, confident, professional, no fluff or emojis. Respond in English, briefly.'
  },
  'characters.stage_note': {
    ru: 'На этом этапе ты работаешь в одной Telegram-группе. Если запрос вне твоей компетенции — скажи, к кому из команды обратиться, не выдумывай результат чужой работы.',
    en: 'At this stage you work in one Telegram group. If a request is outside your competence — tell who on the team to contact, don\'t make up results from other people\'s work.'
  },
};

class I18nService {
  private locale: Locale = 'ru'; // Default to Russian

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  getLocale(): Locale {
    return this.locale;
  }

  /**
   * Get translated message by key
   * @param key - dot-notation key (e.g. 'error.general')
   * @param fallback - fallback text if key not found
   * @returns translated string
   */
  t(key: string, fallback?: string): string {
    // Аудит 2026-08-28: было `messages[key]`, то есть обычный поиск по объекту
    // вместе с прототипом. `t("constructor")`, `t("toString")`, `t("__proto__")`
    // и `t("hasOwnProperty")` находили НЕ ключ словаря, `!message` было ложно —
    // и предупреждение «missing key» не печаталось. Дальше `message[locale]`
    // всё равно undefined, так что наружу уходил фолбэк: поведение то же, а
    // единственный сигнал о промахе терялся. Ключи приходят из вызывающего
    // кода, но именно этот лог и есть способ заметить опечатку.
    const message = Object.hasOwn(messages, key) ? messages[key] : undefined;
    if (!message) {
      log.warn("[i18n] missing key", { key });
      // `??`, а не `||`: пустая строка — законный фолбэк («здесь ничего не
      // печатать»), а `||` подменял её именем ключа, то есть выводил в интерфейс
      // служебный идентификатор вместо ничего.
      return fallback ?? key;
    }

    const translated = message[this.locale];
    if (!translated) {
      // Fallback to other locale or key
      const otherLocale = this.locale === 'ru' ? 'en' : 'ru';
      return message[otherLocale] || (fallback ?? key);
    }

    return translated;
  }

  // Аудит 2026-08-11: template() и detectLocale() удалены — вызовов не было
  // ни одного, и оба несли по готовой ошибке на момент первого использования.
  // (Имена здесь без обратных кавычек намеренно: обеих функций больше нет,
  // а кавычки в этом репозитории обещают, что символ найдётся в коде.)
  // template строил RegExp из имени параметра, не экранируя его. А
  // detectLocale на тексте без букв (число, эмодзи, ссылка) возвращал 'en':
  // сравнение `0 > 0` ложно, и ветка уходила в чужой язык, хотя дефолт 'ru'.
  // Понадобится — восстанавливать осознанно, а не наследовать вместе с багом.
}

// Global singleton instance
export const i18n = new I18nService();

// Convenience exports
export const t = (key: string, fallback?: string) => i18n.t(key, fallback);
export const setLocale = (locale: Locale) => i18n.setLocale(locale);
export const getLocale = () => i18n.getLocale();