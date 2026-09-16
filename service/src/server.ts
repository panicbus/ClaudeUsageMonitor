import { createServer, type Server } from "node:http";
import type { UsageResponse } from "@claude-usage-monitor/shared";

export function createUsageServer(getSnapshot: () => UsageResponse): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}
