import {
  FrameSchema,
  reduceEvent,
  type Command,
  type World,
} from "../../contracts/protocol";
export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";
export class OfficeConnection {
  world: World | null = null;
  status: ConnectionStatus = "connecting";
  lastReceived = 0;
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  constructor(private changed: () => void) {}
  start() {
    this.stopped = false;
    void this.connect();
    this.watchdog = setInterval(() => {
      if (this.status === "live" && Date.now() - this.lastReceived > 45_000) {
        this.status = "offline";
        this.changed();
        this.socket?.close();
      }
    }, 5000);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.socket?.close();
  }
  private async connect() {
    if (this.stopped) return;
    this.status = this.world ? "reconnecting" : "connecting";
    this.changed();
    try {
      const response = await fetch("/office/v1/stream-ticket", {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("ticket failed");
      const { ticket } = await response.json();
      if (this.stopped) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/office/v1/stream?ticket=${encodeURIComponent(ticket)}`,
      );
      this.socket = ws;
      const handshake = setTimeout(() => ws.close(), 7000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            kind: "hello",
            schemaVersion: 1,
            ...(this.world
              ? {
                  streamId: this.world.streamId,
                  lastAppliedSeq: this.world.seq,
                }
              : {}),
          }),
        );
      ws.onmessage = (e) => {
        try {
          const frame = FrameSchema.parse(JSON.parse(e.data));
          this.lastReceived = Date.now();
          if (frame.kind === "heartbeat") {
            ws.send(JSON.stringify({ kind: "pong" }));
            return;
          }
          if (frame.kind === "snapshot") this.world = frame.world;
          clearTimeout(handshake);
          if (frame.kind === "event") {
            if (!this.world) throw new Error("missing snapshot");
            this.world = reduceEvent(this.world, frame.event);
          }
          if (
            frame.kind === "resumed" &&
            (!this.world ||
              this.world.streamId !== frame.streamId ||
              this.world.seq !== frame.seq)
          )
            throw new Error("invalid resume");
          this.status = "live";
          this.retry = 0;
          this.changed();
        } catch {
          this.world = null;
          this.status = "reconnecting";
          this.changed();
          ws.close(1000, "resync");
        }
      };
      ws.onclose = () => {
        clearTimeout(handshake);
        if (this.socket === ws) {
          this.status = "offline";
          this.changed();
          this.schedule();
        }
      };
      ws.onerror = () => ws.close();
    } catch {
      this.status = "offline";
      this.changed();
      this.schedule();
    }
  }
  private schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const delay =
      Math.min(30_000, 500 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
    this.timer = setTimeout(() => void this.connect(), delay);
  }
  async command(command: Command) {
    if (this.status !== "live")
      throw new Error("Нет соединения. Команда не отправлена.");
    try {
      const response = await fetch("/office/v1/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(`Команда отклонена (${response.status})`);
      return await response.json();
    } catch (error) {
      // Resolve an ambiguous delivery once; never blindly re-execute the command.
      try {
        const lookup = await fetch(`/office/v1/commands/${command.commandId}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (lookup.ok) return await lookup.json();
      } catch {
        /* surface ambiguity */
      }
      throw new Error(
        error instanceof Error
          ? `${error.message}. Результат не подтверждён; автоматического повтора нет.`
          : "Результат не подтверждён.",
      );
    }
  }
}
