import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AeeisService } from "./application/aeeis-service.js";
import { JsonFileStore } from "./adapters/json-store.js";
import type { CreateContextInput, CreateGoalInput, CreateMemoryInput, CreatePlanInput, TaskTransition } from "./contracts.js";

const store = new JsonFileStore(process.env.AEEIS_DATA_FILE ?? "data/aeeis.json");
await store.init();
const service = new AeeisService(store);
const port = Number(process.env.PORT ?? 3000);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    writeJson(response, 400, { error: message });
  }
});

server.listen(port, () => {
  console.log(`AEEIS API listening on http://localhost:${port}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && parts.length === 0) {
    serveFile(response, join(publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "app.js") {
    serveFile(response, join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    return;
  }

  if (method === "GET" && parts[0] === "health") {
    writeJson(response, 200, { status: "ok", service: "aeeis" });
    return;
  }

  if (method === "POST" && parts[0] === "goals" && parts.length === 1) {
    const goal = service.createGoal(await readJson<CreateGoalInput>(request));
    writeJson(response, 201, goal);
    return;
  }

  if (method === "GET" && parts[0] === "goals" && parts.length === 2) {
    const goalId = segment(parts, 1);
    writeJson(response, 200, {
      goal: service.getGoal(goalId),
      plans: service.listPlans(goalId),
      memories: service.listMemories(goalId),
    });
    return;
  }

  if (method === "POST" && parts[0] === "goals" && parts[2] === "memories") {
    const memory = service.addMemory(segment(parts, 1), await readJson<CreateMemoryInput>(request));
    writeJson(response, 201, memory);
    return;
  }

  if (method === "GET" && parts[0] === "goals" && parts[2] === "memories") {
    writeJson(response, 200, service.listMemories(segment(parts, 1)));
    return;
  }

  if (method === "POST" && parts[0] === "goals" && parts[2] === "plans") {
    const input = await readJson<Omit<CreatePlanInput, "goalId">>(request);
    const plan = service.createPlan({ ...input, goalId: segment(parts, 1) });
    writeJson(response, 201, plan);
    return;
  }

  if (method === "POST" && parts[0] === "goals" && parts[2] === "project-pulse") {
    writeJson(response, 201, service.createProjectPulsePlan(segment(parts, 1)));
    return;
  }

  if (method === "GET" && parts[0] === "plans" && parts.length === 2) {
    writeJson(response, 200, service.getSnapshot(segment(parts, 1)));
    return;
  }

  if (method === "POST" && parts[0] === "plans" && parts[2] === "context") {
    const manifest = service.createContextManifest(
      service.getSnapshot(segment(parts, 1)).goal.id,
      await readJson<CreateContextInput>(request),
    );
    writeJson(response, 201, manifest);
    return;
  }

  if (method === "POST" && parts[0] === "plans" && parts[2] === "tasks" && parts[4] === "transitions") {
    const body = await readJson<{ transition: TaskTransition; reason?: string }>(request);
    const receipt = service.transitionTask({
      planId: segment(parts, 1),
      taskId: segment(parts, 3),
      transition: body.transition,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    writeJson(response, 200, receipt);
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function segment(parts: string[], index: number): string {
  const value = parts[index];
  if (!value) throw new Error("Malformed route");
  return value;
}

function readJson<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function serveFile(response: ServerResponse, path: string, contentType: string): void {
  response.writeHead(200, { "content-type": contentType });
  createReadStream(path).on("error", () => {
    if (!response.headersSent) writeJson(response, 404, { error: "Not found" });
    else response.end();
  }).pipe(response);
}
