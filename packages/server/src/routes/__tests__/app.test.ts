import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../app.js";

test("API 只允许本机 Host 访问", async () => {
  const app = createApp([]);

  const res = await app.request("http://localhost/api/health", {
    headers: {
      host: "example.com",
    },
  });
  assert.equal(res.status, 403);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "仅允许从本机访问 API");
});

test("API 会拒绝非本地 Origin 的跨域请求", async () => {
  const app = createApp([]);

  const res = await app.request("http://localhost/api/health", {
    headers: {
      origin: "https://evil.example",
    },
  });
  assert.equal(res.status, 403);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "仅允许来自本地页面的请求");
});

test("API 接受本地 Origin 请求", async () => {
  const app = createApp([]);

  const res = await app.request("http://localhost/api/health", {
    headers: {
      origin: "http://127.0.0.1:5173",
    },
  });
  assert.equal(res.status, 200);

  const data = await res.json() as { status: string };
  assert.equal(data.status, "ok");
});
