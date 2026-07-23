#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import express from "express";
import type { Request, Response } from "express";
import { ArtifactStore } from "./artifacts.js";
import { requireWorkerToken } from "./auth-http.js";
import { AgentRelayBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { SessionStore, defaultSessionPath } from "./store.js";
import { WorkerHub } from "./ws-hub.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.workerToken) {
    console.error(
      "WORKER_TOKEN is required. Set it in the environment or config.env.",
    );
    process.exit(1);
  }

  if (config.mockMode) {
    console.warn(
      "[server] Running in MOCK mode (no Teams credentials). Bot HTTP accepts test posts at /api/messages.",
    );
  }

  const store = new SessionStore(defaultSessionPath(config.dataDir));
  console.log(`[server] Session data: ${config.dataDir}`);
  const artifacts = new ArtifactStore(config.publicBaseUrl);
  artifacts.cleanup();
  const hub = new WorkerHub(config, store);
  const bot = new AgentRelayBot(config, store, hub, artifacts);

  hub.setMessageHandler((msg, socket) => {
    switch (msg.type) {
      case "worker.hello":
        void bot.onWorkerHello(
          msg.hostname,
          msg.version,
          msg.repos,
          socket,
          msg.pairingCode,
          msg.agentModel,
        );
        break;
      case "worker.config":
        bot.onWorkerConfig(msg.agentModel);
        break;
      case "worker.pong":
        bot.onWorkerPong(msg.requestId, msg.sentAt, msg.projects);
        break;
      case "file.result":
        bot.onFileResult(msg);
        break;
      case "task.log":
        void bot.onTaskLog(msg.taskId, msg.chunk);
        break;
      case "task.artifact":
        void bot.onTaskArtifact(msg);
        break;
      case "task.approval_request":
        void bot.onApprovalRequest(
          msg.taskId,
          msg.approvalId,
          msg.command,
          msg.reason,
        );
        break;
      case "task.status":
        void bot.onTaskStatus(
          msg.taskId,
          msg.status,
          msg.message,
          msg.exitCode,
          msg.queuePosition,
        );
        break;
    }
  });

  hub.start();
  console.log(`[server] WSS listening on :${config.wsPort}/ws`);
  console.log(`[server] Public base URL for artifacts: ${config.publicBaseUrl}`);

  const app = express();
  // Screenshots are base64 JPEGs — allow larger POSTs on /api/artifacts
  app.use(express.json({ limit: "25mb" }));

  app.get("/health", (_req, res) => {
    const worker = store.getWorker();
    res.json({
      ok: true,
      mockMode: config.mockMode,
      workerOnline: Boolean(worker),
      worker: worker
        ? { hostname: worker.hostname, repos: worker.repos }
        : null,
      pairedUsers: store.pairedUserIds.size,
      workerTokenConfigured: Boolean(config.workerToken),
      workerTokenLength: config.workerToken.length,
      publicBaseUrl: config.publicBaseUrl,
    });
  });

  const serveArtifact = (req: Request, res: Response) => {
    const file = artifacts.read(req.params.taskId, req.params.name);
    if (!file) {
      res.status(404).send("Not found");
      return;
    }
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const isImage = file.mimeType.startsWith("image/");
    if (!isImage) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${file.downloadName.replace(/"/g, "")}"`,
      );
    }
    res.send(file.buffer);
  };

  // Prefer /api/artifacts (already proxied by Caddy @bot path /api/*)
  app.get("/api/artifacts/:taskId/:name", serveArtifact);
  app.get("/artifacts/:taskId/:name", serveArtifact);

  // Teams sideload package (public; App ID only — no secrets)
  app.get("/api/agentr-teams.zip", (_req, res) => {
    const zipPath = config.teamsZipPath;
    if (!zipPath || !existsSync(zipPath)) {
      res.status(404).json({
        error: "agentr-teams.zip not found",
        hint: "Run setup on the VM, or set AGENTR_TEAMS_ZIP to the zip path",
        expected: zipPath ?? "/etc/agent-relay/agentr-teams.zip",
      });
      return;
    }
    const size = statSync(zipPath).size;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="agentr-teams.zip"',
    );
    res.setHeader("Content-Length", String(size));
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(zipPath).pipe(res);
  });

  app.post("/api/artifacts", requireWorkerToken(config.workerToken), async (req, res) => {
    const taskId = String(req.body?.taskId ?? "");
    const shots = Array.isArray(req.body?.screenshots)
      ? req.body.screenshots
      : req.body?.dataBase64
        ? [req.body]
        : [];
    if (!taskId || shots.length === 0) {
      res.status(400).json({ error: "taskId and screenshots required" });
      return;
    }

    const urls: Array<{ name: string; label: string; url: string }> = [];
    for (const shot of shots) {
      const name = String(shot.name ?? "screen.jpg");
      const mimeType = String(shot.mimeType ?? "image/jpeg");
      const dataBase64 = String(shot.dataBase64 ?? "");
      const label = String(shot.label ?? name);
      if (!dataBase64) continue;
      const stored = artifacts.save({
        taskId,
        name,
        mimeType,
        dataBase64,
        label,
      });
      urls.push({ name: stored.name, label: stored.label, url: stored.url });
    }

    if (urls.length === 0) {
      res.status(400).json({ error: "no valid screenshots" });
      return;
    }

    await bot.onScreenshotsUploaded(taskId, urls);
    res.json({ ok: true, count: urls.length, screenshots: urls });
  });

  app.post("/api/messages", async (req: Request, res: Response) => {
    if (config.mockMode || !bot.adapter) {
      // Lightweight mock endpoint for local testing without Bot Framework
      const text = String(req.body?.text ?? "");
      const userId = String(req.body?.from?.id ?? "mock-user");
      console.log(`[mock] message from ${userId}: ${text}`);

      if (text.toLowerCase().startsWith("/pair")) {
        const code = text.slice(5).trim();
        const ok = store.pair(userId, code);
        res.json({ reply: ok ? "paired" : "invalid code", pairingCode: store.pairingCode });
        return;
      }

      const worker = store.getWorker();
      if (!store.isPaired(userId)) {
        res.json({
          reply: "not paired",
          pairingCode: store.pairingCode,
        });
        return;
      }
      if (!worker) {
        res.json({ reply: "worker offline" });
        return;
      }

      const { parseProjectAlias } = await import("@agentr/shared");
      const { randomUUID } = await import("node:crypto");
      const { alias, prompt } = parseProjectAlias(text);
      const taskId = randomUUID();
      const conversation = {
        serviceUrl: "http://localhost",
        conversationId: "mock-conversation",
      };
      store.createTask({
        taskId,
        threadId: conversation.conversationId,
        prompt,
        projectAlias: alias,
        conversation,
      });
      hub.send({
        type: "task.create",
        taskId,
        prompt,
        threadId: conversation.conversationId,
        projectAlias: alias,
        conversation,
      });
      res.json({ reply: "task started", taskId });
      return;
    }

    bot.adapter.process(req, res, async (context) => {
      await bot.handleTurn(context);
    });
  });

  // Expose current pairing code for operator convenience (local / secured by network)
  app.get("/api/pairing-code", (_req, res) => {
    res.json({ pairingCode: store.pairingCode });
  });

  // Mock-only: approve/reject without Adaptive Cards
  app.post("/api/approve", (req: Request, res: Response) => {
    const taskId = String(req.body?.taskId ?? "");
    const approvalId = String(req.body?.approvalId ?? "");
    const decision =
      req.body?.decision === "reject" ? "reject" : "approve";
    if (!taskId || !approvalId) {
      res.status(400).json({ error: "taskId and approvalId required" });
      return;
    }
    const ok = hub.send({
      type: "task.approval_response",
      taskId,
      approvalId,
      decision,
    });
    res.json({ ok, decision });
  });

  app.listen(config.httpPort, () => {
    console.log(`[server] HTTP listening on :${config.httpPort}`);
    console.log(`[server] Pairing code: ${store.pairingCode}`);
    if (config.teamsZipPath && existsSync(config.teamsZipPath)) {
      console.log(
        `[server] Teams zip: ${config.publicBaseUrl}/api/agentr-teams.zip`,
      );
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
