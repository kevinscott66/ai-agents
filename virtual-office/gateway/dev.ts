import { startGateway } from "./server";
// Vite's Node HTTP upgrade path is required for its WebSocket proxy.
// Run the frontend on Node; the gateway keeps Bun's native WebSocket server.
const gateway = startGateway();
const vite = Bun.spawn(["node", "node_modules/vite/bin/vite.js"], {
  stdout: "inherit",
  stderr: "inherit",
});
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  vite.kill();
  gateway.stop();
  gateway.store.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
const exit = await vite.exited;
stop();
process.exit(exit);
