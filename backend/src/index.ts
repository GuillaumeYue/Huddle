import { createServer } from "node:http";
import { createApp } from "./app.js";
import { hub } from "./live.js";
import { startTimerSweeper } from "./timer.js";

const port = Number(process.env["PORT"] ?? 3000);

// Explicit http.Server (instead of app.listen) so the ws upgrade path
// can attach beside Express — REST and realtime share one port.
const server = createServer(createApp());
hub.attach(server);
// Trigger B lives outside any socket: one leased sweeper per cluster.
startTimerSweeper((roomId) => hub.broadcastRoom(roomId));

server.listen(port, () => {
  console.log(`huddle-backend listening on :${port} (http + ws)`);
});
