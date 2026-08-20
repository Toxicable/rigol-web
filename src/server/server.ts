import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT ?? ""}`);
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
});

server.once("error", (error) => {
  console.error("Rigol Web server failed to start", error);
  process.exitCode = 1;
});

server.listen(port, () => {
  console.log(`Rigol Web server listening on http://localhost:${port}`);
});
