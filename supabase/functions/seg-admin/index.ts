// seg-admin — administração do sistema de seguros.
//   status           (público)   -> informa se o primeiro acesso ainda está pendente
//   primeiro_acesso  (público)   -> cria o 1º administrador com o código de instalação (uso único)
//   criar_usuario / atualizar_usuario / redefinir_senha / excluir_cliente  -> só administrador
// Só mexe em contas que têm perfil em seguros.perfis. Nunca adota nem altera contas de outros sistemas.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "seguros-cotacoes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PAPEIS = ["envio", "recuperacao", "admin"];

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

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");

const erroRpc = (msg: string) => {
  const m = /^[a-z_]+$/.test(msg) ? msg : "erro_interno";
  const status = m === "acesso_negado" ? 403 : m === "nao_encontrado" ? 404 : m === "erro_interno" ? 500 : 400;
  return resp(status, { ok: false, erro: m });
};

function validarCredenciais(email: unknown, senha: unknown) {
  const e = String(email ?? "").trim().toLowerCase();
  const s = String(senha ?? "");
  if (!EMAIL.test(e) || e.length > 120) return { erro: "email_invalido" } as const;
  if (s.length < 10 || s.length > 72) return { erro: "senha_fraca" } as const; // mínimo 10 caracteres
  return { e, s } as const;
}

async function criarContaAuth(email: string, senha: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: senha, email_confirm: true, user_metadata: { sistema: "seguros" },
  });
  if (error || !data?.user) {
    const jaExiste = error?.code === "email_exists" || /already|registered|exists/i.test(error?.message ?? "");
    return { erro: jaExiste ? "email_em_uso" : "falha_criar_conta" } as const;
  }
  return { id: data.user.id } as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "metodo_invalido" });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return resp(400, { ok: false, erro: "json_invalido" }); }
  const acao = String(b.acao ?? "");

  // ---------- públicas ----------
  if (acao === "status") {
    const { data } = await admin.rpc("seguro_edge_precisa_setup");
    return resp(200, { ok: true, setup: data === true });
  }

  if (acao === "primeiro_acesso") {
    const cred = validarCredenciais(b.email, b.senha);
    if ("erro" in cred) return resp(400, { ok: false, erro: cred.erro });
    const nome = String(b.nome ?? "").trim().slice(0, 80);
    if (nome.length < 2) return resp(400, { ok: false, erro: "nome_invalido" });
    const codigo = String(b.codigo ?? "").trim().toUpperCase();
    if (!codigo || codigo.length > 60) return resp(400, { ok: false, erro: "codigo_invalido" });

    const ok = await admin.rpc("seguro_edge_bootstrap_ok", { p_hash: await sha256Hex(codigo) });
    if (ok.error) return erroRpc(ok.error.message);
    if (ok.data !== true) return resp(403, { ok: false, erro: "codigo_invalido" });

    const conta = await criarContaAuth(cred.e, cred.s);
    if ("erro" in conta) return resp(409, { ok: false, erro: conta.erro });
    const fim = await admin.rpc("seguro_edge_bootstrap_concluir", { p_uid: conta.id, p_nome: nome });
    if (fim.error) {
      await admin.auth.admin.deleteUser(conta.id); // desfaz a conta criada
      return erroRpc(fim.error.message);
    }
    return resp(200, { ok: true });
  }

  // ---------- somente administrador ----------
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return resp(401, { ok: false, erro: "nao_autenticado" });
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) return resp(401, { ok: false, erro: "nao_autenticado" });
  const uid = ud.user.id;
  const { data: perfil } = await admin.rpc("seguro_edge_perfil", { p_uid: uid });
  if (!perfil || (perfil as { papel: string }).papel !== "admin") return resp(403, { ok: false, erro: "acesso_negado" });

  if (acao === "criar_usuario") {
    const cred = validarCredenciais(b.email, b.senha);
    if ("erro" in cred) return resp(400, { ok: false, erro: cred.erro });
    const papel = String(b.papel ?? "");
    if (!PAPEIS.includes(papel)) return resp(400, { ok: false, erro: "papel_invalido" });
    const nome = String(b.nome ?? "").trim().slice(0, 80);
    if (nome.length < 2) return resp(400, { ok: false, erro: "nome_invalido" });

    const conta = await criarContaAuth(cred.e, cred.s);
    if ("erro" in conta) return resp(409, { ok: false, erro: conta.erro });
    const r = await admin.rpc("seguro_edge_criar_perfil", { p_por: uid, p_uid: conta.id, p_nome: nome, p_papel: papel });
    if (r.error) {
      await admin.auth.admin.deleteUser(conta.id);
      return erroRpc(r.error.message);
    }
    return resp(200, { ok: true, id: conta.id });
  }

  if (acao === "atualizar_usuario") {
    const id = String(b.id ?? "");
    if (!UUID.test(id)) return resp(400, { ok: false, erro: "id_invalido" });
    const papel = b.papel == null ? null : String(b.papel);
    if (papel !== null && !PAPEIS.includes(papel)) return resp(400, { ok: false, erro: "papel_invalido" });
    const ativo = typeof b.ativo === "boolean" ? b.ativo : null;
    const nome = b.nome == null ? null : String(b.nome).trim().slice(0, 80);

    const r = await admin.rpc("seguro_edge_atualizar_perfil", { p_por: uid, p_uid: id, p_nome: nome, p_papel: papel, p_ativo: ativo });
    if (r.error) return erroRpc(r.error.message);
    if (ativo !== null) {
      // desativar também bloqueia o login; reativar libera
      await admin.auth.admin.updateUserById(id, { ban_duration: ativo ? "none" : "876000h" });
    }
    return resp(200, { ok: true });
  }

  if (acao === "redefinir_senha") {
    const id = String(b.id ?? "");
    const senha = String(b.senha ?? "");
    if (!UUID.test(id)) return resp(400, { ok: false, erro: "id_invalido" });
    if (senha.length < 10 || senha.length > 72) return resp(400, { ok: false, erro: "senha_fraca" });
    const existe = await admin.rpc("seguro_edge_perfil_existe", { p_uid: id }); // só contas do sistema de seguros
    if (existe.data !== true) return resp(404, { ok: false, erro: "nao_encontrado" });
    const r = await admin.auth.admin.updateUserById(id, { password: senha });
    if (r.error) return resp(500, { ok: false, erro: "falha_redefinir" });
    await admin.rpc("seguro_edge_auditar", { p_uid: uid, p_acao: "redefiniu_senha", p_entidade: "perfil", p_entidade_id: id, p_detalhes: null });
    return resp(200, { ok: true });
  }

  if (acao === "excluir_cliente") {
    const id = String(b.cliente_id ?? "");
    if (!UUID.test(id)) return resp(400, { ok: false, erro: "id_invalido" });
    const r = await admin.rpc("seguro_edge_excluir_cliente", { p_uid: uid, p_cliente: id, p_motivo: String(b.motivo ?? "").slice(0, 300) });
    if (r.error) return erroRpc(r.error.message);
    const path = (r.data as { arquivo_path?: string }).arquivo_path;
    if (path) {
      const rm = await admin.storage.from(BUCKET).remove([path]);
      if (rm.error) {
        await admin.rpc("seguro_edge_auditar", { p_uid: uid, p_acao: "falha_remover_arquivo", p_entidade: "cliente", p_entidade_id: id, p_detalhes: { path } });
        return resp(200, { ok: true, aviso: "arquivo_nao_removido" });
      }
    }
    return resp(200, { ok: true });
  }

  return resp(400, { ok: false, erro: "acao_invalida" });
});
