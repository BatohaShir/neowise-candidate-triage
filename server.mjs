import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));
const viewScript = await readFile(new URL("./triage-view.mjs", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Body → the request text, or null when the input is not a non-empty string.
async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  const text = body && typeof body === "object" ? body.text : undefined;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

// The model gets at most `timeoutMs`. The signal lets a well-behaved provider stop early,
// the race covers one that ignores it.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The AI result is trusted only after this check: valid JSON, a known topic, a non-blank draft.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

export function createTriageHandler({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console } = {}) {
  return async function handleTriage(request, response) {
    const text = await readText(request);
    if (text === null) return json(response, 400, INVALID_INPUT);

    let raw;
    try {
      raw = await callModel(classify, text, timeoutMs);
    } catch (error) {
      log.warn(`[triage] manual_review: ${error.message}`);
      return json(response, 200, MANUAL_REVIEW);
    }

    const result = parseModelOutput(raw);
    if (!result) {
      log.warn("[triage] manual_review: model output failed validation");
      return json(response, 200, MANUAL_REVIEW);
    }
    return json(response, 200, { status: "ready", ...result });
  };
}

export function createAppServer(options) {
  const handleTriage = createTriageHandler(options);
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/triage-view.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(viewScript);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

// Start only when run as `node server.mjs`, not when imported by the tests.
// Compare real paths: a symlinked folder (macOS /tmp → /private/tmp) must still start the server.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, "127.0.0.1", () => console.log(`Open http://127.0.0.1:${port}`));
}
