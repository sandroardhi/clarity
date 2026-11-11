import { createServer } from "./server";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const server = createServer();

function start() {
  const httpServer = server.listen(PORT, HOST, () => {
    console.log(`[Skalpl Analytics Server] Running on http://${HOST}:${PORT}`);
    console.log(`👉 Open http://localhost:${PORT}/demo in your browser for the Interactive Heatmap Playground`);
  });

  httpServer.on("error", (error: any) => {
    if (error.code === "EADDRINUSE") {
      console.error(`❌ [Skalpl Analytics Server] Port ${PORT} is already in use by another process.`);
      console.error(`👉 Run 'lsof -i :${PORT}' or 'fuser -k ${PORT}/tcp' to check/kill the blocking process.`);
    } else {
      console.error(`❌ [Skalpl Analytics Server] Server failed to start:`, error);
    }
    process.exit(1);
  });
}

if (require.main === module) {
  start();
}

export * from "./types";
export * from "./server";
export * from "./db/repository";
export * from "./db/postgres";
export * from "./services/collector";

