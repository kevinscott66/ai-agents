import { z } from "zod";
import { ROSTER, type RoleId } from "./roster";
const Role = z.enum(ROSTER.map((m) => m.id) as [RoleId, ...RoleId[]]);
export const OfficeLiveSchema = z
  .object({
    source: z.literal("agent-team"),
    scope: z.enum(["office-native-turns", "owner-execution"]),
    agents: z
      .array(
        z.object({
          agentId: Role,
          name: z.string(),
          available: z.boolean(),
          state: z.enum([
            "OFFLINE",
            "IDLE",
            "THINKING",
            "WAITING",
            "DONE",
            "ERROR",
          ]),
          runId: z.string().nullable(),
          updatedAt: z.string().nullable(),
          conversationId: z.string().nullable(),
        }),
      )
      .length(12),
  })
  .refine((v) => new Set(v.agents.map((a) => a.agentId)).size === 12);
export type LiveSnapshot = z.infer<typeof OfficeLiveSchema>;
export class LiveClient {
  private token = "";
  private generation = 0;
  clear() {
    this.token = "";
    this.generation++;
  }
  async request(path: string, body?: unknown) {
    const generation = this.generation;
    const response = await fetch("/api/web/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(this.token ? { authorization: "Bearer " + this.token } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (generation !== this.generation) throw new Error("Сессия завершена");
    if (response.status === 401) {
      this.clear();
      throw new Error("Авторизация истекла. Подключитесь заново.");
    }
    if (!response.ok)
      throw new Error(
        response.status === 503
          ? "Подключение офиса на сервере ещё не включено."
          : response.status === 409
            ? "Запрос уже выполняется или не совпадает с сохранённым."
            : `Сервер недоступен (${response.status}).`,
      );
    const result = await response.json();
    if (generation !== this.generation) throw new Error("Сессия завершена");
    return result;
  }
  async pair(code: string) {
    const generation = this.generation;
    const result = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await this.request("pair", { code }));
    if (generation !== this.generation) throw new Error("Сессия завершена");
    this.token = result.token;
  }
  async snapshot() {
    return OfficeLiveSchema.parse(await this.request("office"));
  }
}
