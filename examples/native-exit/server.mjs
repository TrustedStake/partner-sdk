// Loopback-only, explicit file allowlist. No credentials, proxying or outbound network.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const sdk = new URL("../../", import.meta.url);
const files = new Map([
  ["/", new URL("index.html", import.meta.url)],
  ["/app.mjs", new URL("app.mjs", import.meta.url)],
  ...[
    "browser",
    "core",
    "contracts",
    "fees",
    "signing",
    "allocation",
    "encoding",
    "types",
    "chain",
    "transport",
    "request-policy",
    "ownership",
    "exit",
    "exit-api",
    "exit-browser",
    "exit-types",
    "exit-submission",
  ].map((name) => [`/dist/${name}.js`, new URL(`dist/${name}.js`, sdk)]),
]);
export const server = createServer(async (req, res) => {
  const file = files.get(new URL(req.url, "http://127.0.0.1:4361").pathname);
  if (req.method !== "GET" || !file) {
    res.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      "content-type": file.pathname.endsWith(".html")
        ? "text/html"
        : "text/javascript",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
    });
    res.end(bytes);
  } catch {
    res.writeHead(503).end("Build the candidate first.");
  }
});
server.listen(4361, "127.0.0.1", () =>
  console.log("Synthetic exit demo: http://127.0.0.1:4361/"),
);
