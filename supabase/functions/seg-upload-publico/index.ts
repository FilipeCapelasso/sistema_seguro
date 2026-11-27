// seg-upload-publico — recebe a cotação SEM login (tela pública das meninas).
// Como não há login, a defesa é: motivo restrito a 2 valores, validação real do arquivo
// (assinatura, extensão, tamanho, PDF sem conteúdo ativo), limite por IP e global,
// campo-isca anti-robô e gravação sempre como o perfil técnico "Envio público".
// Esta função não lê nada do banco para o visitante: só responde ok/erro.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "seguros-cotacoes";
const MAX_BYTES = 10 * 1024 * 1024;
const MOTIVOS = ["nao_quer", "vai_fazer_depois"];

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


const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Perfil técnico (conta bloqueada para login) que assina os envios públicos. Criado sozinho na 1ª vez.
async function perfilPublico(): Promise<string | null> {
  const r = await admin.rpc("seguro_edge_perfil_publico");
  if (r.data) return r.data as string;
  const conta = await admin.auth.admin.createUser({
    email: "envio-publico@seguros.invalid",
    password: crypto.randomUUID() + crypto.randomUUID(),
    email_confirm: true,
    ban_duration: "876000h",
    user_metadata: { sistema: "seguros", tecnico: true },
  });
  if (conta.data?.user) {
    const c = await admin.rpc("seguro_edge_criar_perfil_publico", { p_uid: conta.data.user.id });
    if (c.error) await admin.auth.admin.deleteUser(conta.data.user.id);
  }
  const r2 = await admin.rpc("seguro_edge_perfil_publico"); // cobre corrida entre duas primeiras chamadas
  return (r2.data as string) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "metodo_invalido" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 300_000) return resp(413, { ok: false, erro: "arquivo_grande" });

  let form: FormData;
  try { form = await req.formData(); } catch { return resp(400, { ok: false, erro: "formulario_invalido" }); }

  // campo-isca: humanos não preenchem; robôs simples sim (responde "ok" sem gravar nada)
  if (String(form.get("site") ?? "") !== "") return resp(200, { ok: true });

  const motivo = String(form.get("motivo") ?? "");
  if (!MOTIVOS.includes(motivo)) return resp(400, { ok: false, erro: "motivo_invalido" });

  const file = form.get("arquivo");
  if (!(file instanceof File)) return resp(400, { ok: false, erro: "arquivo_ausente" });
  if (file.size <= 0) return resp(400, { ok: false, erro: "arquivo_vazio" });
  if (file.size > MAX_BYTES) return resp(413, { ok: false, erro: "arquivo_grande" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipo = detectar(bytes);
  if (!tipo) return resp(400, { ok: false, erro: "conteudo_invalido" });
  const extNome = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!EXT_OK[tipo.ext].includes(extNome)) return resp(400, { ok: false, erro: "extensao_diverge" });
  if (tipo.ext === "pdf" && pdfAtivo(bytes)) return resp(400, { ok: false, erro: "pdf_com_conteudo_ativo" });

  // limite por IP (guardamos só um hash, nunca o IP)
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "desconhecido").split(",")[0].trim();
  const ipHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + SERVICE_KEY.slice(-24))));
  const lim = await admin.rpc("seguro_edge_limite_publico", { p_ip_hash: ipHash });
  if (lim.error) return resp(lim.error.message === "limite_excedido" ? 429 : 500, { ok: false, erro: lim.error.message === "limite_excedido" ? "limite_excedido" : "erro_interno" });

  const uid = await perfilPublico();
  if (!uid) return resp(500, { ok: false, erro: "erro_interno" });

  let dados: unknown = null;
  const dadosRaw = String(form.get("dados") ?? "");
  if (dadosRaw && dadosRaw.length <= 20_000) { try { dados = JSON.parse(dadosRaw); } catch { dados = null; } }
  const origem = String(form.get("origem") ?? "") || null;

  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const path = `${uid}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${tipo.ext}`;
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: tipo.mime, upsert: false });
  if (up.error) return resp(500, { ok: false, erro: "falha_ao_gravar" });

  const { data, error } = await admin.rpc("seguro_edge_registrar_cotacao", {
    p_uid: uid, p_path: path, p_nome_arquivo: file.name, p_tipo: tipo.mime, p_tamanho: file.size,
    p_sha256: sha256, p_motivo: motivo, p_dados: dados, p_origem: origem,
  });
  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    const msg = /^[a-z_]+$/.test(error.message) ? error.message : "erro_interno";
    return resp(msg === "erro_interno" ? 500 : 400, { ok: false, erro: msg });
  }
  return resp(200, { ok: true, recebida_em: (data as { recebida_em?: string }).recebida_em });
});
