import { safeEqualToken } from "@agentr/shared";
import type { Request, Response, NextFunction } from "express";

/** Require worker token on artifact upload routes. */
export function requireWorkerToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : "";
    const alt = (req.header("x-agentr-token") ?? "").trim();
    const token = bearer || alt;
    if (!expected || !token || !safeEqualToken(token, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
