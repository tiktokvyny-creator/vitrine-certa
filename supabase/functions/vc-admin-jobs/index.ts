// Vitrine Certa · Edge Function "vc-admin-jobs" (Deno / Supabase)
// Deploy: supabase functions deploy vc-admin-jobs
// Segredos necessários (definidos via `supabase secrets set`, nunca no repositório):
//   VC_ADMIN_N8N_WEBHOOK_URL, VC_ADMIN_N8N_SECRET, ALLOWED_ORIGINS
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são fornecidos pelo próprio Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { handle, type Repo, type Run } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN_COLS = "id, kind, status, requested_by, product_id, created_at, started_at, finished_at, found, rejected, approved, saved, error_code";
const must = <T>(r: { data: T; error: unknown }) => { if (r.error) throw r.error; return r.data; };

const repo: Repo = {
  async getUserId(jwt) {
    const { data, error } = await anon.auth.getUser(jwt);
    return error || !data?.user ? null : data.user.id;
  },
  async isAdmin(userId) {
    const { data, error } = await service.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
    return !error && !!data;
  },
  async insertRun(r) {
    const { data, error } = await service.from("admin_job_runs").insert(r).select(RUN_COLS).single();
    if (error) throw { code: (error as { code?: string }).code };
    return data as Run;
  },
  async getRun(id) {
    return must(await service.from("admin_job_runs").select(RUN_COLS).eq("id", id).maybeSingle()) as Run | null;
  },
  async latestRun(kind) {
    return must(await service.from("admin_job_runs").select(RUN_COLS).eq("kind", kind)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()) as Run | null;
  },
  async updateRun(id, patch) {
    must(await service.from("admin_job_runs").update(patch).eq("id", id));
  },
  async countRunsSince(kind, userId, sinceIso) {
    const { count, error } = await service.from("admin_job_runs").select("id", { count: "exact", head: true })
      .eq("kind", kind).eq("requested_by", userId).gte("created_at", sinceIso);
    if (error) throw error;
    return count ?? 0;
  },
  async latestRunForProduct(productId) {
    return must(await service.from("admin_job_runs").select(RUN_COLS).eq("kind", "price_check").eq("product_id", productId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()) as Run | null;
  },
  async getProduct(id) {
    return must(await service.from("affiliate_products").select("id, external_id, network, source, price, old_price")
      .eq("id", id).maybeSingle());
  },
  async updateProductPrice(id, patch) {
    // Somente campos de preço/verificação. active, display_title, category e sort_order nunca são enviados
    // (e o trigger protect_admin_decisions os preserva mesmo assim).
    const data = must(await service.from("affiliate_products").update(patch).eq("id", id).select("id"));
    return Array.isArray(data) ? data.length : 0;
  },
};

// Logs estruturados e sanitizados: só evento + códigos/ids internos. Nada de URLs, headers, tokens ou títulos.
const log = (event: string, data: Record<string, unknown> = {}) => {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (["run_id", "code", "result", "action", "status"].includes(k) && typeof v === "string" && /^[\w-]{1,64}$/.test(v)) safe[k] = v;
  }
  console.log(JSON.stringify({ fn: "vc-admin-jobs", event, ...safe }));
};

Deno.serve((req) =>
  handle(req, {
    repo,
    env: {
      VC_ADMIN_N8N_WEBHOOK_URL: Deno.env.get("VC_ADMIN_N8N_WEBHOOK_URL") ?? "",
      VC_ADMIN_N8N_SECRET: Deno.env.get("VC_ADMIN_N8N_SECRET") ?? "",
      ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "https://vitrinecertaa.com.br,https://www.vitrinecertaa.com.br",
      SYNC_COOLDOWN_MIN: Deno.env.get("SYNC_COOLDOWN_MIN"),
      RUN_TIMEOUT_MIN: Deno.env.get("RUN_TIMEOUT_MIN"),
      ACK_TIMEOUT_MS: Deno.env.get("ACK_TIMEOUT_MS"),
      PRICE_TIMEOUT_MS: Deno.env.get("PRICE_TIMEOUT_MS"),
      PRICE_CHECKS_PER_HOUR: Deno.env.get("PRICE_CHECKS_PER_HOUR"),
      PRICE_CHECK_PRODUCT_COOLDOWN_S: Deno.env.get("PRICE_CHECK_PRODUCT_COOLDOWN_S"),
    },
    fetch,
    now: () => Date.now(),
    log,
  }).catch((e) => {
    log("unhandled", { code: "internal_error" });
    void e;
    return new Response(JSON.stringify({ ok: false, code: "internal_error", message: "Erro interno." }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  })
);
