import { expect } from "@playwright/test";
import http from "http";
import { IAnalyticsRepository } from "../src/db/repository";
import { createServer, ServerOptions } from "../src/server";

// Unique per call, also across parallel workers
export function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const SECRET = "test-secret";
export const AUTH = { "X-Internal-Secret": SECRET };
export const JSON_AUTH = { "Content-Type": "application/json", ...AUTH };

export type Token = (string | number | null | object)[];

export function payload(projectId: string, url: string, sequence: number, events: Token[], sessionId: string = "s1"): string {
  return JSON.stringify({ e: ["0.8.76", sequence, 1000, 500, projectId, "u1", sessionId, 1, 0, 0, 0, url], a: events });
}

export const click: Token = [200, 9, 10, 500, 300, 16383, 16383, 0, 1, 0, "Buy", null, "h1.h1b", 1, null, 120, 40, "BUTTON", "buy", "btn"];
export const discover: Token = [100, 5, 1, 0, "HTML", {}];

export async function withServer(
  repository: IAnalyticsRepository,
  fn: (base: string) => Promise<void>,
  options: Partial<ServerOptions> = {}
): Promise<void> {
  const server = http.createServer(createServer({ repository, internalSecret: SECRET, ...options }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.close();
  }
}

export const ORIGIN = "https://site.example.com";

export async function register(base: string, id: string): Promise<void> {
  expect((await syncProject(base, { id, name: id, allowedDomains: ["site.example.com"] })).status).toBe(201);
}

export async function collect(base: string, body: string, origin?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (origin) headers.Origin = origin;
  const res = await fetch(`${base}/api/v1/collect`, { method: "POST", headers, body });
  expect(res.status).toBe(204);
}

export async function syncProject(base: string, body: object): Promise<Response> {
  return fetch(`${base}/api/v1/projects`, { method: "POST", headers: JSON_AUTH, body: JSON.stringify(body) });
}

