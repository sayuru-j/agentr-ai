#!/usr/bin/env node
import express from "express";
import type { Request, Response } from "express";
import { AgentRelayBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./store.js";
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

  const store = new SessionStore();
  const hub = new WorkerHub(config, store);
  const bot = new AgentRelayBot(config, store, hub);

  hub.setMessageHandler((msg, socket) => {
    switch (msg.type) {
      case "worker.hello":
        void bot.onWorkerHello(
          msg.hostname,
          msg.version,
          msg.repos,
          socket,
          msg.pairingCode,
        );
        break;
      case "task.log":
        void bot.onTaskLog(msg.taskId, msg.chunk);
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
        void bot.onTaskStatus(msg.taskId, msg.status, msg.message);
        break;
    }
  });

  hub.start();
  console.log(`[server] WSS listening on :${config.wsPort}/ws`);

  const app = express();
  app.use(express.json({ limit: "2mb" }));

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
    });
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
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
