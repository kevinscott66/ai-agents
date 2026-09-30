import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { OfficeStore } from "./store";
import { startGateway } from "./server";
mkdirSync(".runtime", { recursive: true });
const app = startGateway({
  store: new OfficeStore(".runtime/mock.sqlite"),
  staticDir: resolve("dist"),
});
console.log(
  `Mock Office: http://127.0.0.1:${app.server.port} — local only, no real agents`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    app.stop();
    app.store.close();
    process.exit(0);
  });
