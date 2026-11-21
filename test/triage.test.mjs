import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.mjs";
import { viewFor } from "../triage-view.mjs";

const quiet = { warn() {} };
const MANUAL = { status: "manual_review", topic: null, draft: null };

async function start(options) {
  const server = createAppServer({ log: quiet, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, { raw = false } = {}) =>
    fetch(`${base}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });
  return { server, post };
}

describe("POST /api/triage с выданным имитатором", () => {
  let app;
  before(async () => { app = await start(); });
  after(() => new Promise((resolve) => app.server.close(resolve)));

  test("нормальная заявка → ready с темой и черновиком", async () => {
    const res = await app.post({ text: "Где моя доставка?" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ready",
      topic: "delivery",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });

  const invalid = {
    "пустая строка": { text: "" },
    "только пробелы": { text: "  \n " },
    "нет поля text": {},
    "text не строка": { text: 42 },
    "тело null": null,
    "тело массив": ["Где моя доставка?"],
  };
  for (const [name, body] of Object.entries(invalid)) {
    test(`неверный ввод (${name}) → 400 invalid_input`, async () => {
      const res = await app.post(body);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { status: "invalid_input" });
    });
  }

  test("битый JSON → 400 invalid_input", async () => {
    const res = await app.post('{"text": "Где мой заказ"', { raw: true });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { status: "invalid_input" });
  });

  for (const tag of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`сбой модели ${tag} → manual_review без темы и черновика`, async () => {
      const started = performance.now();
      const res = await app.post({ text: `Сколько стоит доставка? ${tag}` });
      const elapsed = performance.now() - started;
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), MANUAL);
      // the mock sleeps 1200 ms on [timeout]; the API must give up after 300 ms
      assert.ok(elapsed < 900, `ответ пришёл за ${Math.round(elapsed)} мс`);
    });
  }
});

describe("таймаут не зависит от того, слушает ли провайдер отмену", () => {
  let app;
  before(async () => { app = await start({ classify: () => new Promise(() => {}) }); });
  after(() => new Promise((resolve) => app.server.close(resolve)));

  test("зависший провайдер → manual_review примерно через 300 мс", async () => {
    const started = performance.now();
    const res = await app.post({ text: "Где моя доставка?" });
    const elapsed = performance.now() - started;
    assert.deepEqual(await res.json(), MANUAL);
    assert.ok(elapsed >= 280 && elapsed < 900, `ответ пришёл за ${Math.round(elapsed)} мс`);
  });
});

describe("что видит менеджер", () => {
  test("при сбое черновик и тема очищаются, есть понятное сообщение", () => {
    const before = viewFor(200, { status: "ready", topic: "pricing", draft: "Цена 2 490 ₽" });
    assert.equal(before.topic, "Цена");
    assert.equal(before.draft, "Цена 2 490 ₽");

    for (const [httpStatus, body] of [[200, MANUAL], [500, { status: "server_error" }], [0, null]]) {
      const view = viewFor(httpStatus, body);
      assert.equal(view.kind, "manual");
      assert.equal(view.draft, "");
      assert.equal(view.topic, "");
      assert.match(view.message, /вручную/);
    }
  });

  test("ответ ready с непригодными данными на странице тоже не показывается", () => {
    assert.equal(viewFor(200, { status: "ready", topic: "refund", draft: "Ок" }).kind, "manual");
    assert.equal(viewFor(200, { status: "ready", topic: "other", draft: "  " }).kind, "manual");
  });

  test("пустой ввод → просьба ввести текст", () => {
    assert.equal(viewFor(400, { status: "invalid_input" }).kind, "invalid");
  });
});
