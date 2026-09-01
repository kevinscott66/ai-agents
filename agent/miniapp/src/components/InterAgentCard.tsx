import { useState } from "react";
import { ellipsize } from "../lib/text";

/**
 * Renders a structured summary for inter-agent mutating approval actions
 * (T-706b): GRANT_PERMISSION, UPDATE_AGENT_PROMPT, CHANGE_AGENT_STATUS.
 *
 * Pure presentational — caller decides whether to invoke based on action_type.
 * Falls back to `null` for unknown shapes so the parent can render a raw
 * JSON dump alongside.
 */
export const INTER_AGENT_ACTION_TYPES = [
  "GRANT_PERMISSION",
  "UPDATE_AGENT_PROMPT",
  "CHANGE_AGENT_STATUS",
] as const;

export type InterAgentActionType = (typeof INTER_AGENT_ACTION_TYPES)[number];

export function isInterAgentAction(actionType: string): boolean {
  return (INTER_AGENT_ACTION_TYPES as readonly string[]).includes(actionType);
}

/**
 * Текст-заглушка, которым `/api/approvals` подменяет payload не-админу
 * (`redactContent`, agent/lib/miniapp-server.ts). Держим тот же текст, что и в
 * `lib/mac-session.ts`, — пользователь видит одну формулировку везде.
 */
export const INTER_AGENT_REDACTED_NOTE = "(скрыто: доступно администратору)";

export type InterAgentPayloadState = "ok" | "redacted" | "missing";

/**
 * Можно ли вообще строить сводку по этому payload.
 *
 * Не-админу сервер вырезает `payload`, подставляя вместо объекта СТРОКУ и
 * помечая строку ответа `redacted: true`. Карточка раньше этого не замечала:
 * `p` становился `null`, геттеры возвращали пустоту, а разметка всё равно
 * рисовалась — «Выдать `?` агенту `?`, allowed: —». Это читается как «данные
 * такие», а не «данных нет», и человек одобряет полномочие по несуществующей
 * сводке.
 *
 * Распознаём по ТИПУ, а не по тексту ноты: у всех трёх inter-agent действий
 * payload по схеме — объект, поэтому строка на этом месте означает ровно одно.
 * Текст ноты живёт в другом файле и волен смениться.
 */
export function interAgentPayloadState(
  payload: unknown,
  redacted?: boolean,
): InterAgentPayloadState {
  if (redacted === true) return "redacted";
  if (typeof payload === "string") return "redacted";
  if (payload === null || payload === undefined) return "missing";
  if (typeof payload !== "object" || Array.isArray(payload)) return "missing";
  return "ok";
}

type AnyPayload = Record<string, unknown> | null | undefined;

function str(p: AnyPayload, key: string): string {
  if (!p || typeof p !== "object") return "";
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function bool(p: AnyPayload, key: string): boolean | undefined {
  if (!p || typeof p !== "object") return undefined;
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : undefined;
}

function num(p: AnyPayload, key: string): number | undefined {
  if (!p || typeof p !== "object") return undefined;
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Текст нового system-prompt из payload UPDATE_AGENT_PROMPT.
 *
 * Канонический ключ — `new_prompt`: именно его валидирует бэкенд
 * (`validateUpdateAgentPromptPayload`) и именно он попадает в аппрув. Остальные
 * оставлены запасными вариантами для старых строк в БД.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, а без тела карточка
 * предлагает одобрить перезапись промпта вслепую.
 */
export function promptBodyOf(payload: unknown): string {
  const p = (payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null) as AnyPayload;
  return str(p, "new_prompt") || str(p, "full_text") || str(p, "body") || str(p, "diff");
}

function Chip({
  children,
  variant = "default",
}: {
  children: any;
  variant?: "default" | "perm" | "prompt" | "status" | "tag";
}) {
  const bg: Record<string, string> = {
    default: "#586069",
    perm: "#22703a",
    prompt: "#5d3398",
    status: "#cc4e00",
    tag: "#1c5a8a",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.3px",
        color: "#fff",
        background: bg[variant] ?? bg.default,
        marginRight: 6,
      }}
    >
      {children}
    </span>
  );
}

function PromptPreview({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_CHARS = 200;
  const isLong = body.length > PREVIEW_CHARS;
  const shown = expanded ? body : ellipsize(body, PREVIEW_CHARS);
  return (
    <div style={{ marginTop: 6 }}>
      <pre
        className="json-block"
        style={{
          maxHeight: expanded ? 400 : 120,
        }}
      >
        {shown}
      </pre>
      {isLong && (
        <button
          type="button"
          className="btn secondary"
          style={{ marginTop: 4, padding: "4px 10px", fontSize: 12 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Свернуть" : `Показать полностью (${body.length} симв.)`}
        </button>
      )}
    </div>
  );
}

export function InterAgentCard({
  actionType,
  payload,
  redacted,
}: {
  actionType: string;
  payload: unknown;
  /** Строка ответа помечена сервером как вырезанная (`redactContent`). */
  redacted?: boolean;
}) {
  const state = interAgentPayloadState(payload, redacted);
  if (state !== "ok") {
    // Честная пустая карточка вместо сводки из прочерков: без payload сказать
    // о действии нечего, кроме его типа.
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <Chip variant="tag">Inter-agent</Chip>
        </div>
        <div style={{ fontSize: 14 }}>
          <code style={{ background: "var(--secondary-bg)", padding: "1px 4px", borderRadius: 4 }}>
            {actionType}
          </code>
        </div>
        <div className="meta" style={{ marginTop: 4 }}>
          {state === "redacted"
            ? INTER_AGENT_REDACTED_NOTE
            : "параметры действия недоступны"}
        </div>
      </div>
    );
  }
  const p = (payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null) as AnyPayload;
  const target = str(p, "target_agent_key") || str(p, "target") || "?";
  const reason = str(p, "reason");

  if (actionType === "GRANT_PERMISSION") {
    const permActionType = str(p, "action_type") || "?";
    const allowed = bool(p, "allowed");
    const requiresApproval = bool(p, "requires_approval");
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <Chip variant="tag">Inter-agent</Chip>
          <Chip variant="perm">permission</Chip>
        </div>
        <div style={{ fontSize: 14 }}>
          Выдать{" "}
          <code style={{ background: "var(--secondary-bg)", padding: "1px 4px", borderRadius: 4 }}>
            {permActionType}
          </code>{" "}
          агенту{" "}
          <code style={{ background: "var(--secondary-bg)", padding: "1px 4px", borderRadius: 4 }}>
            {target}
          </code>
        </div>
        <div className="meta" style={{ marginTop: 4 }}>
          allowed: {allowed === undefined ? "—" : String(allowed)} ·{" "}
          requires_approval:{" "}
          {requiresApproval === undefined ? "—" : String(requiresApproval)}
        </div>
        {reason && (
          <div style={{ fontSize: 13, marginTop: 6 }}>
            <span className="meta">причина:</span> {reason}
          </div>
        )}
      </div>
    );
  }

  if (actionType === "UPDATE_AGENT_PROMPT") {
    const version = num(p, "version");
    const fullText = promptBodyOf(p);
    const prevLen = num(p, "previous_length");
    const lenDiff =
      prevLen !== undefined && fullText
        ? fullText.length - prevLen
        : undefined;
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <Chip variant="tag">Inter-agent</Chip>
          <Chip variant="prompt">prompt</Chip>
        </div>
        <div style={{ fontSize: 14 }}>
          Обновить промпт для{" "}
          <code style={{ background: "var(--secondary-bg)", padding: "1px 4px", borderRadius: 4 }}>
            {target}
          </code>
          {version !== undefined ? ` (v${version})` : ""}
        </div>
        {lenDiff !== undefined && (
          <div className="meta" style={{ marginTop: 4 }}>
            длина: {lenDiff >= 0 ? `+${lenDiff}` : lenDiff} симв.
          </div>
        )}
        {reason && (
          <div style={{ fontSize: 13, marginTop: 6 }}>
            <span className="meta">причина:</span> {reason}
          </div>
        )}
        {fullText && <PromptPreview body={fullText} />}
      </div>
    );
  }

  if (actionType === "CHANGE_AGENT_STATUS") {
    const oldStatus = str(p, "old_status") || str(p, "from_status");
    const newStatus = str(p, "status") || str(p, "new_status");
    const oldMode = str(p, "old_autonomy_mode") || str(p, "from_autonomy_mode");
    const newMode = str(p, "autonomy_mode") || str(p, "new_autonomy_mode");
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <Chip variant="tag">Inter-agent</Chip>
          <Chip variant="status">status</Chip>
        </div>
        <div style={{ fontSize: 14 }}>
          Изменить статус{" "}
          <code style={{ background: "var(--secondary-bg)", padding: "1px 4px", borderRadius: 4 }}>
            {target}
          </code>
        </div>
        {(oldStatus || newStatus) && (
          <div className="meta" style={{ marginTop: 4 }}>
            status: {oldStatus || "—"} → {newStatus || "—"}
          </div>
        )}
        {(oldMode || newMode) && (
          <div className="meta">
            autonomy: {oldMode || "—"} → {newMode || "—"}
          </div>
        )}
        {reason && (
          <div style={{ fontSize: 13, marginTop: 6 }}>
            <span className="meta">причина:</span> {reason}
          </div>
        )}
      </div>
    );
  }

  return null;
}
