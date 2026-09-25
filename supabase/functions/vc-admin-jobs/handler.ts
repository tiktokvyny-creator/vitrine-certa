// Vitrine Certa · Edge Function "vc-admin-jobs" — lógica pura (sem I/O direto).
// Ações: start_sync (dispara 1 execução do admitad-sync-brl via n8n),
//        status (situação da busca), check_price (verifica o preço de UMA oferta).
// Segredos (URL do webhook e segredo do header) só existem aqui, via variáveis de ambiente.

export type RunStatus = "requested" | "running" | "completed" | "failed" | "timeout" | "unconfirmed";
export interface Run {
  id: string; kind: "sync" | "price_check"; status: RunStatus; requested_by: string;
  product_id: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  found: number | null; rejected: number | null; approved: number | null; saved: number | null;
  error_code: string | null;
}
export interface Product {
  id: string | number; external_id: string | null; network: string | null; source: string | null;
  price: number | null; old_price: number | null;
}
export interface Repo {
  getAuthIdentity(jwt: string): Promise<{ userId: string; aal: string | null } | null>;
  isAdmin(userId: string): Promise<boolean>;
  /** Deve lançar {code:"23505"} quando já existir uma busca pendente (índice único parcial). */
  insertRun(r: { kind: Run["kind"]; status: RunStatus; requested_by: string; product_id?: string | null }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  latestRun(kind: Run["kind"]): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Run>): Promise<void>;
  countRunsSince(kind: Run["kind"], userId: string, sinceIso: string): Promise<number>;
  latestRunForProduct(productId: string): Promise<Run | null>;
  getProduct(id: string): Promise<Product | null>;
  /** Atualiza SOMENTE os campos de preço/verificação. Retorna linhas afetadas. */
  updateProductPrice(id: string, patch: PricePatch): Promise<number>;
}
export interface PricePatch {
  price?: number; old_price?: number | null; discount_percent?: number | null;
  price_checked_at: string; price_check_status: "confirmed" | "unconfirmed";
}
export interface Env {
  VC_ADMIN_N8N_WEBHOOK_URL: string; VC_ADMIN_N8N_SECRET: string; ALLOWED_ORIGINS: string;
  SYNC_COOLDOWN_MIN?: string; RUN_TIMEOUT_MIN?: string; ACK_TIMEOUT_MS?: string; PRICE_TIMEOUT_MS?: string;
  PRICE_CHECKS_PER_HOUR?: string; PRICE_CHECK_PRODUCT_COOLDOWN_S?: string;
}
export interface Deps {
  repo: Repo; env: Env; fetch: typeof fetch; now: () => number;
  log: (event: string, data?: Record<string, unknown>) => void;
}

const PRICE_PATCH_KEYS = new Set(["price", "old_price", "discount_percent", "price_checked_at", "price_check_status"]);
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const UNCONFIRMED = "Não foi possível confirmar o preço.";
const MAX_BODY = 2048;

const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
const iso = (ms: number) => new Date(ms).toISOString();

export function sanitizeRun(r: Run | null) {
  if (!r) return null;
  const { id, kind, status, created_at, started_at, finished_at, found, rejected, approved, saved, error_code } = r;
  return { id, kind, status, created_at, started_at, finished_at, found, rejected, approved, saved, error_code };
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> | null {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function reply(status: number, body: unknown, cors: Record<string, string> | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors ?? {}) },
  });
}
const fail = (status: number, code: string, message: string, cors: Record<string, string> | null, extra: Record<string, unknown> = {}) =>
  reply(status, { ok: false, code, message, ...extra }, cors);

/** Chama o webhook do n8n com timeout. Nunca registra URL, headers ou corpo. */
async function callN8n(deps: Deps, payload: Record<string, unknown>, timeoutMs: number):
  Promise<{ ok: true; json: unknown } | { ok: false; code: "n8n_timeout" | "n8n_error" | "invalid_response" }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await deps.fetch(deps.env.VC_ADMIN_N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VC-Admin-Secret": deps.env.VC_ADMIN_N8N_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      redirect: "error",
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return { ok: false, code: "n8n_error" }; }
    const text = await res.text();
    if (text.length > 8192) return { ok: false, code: "invalid_response" };
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, code: "invalid_response" }; }
  } catch (e) {
    return { ok: false, code: (e as Error)?.name === "AbortError" ? "n8n_timeout" : "n8n_error" };
  } finally { clearTimeout(timer); }
}

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1_000_000;
const isPrice = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 10_000_000;

/** Valida a resposta de verificação de preço. Qualquer desvio => inválida (nada é gravado). */
export function parsePriceEvidence(j: unknown, runId: string, externalId: string, nowMs: number):
  | { kind: "found"; price: number; old_price: number | null }
  | { kind: "not_found" }
  | { kind: "invalid" } {
  if (!j || typeof j !== "object") return { kind: "invalid" };
  const o = j as Record<string, unknown>;
  if (o.run_id !== runId || o.external_id !== externalId || typeof o.found !== "boolean") return { kind: "invalid" };
  if (o.found === false) return { kind: "not_found" };
  if (o.currency !== "BRL" || o.source !== "admitad_feed" || !isPrice(o.price)) return { kind: "invalid" };
  const old = o.old_price ?? null;
  if (old !== null && (!isPrice(old) || (old as number) <= (o.price as number))) return { kind: "invalid" };
  const t = typeof o.observed_at === "string" ? Date.parse(o.observed_at) : NaN;
  if (!Number.isFinite(t) || t > nowMs + 5 * 60_000 || t < nowMs - 7 * 24 * 3_600_000) return { kind: "invalid" };
  return { kind: "found", price: Math.round((o.price as number) * 100) / 100, old_price: old === null ? null : Math.round((old as number) * 100) / 100 };
}

export function discountOf(price: number, old: number | null) {
  return old !== null && old > price ? Math.round((1 - price / old) * 100) : null;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const { env, repo, log } = deps;
  const cors = corsHeaders(req.headers.get("origin"), env);

  if (req.method === "OPTIONS") return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
  if (!cors) { log("rejected", { code: "origin_not_allowed" }); return fail(403, "origin_not_allowed", "Origem não permitida.", null); }
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Método não permitido.", cors);
  if (!env.VC_ADMIN_N8N_WEBHOOK_URL || !env.VC_ADMIN_N8N_SECRET) {
    log("misconfigured", { code: "missing_secrets" });
    return fail(500, "not_configured", "Função não configurada.", cors);
  }

  // Autenticação: sessão válida em AAL2 + presença na tabela admins.
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return fail(401, "unauthenticated", "Sessão ausente. Entre novamente.", cors);
  let identity: { userId: string; aal: string | null } | null = null;
  try { identity = await repo.getAuthIdentity(jwt); } catch { identity = null; }
  if (!identity) return fail(401, "unauthenticated", "Sessão inválida ou expirada. Entre novamente.", cors);
  if (identity.aal !== "aal2") {
    log("rejected", { code: "mfa_required" });
    return fail(403, "mfa_required", "Confirme o código do autenticador para continuar.", cors);
  }
  const userId = identity.userId;
  if (!(await repo.isAdmin(userId).catch(() => false))) {
    log("rejected", { code: "forbidden" });
    return fail(403, "forbidden", "Acesso restrito ao administrador.", cors);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "payload_too_large", "Requisição grande demais.", cors);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw || "{}"); } catch { return fail(400, "bad_request", "JSON inválido.", cors); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_request", "Corpo inválido.", cors);

  const now = deps.now();
  const runTimeoutMs = num(env.RUN_TIMEOUT_MIN, 15) * 60_000;

  const expireIfStale = async (r: Run | null) => {
    if (r && (r.status === "requested" || r.status === "running") && now - Date.parse(r.created_at) > runTimeoutMs) {
      await repo.updateRun(r.id, { status: "timeout", finished_at: iso(now), error_code: "timeout" });
      log("run_timeout", { run_id: r.id });
      return { ...r, status: "timeout" as RunStatus, finished_at: iso(now), error_code: "timeout" };
    }
    return r;
  };

  switch (body.action) {
    // ------------------------------------------------------------------ status
    case "status": {
      const id = typeof body.run_id === "string" ? body.run_id : null;
      if (id !== null && !ID_RE.test(id)) return fail(400, "bad_request", "Execução inválida.", cors);
      const run = await expireIfStale(id ? await repo.getRun(id) : await repo.latestRun("sync"));
      if (run && run.kind !== "sync") return fail(404, "not_found", "Execução não encontrada.", cors);
      return reply(200, { ok: true, run: sanitizeRun(run) }, cors);
    }

    // -------------------------------------------------------------- start_sync
    case "start_sync": {
      const last = await expireIfStale(await repo.latestRun("sync"));
      if (last && (last.status === "requested" || last.status === "running")) {
        return fail(409, "already_running", "Já existe uma busca em andamento.", cors, { run: sanitizeRun(last) });
      }
      const cooldownMs = num(env.SYNC_COOLDOWN_MIN, 10) * 60_000;
      const lastStart = last ? Date.parse(last.created_at) : 0;
      if (last && now - lastStart < cooldownMs) {
        const retry = Math.ceil((cooldownMs - (now - lastStart)) / 1000);
        return fail(429, "cooldown", `Aguarde ${Math.ceil(retry / 60)} min para uma nova busca.`, cors, { retry_after_s: retry, run: sanitizeRun(last) });
      }
      let run: Run;
      try {
        run = await repo.insertRun({ kind: "sync", status: "requested", requested_by: userId });
      } catch (e) {
        if ((e as { code?: string })?.code === "23505") {
          return fail(409, "already_running", "Já existe uma busca em andamento.", cors, { run: sanitizeRun(await repo.latestRun("sync")) });
        }
        log("db_error", { code: "insert_run_failed" });
        return fail(500, "db_error", "Não foi possível registrar a solicitação.", cors);
      }
      log("sync_requested", { run_id: run.id });
      const r = await callN8n(deps, { mode: "sync", run_id: run.id }, num(env.ACK_TIMEOUT_MS, 10_000));
      const acked = r.ok && typeof r.json === "object" && r.json !== null &&
        (r.json as Record<string, unknown>).accepted === true && (r.json as Record<string, unknown>).run_id === run.id;
      if (!acked) {
        const code = r.ok ? "invalid_response" : r.code;
        await repo.updateRun(run.id, { status: "failed", finished_at: iso(deps.now()), error_code: code });
        log("sync_failed", { run_id: run.id, code });
        const msg = code === "n8n_timeout" ? "A automação não respondeu a tempo." : "A automação recusou ou respondeu de forma inválida.";
        return fail(code === "n8n_timeout" ? 504 : 502, code, msg, cors, { run: sanitizeRun({ ...run, status: "failed", error_code: code }) });
      }
      const started = iso(deps.now());
      await repo.updateRun(run.id, { status: "running", started_at: started });
      log("sync_started", { run_id: run.id });
      return reply(202, { ok: true, run: sanitizeRun({ ...run, status: "running", started_at: started }) }, cors);
    }

    // ------------------------------------------------------------- check_price
    case "check_price": {
      const productId = typeof body.product_id === "string" ? body.product_id
        : Number.isInteger(body.product_id) ? String(body.product_id) : "";
      if (!ID_RE.test(productId)) return fail(400, "bad_request", "Oferta inválida.", cors);

      const perHour = num(env.PRICE_CHECKS_PER_HOUR, 20);
      if ((await repo.countRunsSince("price_check", userId, iso(now - 3_600_000))) >= perHour) {
        return fail(429, "rate_limited", "Limite de verificações por hora atingido.", cors);
      }
      const prev = await repo.latestRunForProduct(productId);
      const cool = num(env.PRICE_CHECK_PRODUCT_COOLDOWN_S, 60) * 1000;
      if (prev && now - Date.parse(prev.created_at) < cool) {
        return fail(429, "rate_limited", "Esta oferta foi verificada há instantes. Aguarde um minuto.", cors);
      }

      const product = await repo.getProduct(productId);
      if (!product) return fail(404, "not_found", "Oferta não encontrada.", cors);
      const run = await repo.insertRun({ kind: "price_check", status: "requested", requested_by: userId, product_id: productId });

      if (product.source === "manual" || !product.external_id || product.network !== "admitad") {
        await repo.updateRun(run.id, { status: "unconfirmed", finished_at: iso(deps.now()), error_code: "no_source" });
        return reply(200, { ok: true, result: "unconfirmed", reason: "no_source",
          message: `${UNCONFIRMED} Esta oferta não tem fonte automática de preço.` }, cors);
      }

      const r = await callN8n(deps,
        { mode: "price_check", run_id: run.id, external_id: product.external_id, network: product.network },
        num(env.PRICE_TIMEOUT_MS, 25_000));
      const checkedAt = iso(deps.now());
      if (!r.ok) {
        await repo.updateRun(run.id, { status: "failed", finished_at: checkedAt, error_code: r.code });
        log("price_check_failed", { run_id: run.id, code: r.code });
        return fail(r.code === "n8n_timeout" ? 504 : 502, r.code, UNCONFIRMED, cors);
      }
      const ev = parsePriceEvidence(r.json, run.id, product.external_id, deps.now());
      if (ev.kind === "invalid") {
        await repo.updateRun(run.id, { status: "failed", finished_at: checkedAt, error_code: "invalid_response" });
        log("price_check_failed", { run_id: run.id, code: "invalid_response" });
        return fail(502, "invalid_response", UNCONFIRMED, cors);
      }
      if (ev.kind === "not_found") {
        await repo.updateProductPrice(productId, { price_checked_at: checkedAt, price_check_status: "unconfirmed" });
        await repo.updateRun(run.id, { status: "unconfirmed", finished_at: checkedAt, error_code: "not_in_feed" });
        log("price_check_done", { run_id: run.id, result: "unconfirmed" });
        return reply(200, { ok: true, result: "unconfirmed", reason: "not_in_feed", checked_at: checkedAt,
          message: `${UNCONFIRMED} A oferta não está no feed atual da fonte.` }, cors);
      }
      const previousPrice = product.price;
      const patch: PricePatch = {
        price: ev.price, old_price: ev.old_price, discount_percent: discountOf(ev.price, ev.old_price),
        price_checked_at: checkedAt, price_check_status: "confirmed",
      };
      for (const k of Object.keys(patch)) if (!PRICE_PATCH_KEYS.has(k)) throw new Error("campo não permitido");
      const n = await repo.updateProductPrice(productId, patch);
      if (n !== 1) {
        await repo.updateRun(run.id, { status: "failed", finished_at: checkedAt, error_code: "update_failed" });
        return fail(500, "update_failed", UNCONFIRMED, cors);
      }
      await repo.updateRun(run.id, { status: "completed", finished_at: checkedAt });
      log("price_check_done", { run_id: run.id, result: "confirmed" });
      return reply(200, { ok: true, result: "confirmed", checked_at: checkedAt, previous_price: previousPrice,
        price: patch.price, old_price: patch.old_price, discount_percent: patch.discount_percent }, cors);
    }

    default:
      return fail(400, "bad_request", "Ação desconhecida.", cors);
  }
}
