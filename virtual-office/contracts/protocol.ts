import { z } from "zod";
export const STATES = [
  "OFFLINE",
  "IDLE",
  "THINKING",
  "READING",
  "RESEARCHING",
  "CODING",
  "TERMINAL",
  "TESTING",
  "REVIEWING",
  "WAITING",
  "WAITING_TOOL",
  "COMMUNICATING",
  "MEETING",
  "ERROR",
  "DONE",
] as const;
export const StateSchema = z.enum(STATES);
export type Activity = z.infer<typeof StateSchema>;
const text = z.string().max(1000);
export const AgentSchema = z
  .object({
    agentId: z.literal("backend"),
    name: z.literal("Backend"),
    role: z.string().max(100),
    state: StateSchema,
    runId: z.string().max(100).nullable(),
    taskId: z.string().max(100).nullable(),
    task: text.nullable(),
    project: text.nullable(),
    currentFile: text.nullable(),
    repository: z.string().max(300).nullable(),
    branch: text.nullable(),
    progress: z.number().finite().min(0).max(1).nullable(),
    tests: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    blocker: text.nullable(),
    summary: text,
    updatedAt: z.string().datetime(),
    source: z.enum(["mock", "agent-team"]),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;
export const ActionSchema = z
  .object({
    id: z.string(),
    at: z.string().datetime(),
    state: StateSchema,
    summary: text,
  })
  .strict();
export const ChatSchema = z
  .object({
    id: z.string(),
    commandId: z.string().uuid(),
    agentId: z.literal("backend"),
    speaker: z.enum(["user", "agent"]),
    text,
    at: z.string().datetime(),
    source: z.literal("mock"),
  })
  .strict();
export const WorldSchema = z
  .object({
    schemaVersion: z.literal(1),
    streamId: z.string(),
    seq: z.number().int().nonnegative().safe(),
    agent: AgentSchema,
    actions: z.array(ActionSchema).max(20),
    messages: z.array(ChatSchema).max(40),
  })
  .strict();
export type World = z.infer<typeof WorldSchema>;
const envelope = {
  schemaVersion: z.literal(1),
  streamId: z.string(),
  seq: z.number().int().positive().safe(),
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  source: z.literal("mock"),
};
export const EventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("agent.state.changed"),
      payload: z.object({ agent: AgentSchema, action: ActionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("chat.message"),
      payload: ChatSchema,
    })
    .strict(),
]);
export type OfficeEvent = z.infer<typeof EventSchema>;
export const FrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), world: WorldSchema }).strict(),
  z.object({ kind: z.literal("event"), event: EventSchema }).strict(),
  z
    .object({
      kind: z.literal("resumed"),
      streamId: z.string(),
      seq: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z.object({ kind: z.literal("heartbeat"), at: z.number() }).strict(),
]);
export const HelloSchema = z
  .object({
    kind: z.literal("hello"),
    schemaVersion: z.literal(1),
    streamId: z.string().optional(),
    lastAppliedSeq: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
const commandBase = {
  commandId: z.string().uuid(),
  agentId: z.literal("backend"),
};
export const CommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...commandBase,
      kind: z.literal("scenario.set"),
      state: StateSchema,
    })
    .strict(),
  z
    .object({
      ...commandBase,
      kind: z.literal("chat.send"),
      text: z.string().trim().min(1).max(800),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      kind: z.literal("task.create"),
      text: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export class ResyncRequired extends Error {}
export function reduceEvent(world: World, event: OfficeEvent): World {
  if (event.streamId !== world.streamId)
    throw new ResyncRequired("epoch changed");
  if (event.seq <= world.seq) return world;
  if (event.seq !== world.seq + 1) throw new ResyncRequired("event gap");
  if (event.type === "agent.state.changed")
    return {
      ...world,
      seq: event.seq,
      agent: event.payload.agent,
      actions: [event.payload.action, ...world.actions].slice(0, 20),
    };
  return {
    ...world,
    seq: event.seq,
    messages: [...world.messages, event.payload].slice(-40),
  };
}
