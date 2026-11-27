// seg-arquivo — gera URL assinada de curta duração (60 s) para a cotação original.
// Só papéis recuperacao/admin; toda visualização/download fica registrada na auditoria.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "seguros-cotacoes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "metodo_invalido" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return resp(401, { ok: false, erro: "nao_autenticado" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) return resp(401, { ok: false, erro: "nao_autenticado" });

  let body: { cotacao_id?: string; download?: boolean } = {};
  try { body = await req.json(); } catch { /* corpo inválido tratado abaixo */ }
  if (!body.cotacao_id || !UUID.test(body.cotacao_id)) return resp(400, { ok: false, erro: "id_invalido" });
  const download = body.download === true;

  const { data, error } = await admin.rpc("seguro_edge_arquivo", {
    p_uid: ud.user.id, p_cotacao: body.cotacao_id, p_download: download,
  });
  if (error) {
    const msg = error.message;
    if (msg === "acesso_negado") return resp(403, { ok: false, erro: "acesso_negado" });
    if (msg === "nao_encontrado") return resp(404, { ok: false, erro: "nao_encontrado" });
    return resp(500, { ok: false, erro: "erro_interno" });
  }
  const f = data as { path: string; nome: string; tipo: string };

  const signed = await admin.storage.from(BUCKET).createSignedUrl(f.path, 60, download ? { download: f.nome } : undefined);
  if (signed.error || !signed.data) return resp(500, { ok: false, erro: "falha_url" });
  return resp(200, { ok: true, url: signed.data.signedUrl, nome: f.nome, tipo: f.tipo });
});
