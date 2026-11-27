// seg-upload — recebe a cotação (JPG/PNG/PDF), valida no SERVIDOR e grava no bucket privado.
// Validações: usuário logado com perfil ativo, tamanho, extensão, assinatura real do arquivo
// (magic bytes), PDF sem conteúdo ativo, hash SHA-256. O arquivo original nunca é alterado.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "seguros-cotacoes";
const MAX_BYTES = 10 * 1024 * 1024;

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

function detectar(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length > 8 && png.every((v, i) => b[i] === v)) return { mime: "image/png", ext: "png" };
  if (b.length > 5 && String.fromCharCode(b[0], b[1], b[2], b[3], b[4]) === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf" };
  }
  return null;
}

const EXT_OK: Record<string, string[]> = { jpg: ["jpg", "jpeg"], png: ["png"], pdf: ["pdf"] };

// PDF com ações/scripts embutidos é recusado (verificação best-effort do texto bruto).
function pdfAtivo(b: Uint8Array): boolean {
  const txt = new TextDecoder("latin1").decode(b);
  return /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)(?![A-Za-z])/.test(txt);
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "metodo_invalido" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return resp(401, { ok: false, erro: "nao_autenticado" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) return resp(401, { ok: false, erro: "nao_autenticado" });
  const uid = ud.user.id;

  const { data: perfil } = await admin.rpc("seguro_edge_perfil", { p_uid: uid });
  if (!perfil) return resp(403, { ok: false, erro: "acesso_negado" });

  const rejeitar = async (erro: string, status = 400) => {
    await admin.rpc("seguro_edge_auditar", {
      p_uid: uid, p_acao: "upload_rejeitado", p_entidade: "upload", p_entidade_id: null, p_detalhes: { erro },
    });
    return resp(status, { ok: false, erro });
  };

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 300_000) return rejeitar("arquivo_grande", 413);

  let form: FormData;
  try { form = await req.formData(); } catch { return resp(400, { ok: false, erro: "formulario_invalido" }); }

  const file = form.get("arquivo");
  if (!(file instanceof File)) return resp(400, { ok: false, erro: "arquivo_ausente" });
  if (file.size <= 0) return rejeitar("arquivo_vazio");
  if (file.size > MAX_BYTES) return rejeitar("arquivo_grande", 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipo = detectar(bytes);
  if (!tipo) return rejeitar("conteudo_invalido");
  const extNome = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!EXT_OK[tipo.ext].includes(extNome)) return rejeitar("extensao_diverge");
  if (tipo.ext === "pdf" && pdfAtivo(bytes)) return rejeitar("pdf_com_conteudo_ativo");

  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const motivo = String(form.get("motivo") ?? "");
  const observacao = String(form.get("observacao") ?? "").slice(0, 500) || null;
  const origem = String(form.get("origem") ?? "") || null;

  let dados: unknown = null;
  const dadosRaw = String(form.get("dados") ?? "");
  if (dadosRaw) {
    if (dadosRaw.length > 20_000) return rejeitar("dados_grandes");
    try { dados = JSON.parse(dadosRaw); } catch { dados = null; }
  }

  const path = `${uid}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${tipo.ext}`;
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: tipo.mime, upsert: false });
  if (up.error) return resp(500, { ok: false, erro: "falha_ao_gravar" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.rpc("seguro_registrar_cotacao", {
    p_path: path,
    p_nome_arquivo: file.name,
    p_tipo: tipo.mime,
    p_tamanho: file.size,
    p_sha256: sha256,
    p_motivo: motivo,
    p_observacao: observacao,
    p_dados: dados,
    p_origem: origem,
  });
  if (error) {
    await admin.storage.from(BUCKET).remove([path]); // não deixa arquivo órfão
    const msg = /^[a-z_]+$/.test(error.message) ? error.message : "erro_interno";
    return resp(msg === "erro_interno" ? 500 : msg === "acesso_negado" ? 403 : 400, { ok: false, erro: msg });
  }
  return resp(200, { ok: true, ...(data as Record<string, unknown>) });
});
