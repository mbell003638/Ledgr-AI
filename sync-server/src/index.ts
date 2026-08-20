import { createServer } from "./server.js";
import { MemoryEventStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
createServer(new MemoryEventStore()).listen(port, host, () => console.log(`Ledgr sync-server listening on ${host}:${port}`));
