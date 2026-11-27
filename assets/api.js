// Camada de acesso: login, RPCs, Edge Functions e utilitários compartilhados.
import { SUPABASE_URL, SUPABASE_ANON_KEY, FUSO } from "./config.js";

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const ERROS = {
  nao_autenticado: "Sua sessão expirou. Entre novamente.",
  acesso_negado: "Você não tem permissão para fazer isso.",
  telefone_invalido: "Telefone inválido. Use DDD + número.",
  data_invalida: "Data inválida.",
  valor_invalido: "Valor inválido.",
  nao_encontrado: "Registro não encontrado.",
  caminho_invalido: "Não foi possível processar o arquivo. Tente novamente.",
  arquivo_nao_encontrado: "O arquivo não foi encontrado. Tente enviar de novo.",
  arquivo_divergente: "O arquivo não confere. Tente enviar de novo.",
  limite_excedido: "Muitos envios em pouco tempo. Aguarde alguns minutos.",
  arquivo_grande: "O arquivo é grande demais (máximo 10 MB).",
  arquivo_vazio: "O arquivo está vazio.",
  conteudo_invalido: "Esse arquivo não é uma imagem JPG/PNG nem um PDF válido.",
  extensao_diverge: "O nome do arquivo não combina com o tipo dele. Envie a foto ou o PDF original.",
  pdf_com_conteudo_ativo: "Esse PDF tem conteúdo não permitido por segurança. Tire uma foto ou print da cotação.",
  motivo_invalido: "Escolha o motivo da recusa.",
  arquivo_ausente: "Anexe a cotação.",
  codigo_invalido: "Código inválido.",
  setup_indisponivel: "O primeiro acesso já foi concluído.",
  email_em_uso: "Esse e-mail já está em uso.",
  email_invalido: "E-mail inválido.",
  senha_fraca: "Senha fraca: use no mínimo 10 caracteres, com letras e números.",
  papel_invalido: "Perfil inválido.",
  nome_invalido: "Informe o nome.",
  nao_pode_alterar_a_si_mesmo: "Você não pode rebaixar ou desativar a si mesmo.",
  ultimo_admin: "Precisa existir pelo menos um administrador ativo.",
  muitas_tentativas: "Muitas tentativas. Aguarde alguns minutos.",
  situacao_invalida: "Situação inválida.",
  texto_vazio: "Escreva o texto.",
  dados_incompletos: "Preencha os campos obrigatórios.",
  link_invalido: "O link precisa começar com https://",
  user_banned: "Este usuário está desativado.",
  invalid_credentials: "E-mail ou senha incorretos.",
};

export function msgErro(e) {
  const cod = (e && (e.erro || e.code || e.message)) || "";
  if (ERROS[cod]) return ERROS[cod];
  const msg = String(e?.message ?? e ?? "");
  if (ERROS[msg]) return ERROS[msg];
  if (/Invalid login credentials/i.test(msg)) return ERROS.invalid_credentials;
  if (/banned/i.test(msg)) return ERROS.user_banned;
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
  return "Algo deu errado. Tente novamente.";
}

export async function rpc(nome, args = {}) {
  const { data, error } = await sb.rpc(nome, args);
  if (error) {
    if (error.code === "PGRST301" || /JWT/i.test(error.message)) throw { erro: "nao_autenticado" };
    throw { erro: error.message };
  }
  return data;
}

async function tokenAtual() {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function fn(nome, corpo, { form = false } = {}) {
  const token = await tokenAtual();
  const headers = { apikey: SUPABASE_ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!form) headers["Content-Type"] = "application/json";
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/${nome}`, { method: "POST", headers, body: form ? corpo : JSON.stringify(corpo) });
  } catch (e) {
    throw { erro: "Failed to fetch", message: "Failed to fetch" };
  }
  let j = null;
  try { j = await r.json(); } catch { /* resposta sem JSON */ }
  if (!r.ok || !j || j.ok === false) throw { erro: j?.erro ?? (r.status === 401 ? "nao_autenticado" : "erro") };
  return j;
}

// Sessão + perfil. Devolve {perfil} ou {perfil:null} (logado sem acesso) ou null (deslogado).
export async function sessao() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  try {
    const perfil = await rpc("seguro_meu_perfil");
    return { perfil: perfil ?? null, email: data.session.user.email };
  } catch (e) {
    if (e.erro === "nao_autenticado") return null;
    throw e;
  }
}

export async function sair() {
  await sb.auth.signOut();
  location.href = raiz();
}

export const raiz = () => new URL("../", import.meta.url).pathname;

// ---------- formatação ----------
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const moeda = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
export const dataBR = (iso) =>
  iso ? new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("pt-BR", { timeZone: iso.length === 10 ? undefined : FUSO }) : "—";
export const dataHora = (iso) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: FUSO, dateStyle: "short", timeStyle: "short" }) : "—";

export function tempoRelativo(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
  return dataBR(iso);
}

export const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: FUSO });
export const tamanhoLegivel = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

export const MOTIVOS = {
  nao_quer: "Não quer fazer",
  achou_caro: "Achou caro",
  vai_pensar: "Vai pensar",
  vai_fazer_depois: "Vai fazer depois",
  ja_possui: "Já possui seguro",
  outro: "Outro",
};
export const SITUACOES = {
  novo: "Novo cliente",
  aguardando_primeiro_contato: "Aguardando primeiro contato",
  primeiro_contato_realizado: "Primeiro contato realizado",
  aguardando_resposta: "Aguardando resposta",
  em_negociacao: "Em negociação",
  interessado: "Interessado",
  seguro_contratado: "Seguro contratado",
  recusou_novamente: "Recusou novamente",
  nao_foi_possivel_contato: "Não foi possível contato",
};
export const CLASSE_SITUACAO = {
  novo: "s-novo", aguardando_primeiro_contato: "s-aguard", primeiro_contato_realizado: "s-contato",
  aguardando_resposta: "s-contato", em_negociacao: "s-neg", interessado: "s-int",
  seguro_contratado: "s-ok", recusou_novamente: "s-no", nao_foi_possivel_contato: "s-no",
};
export const CATEGORIAS_MSG = {
  primeira_abordagem: "Primeira abordagem", achou_caro: "Achou caro", vai_pensar: "Vai pensar",
  vai_fazer_depois: "Vai fazer depois", nao_quer: "Não quer fazer", ja_possui: "Já possui seguro",
  sem_resposta: "Sem resposta", interesse: "Cliente interessado", coberturas: "Coberturas",
};
export const TIPOS_MATERIAL = {
  video: "Vídeo", video_curto: "Vídeo curto", imagem: "Imagem", frase: "Frase de venda",
  argumento: "Argumento", cobertura: "Cobertura",
};
export const PRIORIDADE = { 0: "Encerrado", 1: "Baixa", 2: "Média", 3: "Alta" };

// ---------- WhatsApp ----------
export function linkWhatsApp(telefoneNorm, texto) {
  if (!telefoneNorm) return null;
  const q = texto ? `?text=${encodeURIComponent(texto)}` : "";
  return `https://wa.me/${telefoneNorm}${q}`;
}

// Mensagem personalizada: só troca o que existe; nada de dado inventado.
export function preencherMensagem(modelo, c, atendente) {
  const nomeCompleto = (c.nome ?? "").trim();
  const primeiro = nomeCompleto.split(/\s+/)[0] ?? "";
  let t = modelo;
  // sem nome conhecido: tira o vocativo em vez de deixar "Olá, !"
  if (!primeiro) t = t.split(", {primeiro_nome}").join("").split(" {primeiro_nome}").join("").split("{primeiro_nome}").join("");
  const mapa = {
    "{primeiro_nome}": primeiro,
    "{nome}": nomeCompleto || primeiro,
    "{moto}": c.modelo_moto || "sua moto",
    "{valor}": c.valor_cotacao != null ? moeda(c.valor_cotacao) : "",
    "{seguradora}": c.seguradora || "seguradora",
    "{atendente}": (atendente ?? "").trim().split(/\s+/)[0] ?? "",
  };
  for (const [k, v] of Object.entries(mapa)) t = t.split(k).join(v);
  return t.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

export async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = texto; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* sem suporte */ }
    ta.remove(); return ok;
  }
}

export async function sha256Arquivo(file) {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
