// Testes locais da Edge Function admin-sync (sem rede, sem banco real, sem n8n real).
// Rodar: deno test supabase/functions/admin-sync/handler.test.ts
function assert(cond: unknown, msg = "assert falhou"): asserts cond { if (!cond) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = "") {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`esperado ${B}, obtido ${A} ${msg}`);
}
import { discountOf, handle, type Deps, type Product, type Repo, type Run } from "./handler.ts";

const ORIGIN = "https://www.vitrinecertaa.com.br";
const ADMIN = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const SECRET = "test-secret-NAO-DEVE-VAZAR";
const HOOK = "https://n8n.example.test/webhook/PRIVADO-abc123";
const JWT_ADMIN = "jwt-admin-token-xyz";
const JWT_USER = "jwt-user-token-xyz";

type FullProduct = Product & { active: boolean; display_title: string | null; category: string; sort_order: number;
  discount_percent?: number | null; price_checked_at?: string; price_check_status?: string };

function makeRepo(products: FullProduct[] = []) {
  const runs: Run[] = [];
  let seq = 0;
  const calls = { updateProductPrice: [] as Record<string, unknown>[] };
  const repo: Repo = {
    getUserId: async (jwt) => (jwt === JWT_ADMIN ? ADMIN : jwt === JWT_USER ? USER : null),
    isAdmin: async (id) => id === ADMIN,
    insertRun: async (r) => {
      await new Promise((res) => setTimeout(res, 1)); // força concorrência real entre requisições
      if (r.kind === "sync" && runs.some((x) => x.kind === "sync" && (x.status === "requested" || x.status === "running"))) {
        throw { code: "23505" }; // mesmo comportamento do índice único parcial
      }
      const run: Run = { id: `run-${++seq}`, kind: r.kind, status: r.status, requested_by: r.requested_by, product_id: r.product_id ?? null,
        created_at: new Date(clock.t).toISOString(), started_at: null, finished_at: null, found: null, rejected: null, approved: null, saved: null, error_code: null };
      runs.push(run); return { ...run };
    },
    getRun: async (id) => runs.find((r) => r.id === id) ?? null,
    latestRun: async (kind) => [...runs].reverse().find((r) => r.kind === kind) ?? null,
    updateRun: async (id, patch) => { Object.assign(runs.find((r) => r.id === id)!, patch); },
    countRunsSince: async (kind, uid, since) => runs.filter((r) => r.kind === kind && r.requested_by === uid && r.created_at >= since).length,
    latestRunForProduct: async (pid) => [...runs].reverse().find((r) => r.kind === "price_check" && r.product_id === pid) ?? null,
    getProduct: async (id) => products.find((p) => String(p.id) === id) ?? null,
    updateProductPrice: async (id, patch) => {
      calls.updateProductPrice.push({ ...patch });
      const p = products.find((x) => String(x.id) === id); if (!p) return 0;
      Object.assign(p, patch); return 1;
    },
  };
  return { repo, runs, calls, products };
}
const clock = { t: Date.parse("2026-09-24T15:00:00Z") };

type N8nMode = "ack" | "timeout" | "error500" | "badjson" | "wrongrun" | ((body: Record<string, unknown>) => unknown);
function makeDeps(repo: Repo, n8n: N8nMode = "ack", envOver: Record<string, string> = {}) {
  const logs: string[] = [];
  const fetchCalls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    fetchCalls.push({ url, headers: init.headers as Record<string, string>, body });
    if (n8n === "timeout") {
      return await new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (n8n === "error500") return new Response("Internal error with https://n8n.example.test/webhook/PRIVADO-abc123", { status: 500 });
    if (n8n === "badjson") return new Response("<html>not json</html>", { status: 200 });
    if (n8n === "wrongrun") return Response.json({ accepted: true, run_id: "run-999" });
    if (typeof n8n === "function") return Response.json(n8n(body));
    return Response.json({ accepted: true, run_id: body.run_id });
  }) as unknown as typeof fetch;
  const deps: Deps = {
    repo, fetch: fakeFetch, now: () => clock.t,
    env: { N8N_ADMIN_WEBHOOK_URL: HOOK, N8N_ADMIN_WEBHOOK_SECRET: SECRET, ALLOWED_ORIGINS: `https://vitrinecertaa.com.br,${ORIGIN}`,
      ACK_TIMEOUT_MS: "50", PRICE_TIMEOUT_MS: "50", ...envOver },
    log: (e, d) => logs.push(JSON.stringify({ e, ...d })),
  };
  return { deps, logs, fetchCalls };
}
function req(body: unknown, { jwt = JWT_ADMIN, origin = ORIGIN, method = "POST" }: { jwt?: string | null; origin?: string | null; method?: string } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (jwt) h.authorization = `Bearer ${jwt}`;
  if (origin) h.origin = origin;
  return new Request("https://x.supabase.co/functions/v1/admin-sync", { method, headers: h, body: method === "POST" ? JSON.stringify(body) : undefined });
}
async function call(deps: Deps, body: unknown, o = {}) {
  const res = await handle(req(body, o), deps);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text, headers: res.headers };
}
function noLeak(...texts: string[]) {
  for (const t of texts) for (const s of [SECRET, HOOK, "PRIVADO", JWT_ADMIN, JWT_USER, "n8n.example.test"]) {
    assert(!t.includes(s), `vazamento de "${s}" em: ${t.slice(0, 160)}`);
  }
}
const apiProduct = (): FullProduct => ({ id: 7, external_id: "AE-7", network: "admitad", source: "api", price: 100, old_price: 150,
  active: true, display_title: "Título manual PT", category: "Eletrônicos", sort_order: 3 });

// ------------------------------------------------------------------ CORS / auth
Deno.test("CORS: preflight só para origens da Vitrine Certa", async () => {
  const { deps } = makeDeps(makeRepo().repo);
  const ok = await handle(new Request("https://x/f", { method: "OPTIONS", headers: { origin: ORIGIN } }), deps);
  assertEquals(ok.status, 204); assertEquals(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await handle(new Request("https://x/f", { method: "OPTIONS", headers: { origin: "https://evil.test" } }), deps);
  assertEquals(bad.status, 403); assertEquals(bad.headers.get("access-control-allow-origin"), null);
});
Deno.test("CORS: POST de outra origem ou sem origem é recusado sem chamar o n8n", async () => {
  const { deps, fetchCalls } = makeDeps(makeRepo().repo);
  assertEquals((await call(deps, { action: "start_sync" }, { origin: "https://evil.test" })).status, 403);
  assertEquals((await call(deps, { action: "start_sync" }, { origin: null })).status, 403);
  assertEquals(fetchCalls.length, 0);
});
Deno.test("sem sessão: 401 e nada executado", async () => {
  const m = makeRepo(); const { deps, fetchCalls } = makeDeps(m.repo);
  assertEquals((await call(deps, { action: "start_sync" }, { jwt: null })).status, 401);
  assertEquals((await call(deps, { action: "start_sync" }, { jwt: "token-invalido" })).status, 401);
  assertEquals(fetchCalls.length, 0); assertEquals(m.runs.length, 0);
});
Deno.test("usuário autenticado que não é admin: 403", async () => {
  const m = makeRepo(); const { deps, fetchCalls } = makeDeps(m.repo);
  const r = await call(deps, { action: "start_sync" }, { jwt: JWT_USER });
  assertEquals(r.status, 403); assertEquals(fetchCalls.length, 0); assertEquals(m.runs.length, 0);
});
Deno.test("função sem segredos configurados: 500 not_configured", async () => {
  const { deps } = makeDeps(makeRepo().repo, "ack", { N8N_ADMIN_WEBHOOK_SECRET: "" });
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 500); assertEquals(r.json.code, "not_configured");
});
Deno.test("entrada inválida: método, JSON, tamanho, ação e ids", async () => {
  const { deps } = makeDeps(makeRepo([apiProduct()]).repo);
  assertEquals((await handle(req(null, { method: "GET" }), deps)).status, 405);
  const bad = await handle(new Request("https://x/f", { method: "POST", headers: { origin: ORIGIN, authorization: `Bearer ${JWT_ADMIN}` }, body: "{nope" }), deps);
  assertEquals(bad.status, 400);
  assertEquals((await call(deps, { action: "start_sync", pad: "x".repeat(3000) })).status, 413);
  assertEquals((await call(deps, { action: "drop_table" })).status, 400);
  for (const id of ["1,2", "1;drop", "", "../7", "a".repeat(80)]) {
    assertEquals((await call(deps, { action: "check_price", product_id: id })).status, 400, id);
  }
});

// ------------------------------------------------------------------ busca de ofertas
Deno.test("start_sync: sucesso dispara UMA execução e retorna resumo sanitizado", async () => {
  const m = makeRepo(); const { deps, fetchCalls, logs } = makeDeps(m.repo);
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 202); assertEquals(r.json.run.status, "running");
  assertEquals(fetchCalls.length, 1);
  assertEquals(fetchCalls[0].url, HOOK);
  assertEquals(fetchCalls[0].headers["X-VC-Admin-Secret"], SECRET);
  assertEquals(fetchCalls[0].body, { mode: "sync", run_id: r.json.run.id });
  assertEquals(Object.keys(r.json.run).sort(), ["approved", "created_at", "error_code", "finished_at", "found", "id", "kind", "rejected", "saved", "started_at", "status"]);
  noLeak(r.text, ...logs);
});
Deno.test("clique duplicado: duas solicitações simultâneas => só uma execução", async () => {
  const m = makeRepo(); const { deps, fetchCalls } = makeDeps(m.repo);
  const [a, b] = await Promise.all([call(deps, { action: "start_sync" }), call(deps, { action: "start_sync" })]);
  assertEquals([a.status, b.status].sort(), [202, 409]);
  assertEquals(fetchCalls.length, 1);
  assertEquals(m.runs.filter((r) => r.kind === "sync").length, 1);
});
Deno.test("em andamento: nova solicitação recebe 409 com o status atual", async () => {
  const m = makeRepo(); const { deps, fetchCalls } = makeDeps(m.repo);
  await call(deps, { action: "start_sync" });
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 409); assertEquals(r.json.code, "already_running"); assertEquals(r.json.run.status, "running");
  assertEquals(fetchCalls.length, 1);
});
Deno.test("cooldown: nova busca antes de 10 min após a última => 429", async () => {
  const m = makeRepo(); const { deps } = makeDeps(m.repo);
  const s = await call(deps, { action: "start_sync" });
  m.runs[0].status = "completed"; m.runs[0].finished_at = new Date(clock.t).toISOString();
  clock.t += 2 * 60_000;
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 429); assertEquals(r.json.code, "cooldown"); assert(r.json.retry_after_s > 0);
  clock.t += 9 * 60_000;
  assertEquals((await call(deps, { action: "start_sync" })).status, 202);
  void s;
});
Deno.test("timeout do n8n no disparo: 504, execução marcada como failed", async () => {
  const m = makeRepo(); const { deps, logs } = makeDeps(m.repo, "timeout");
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 504); assertEquals(r.json.code, "n8n_timeout");
  assertEquals(m.runs[0].status, "failed"); assertEquals(m.runs[0].error_code, "n8n_timeout");
  noLeak(r.text, ...logs);
});
Deno.test("erro do n8n (500 com URL privada no corpo): 502 sem vazar nada", async () => {
  const m = makeRepo(); const { deps, logs } = makeDeps(m.repo, "error500");
  const r = await call(deps, { action: "start_sync" });
  assertEquals(r.status, 502); assertEquals(r.json.code, "n8n_error"); assertEquals(m.runs[0].status, "failed");
  noLeak(r.text, ...logs);
});
Deno.test("resposta inválida do n8n (não-JSON ou run_id errado): 502 invalid_response", async () => {
  for (const mode of ["badjson", "wrongrun"] as const) {
    const m = makeRepo(); const { deps } = makeDeps(m.repo, mode);
    const r = await call(deps, { action: "start_sync" });
    assertEquals(r.status, 502, mode); assertEquals(r.json.code, "invalid_response", mode); assertEquals(m.runs[0].status, "failed");
  }
});
Deno.test("status: execução travada além do limite vira timeout; campos sanitizados", async () => {
  const m = makeRepo(); const { deps } = makeDeps(m.repo);
  const s = await call(deps, { action: "start_sync" });
  clock.t += 16 * 60_000;
  const r = await call(deps, { action: "status", run_id: s.json.run.id });
  assertEquals(r.json.run.status, "timeout"); assertEquals(r.json.run.error_code, "timeout");
  assert(!("requested_by" in r.json.run) && !("product_id" in r.json.run));
  const latest = await call(deps, { action: "status" });
  assertEquals(latest.json.run.id, s.json.run.id);
});
Deno.test("status: conclusão reportada pelo n8n aparece com os contadores", async () => {
  const m = makeRepo(); const { deps } = makeDeps(m.repo);
  const s = await call(deps, { action: "start_sync" });
  Object.assign(m.runs[0], { status: "completed", finished_at: new Date(clock.t).toISOString(), found: 40, rejected: 12, approved: 28, saved: 28 });
  const r = await call(deps, { action: "status", run_id: s.json.run.id });
  assertEquals([r.json.run.found, r.json.run.rejected, r.json.run.approved, r.json.run.saved], [40, 12, 28, 28]);
});

// ------------------------------------------------------------------ verificação de preço
const evidence = (over: Record<string, unknown> = {}) => (b: Record<string, unknown>) => ({
  run_id: b.run_id, external_id: b.external_id, found: true, price: 89.9, old_price: 149.9, currency: "BRL",
  source: "admitad_feed", observed_at: new Date(clock.t - 3_600_000).toISOString(), ...over,
});
Deno.test("check_price confirmado: atualiza só preço/data; active e display_title preservados", async () => {
  const m = makeRepo([apiProduct()]); const { deps, fetchCalls, logs } = makeDeps(m.repo, evidence());
  const r = await call(deps, { action: "check_price", product_id: "7" });
  assertEquals(r.status, 200); assertEquals(r.json.result, "confirmed");
  assertEquals(r.json.price, 89.9); assertEquals(r.json.previous_price, 100); assertEquals(r.json.discount_percent, 40);
  assertEquals(fetchCalls[0].body, { mode: "price_check", run_id: fetchCalls[0].body.run_id, external_id: "AE-7", network: "admitad" });
  assertEquals(Object.keys(m.calls.updateProductPrice[0]).sort(), ["discount_percent", "old_price", "price", "price_check_status", "price_checked_at"]);
  const p = m.products[0];
  assertEquals([p.active, p.display_title, p.category, p.sort_order], [true, "Título manual PT", "Eletrônicos", 3]);
  assertEquals(p.price_check_status, "confirmed"); assertEquals(p.price_checked_at, new Date(clock.t).toISOString());
  noLeak(r.text, ...logs);
});
Deno.test("check_price fora do feed: 'Não foi possível confirmar', preço intacto, data registrada", async () => {
  const m = makeRepo([apiProduct()]); const { deps } = makeDeps(m.repo, (b) => ({ run_id: b.run_id, external_id: b.external_id, found: false }));
  const r = await call(deps, { action: "check_price", product_id: 7 });
  assertEquals(r.json.result, "unconfirmed"); assert(r.json.message.startsWith("Não foi possível confirmar o preço"));
  const p = m.products[0];
  assertEquals([p.price, p.old_price, p.active], [100, 150, true]);
  assertEquals(p.price_check_status, "unconfirmed"); assert(p.price_checked_at);
  assertEquals(Object.keys(m.calls.updateProductPrice[0]).sort(), ["price_check_status", "price_checked_at"]);
});
Deno.test("check_price com evidência inválida: nada é gravado no produto", async () => {
  const bads: Record<string, unknown>[] = [
    { currency: "USD" }, { price: 0 }, { price: -5 }, { price: "89.90" }, { old_price: 50 }, { old_price: 89.9 },
    { source: "scraping" }, { observed_at: new Date(clock.t + 3_600_000).toISOString() },
    { observed_at: new Date(clock.t - 30 * 86_400_000).toISOString() }, { observed_at: "ontem" }, { external_id: "AE-OUTRO" }, { run_id: "run-x" },
  ];
  for (const over of bads) {
    const m = makeRepo([apiProduct()]); const { deps } = makeDeps(m.repo, evidence(over));
    const r = await call(deps, { action: "check_price", product_id: "7" });
    assertEquals(r.status, 502, JSON.stringify(over)); assertEquals(r.json.message, "Não foi possível confirmar o preço.");
    assertEquals(m.calls.updateProductPrice.length, 0, JSON.stringify(over));
    assertEquals(m.products[0].price, 100);
  }
});
Deno.test("check_price: timeout e erro do n8n não inventam valor", async () => {
  for (const mode of ["timeout", "error500", "badjson"] as const) {
    const m = makeRepo([apiProduct()]); const { deps, logs } = makeDeps(m.repo, mode);
    const r = await call(deps, { action: "check_price", product_id: "7" });
    assert(r.status === 504 || r.status === 502, mode);
    assertEquals(r.json.message, "Não foi possível confirmar o preço.");
    assertEquals(m.calls.updateProductPrice.length, 0); assertEquals(m.products[0].price, 100);
    noLeak(r.text, ...logs);
  }
});
Deno.test("check_price em oferta manual: não chama o n8n e não inventa preço", async () => {
  const manual: FullProduct = { ...apiProduct(), id: 9, source: "manual", external_id: null, network: null };
  const m = makeRepo([manual]); const { deps, fetchCalls } = makeDeps(m.repo, evidence());
  const r = await call(deps, { action: "check_price", product_id: "9" });
  assertEquals(r.json.result, "unconfirmed"); assertEquals(r.json.reason, "no_source");
  assertEquals(fetchCalls.length, 0); assertEquals(m.calls.updateProductPrice.length, 0);
});
Deno.test("check_price: rate limit por oferta (60 s) e por hora", async () => {
  const m = makeRepo([apiProduct()]); const { deps } = makeDeps(m.repo, evidence(), { PRICE_CHECKS_PER_HOUR: "3" });
  assertEquals((await call(deps, { action: "check_price", product_id: "7" })).status, 200);
  assertEquals((await call(deps, { action: "check_price", product_id: "7" })).status, 429);
  clock.t += 61_000; assertEquals((await call(deps, { action: "check_price", product_id: "7" })).status, 200);
  clock.t += 61_000; assertEquals((await call(deps, { action: "check_price", product_id: "7" })).status, 200);
  clock.t += 61_000; const r = await call(deps, { action: "check_price", product_id: "7" });
  assertEquals(r.status, 429); assertEquals(r.json.message, "Limite de verificações por hora atingido.");
});
Deno.test("oferta inexistente: 404", async () => {
  const { deps } = makeDeps(makeRepo([]).repo, evidence());
  assertEquals((await call(deps, { action: "check_price", product_id: "404" })).status, 404);
});
Deno.test("discountOf", () => {
  assertEquals(discountOf(89.9, 149.9), 40); assertEquals(discountOf(100, null), null); assertEquals(discountOf(100, 100), null);
});
Deno.test("todo error_code gravado pela função respeita a restrição do banco (^[a-z0-9_]{1,40}$)", async () => {
  const src = await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  const migration = await Deno.readTextFile(new URL("../../migrations/20260924120000_admin_jobs.sql", import.meta.url));
  const dbRe = new RegExp(migration.match(/error_code ~ '([^']+)'/)![1]);
  const codes = new Set<string>();
  for (const m of src.matchAll(/error_code: "([^"]+)"/g)) codes.add(m[1]);
  for (const m of src.matchAll(/code: "(n8n_[a-z_]+|invalid_response)"/g)) codes.add(m[1]);
  ["n8n_timeout", "n8n_error", "invalid_response"].forEach((c) => codes.add(c));
  assert(codes.size >= 6, `poucos códigos encontrados: ${[...codes]}`);
  for (const c of codes) assert(dbRe.test(c), `código ${c} seria recusado pelo banco`);
});
