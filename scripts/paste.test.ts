import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cleanupRigs, KEY, postBoard, rig, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

/** Le plus petit PNG valide : 1 × 1 pixel. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a pasted image is kept for the topic, under the state; format, size and topic are checked", async () => {
  const r = rig();
  writeSujets(r, [sujet()]);
  const serve = await startServe(r);
  try {
    const ok = await postBoard(serve.port, "/api/paste-image", { key: KEY, type: "image/png", data: PNG });
    expect(ok.status).toBe(200);
    const { path } = (await ok.json()) as { path: string };
    expect(path.startsWith(`${r.state}/uploads/`)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(readFileSync(path).equals(Buffer.from(PNG, "base64"))).toBe(true);

    expect((await postBoard(serve.port, "/api/paste-image", { key: KEY, type: "application/pdf", data: PNG })).status).toBe(400);
    expect((await postBoard(serve.port, "/api/paste-image", { key: KEY, type: "image/png", data: "" })).status).toBe(400);
    expect((await postBoard(serve.port, "/api/paste-image", { key: "C0NOPE0001:1.2", type: "image/png", data: PNG })).status).toBe(404);
    // sans l'origine du board, rien n'est écrit
    const foreign = await fetch(`http://127.0.0.1:${serve.port}/api/paste-image`, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ key: KEY, type: "image/png", data: PNG }) });
    expect(foreign.status).toBe(403);
    expect(existsSync(path)).toBe(true);
  } finally {
    await serve.stop();
  }
});
