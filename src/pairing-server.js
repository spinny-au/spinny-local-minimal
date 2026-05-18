import { createServer } from "node:http";
import qrcode from "qrcode-terminal";
import { pairNode, pairNodeDirect } from "./pairing.js";
import { loadState } from "./state.js";

const PORT = 47821;
const TIMEOUT_MS = 5 * 60 * 1000; // auto-close after 5 minutes

function printPairingQR(url) {
  console.log("\nScan to pair from your phone or another device:\n");
  qrcode.generate(url, { small: true });
  console.log(`\nOr open this URL on any signed-in device:\n${url}\n`);
  console.log("Waiting for pairing...\n");
}

const PAGE_SUCCESS = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Spinny — Paired</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.box{text-align:center;max-width:400px;padding:40px}.icon{font-size:48px;margin-bottom:16px}
h1{font-size:24px;margin:0 0 8px;font-weight:600}p{color:#888;margin:0 0 24px}
a{color:#7c5cfc;text-decoration:none;font-size:14px}</style></head>
<body><div class="box"><div class="icon">✓</div>
<h1>Node paired</h1>
<p>This machine is now connected to your Spinny account.</p>
<a href="https://spinny.au">Return to spinny.au →</a>
</div></body></html>`;

const PAGE_ERROR = (msg) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Spinny — Pairing failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.box{text-align:center;max-width:400px;padding:40px}.icon{font-size:48px;margin-bottom:16px}
h1{font-size:24px;margin:0 0 8px;font-weight:600}p{color:#888;margin:0 0 24px}
a{color:#7c5cfc;text-decoration:none;font-size:14px}</style></head>
<body><div class="box"><div class="icon">✗</div>
<h1>Pairing failed</h1>
<p>${msg}</p>
<a href="https://spinny.au">Return to spinny.au →</a>
</div></body></html>`;

export function startPairingServer({ onPaired, pairingPageUrl } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      // Health check — spinny.au pings this to confirm the node is ready
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        const state = loadState();
        return res.end(JSON.stringify({ ok: true, nodeId: state.nodeId, paired: state.paired }));
      }

      // Legacy token-based pairing — spinny.au redirects here with a server-issued token
      if (url.pathname === "/pair" && url.searchParams.has("token")) {
        const token = url.searchParams.get("token");
        try {
          const state = await pairNode({ token });
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(PAGE_SUCCESS);
          server.close();
          clearTimeout(timeout);
          onPaired?.(state);
          resolve(state);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(PAGE_ERROR(err.message));
        }
        return;
      }

      // Code-based pairing — browser sends pairing code + user email (no server session needed)
      if (url.pathname === "/pair-direct") {
        const code = url.searchParams.get("code");
        const email = url.searchParams.get("email");
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Content-Type": "application/json",
        };

        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          return res.end();
        }

        const state = loadState();
        if (!code || code.toUpperCase() !== (state.pairingCode || "").toUpperCase()) {
          res.writeHead(400, corsHeaders);
          return res.end(JSON.stringify({ error: "Invalid pairing code" }));
        }
        if (!email || !email.includes("@")) {
          res.writeHead(400, corsHeaders);
          return res.end(JSON.stringify({ error: "Valid email required" }));
        }
        try {
          const result = await pairNodeDirect({ accountEmail: email });
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ ok: true, nodeId: result.nodeId }));
          server.close();
          clearTimeout(timeout);
          onPaired?.(result);
          resolve(result);
        } catch (err) {
          res.writeHead(500, corsHeaders);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = pairingPageUrl || `https://spinny.au/pair?node=localhost:${PORT}`;
      printPairingQR(url);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`Pairing server already running on port ${PORT} — skipping`);
        resolve(null);
      } else {
        reject(err);
      }
    });

    // Auto-close if nobody pairs within 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      resolve(null);
    }, TIMEOUT_MS);
  });
}
