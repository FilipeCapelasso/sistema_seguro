// Página pública das meninas (sem login): várias cotações em fila → motivo → enviar uma a uma.
// O servidor valida tudo de novo (tipo real, tamanho, PDF ativo, limite por IP).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { lerCotacao } from "./ocr.js";

const $ = (s) => document.querySelector(s);
const MAX = 10 * 1024 * 1024, MAX_FILA = 30;
const TIPOS = ["image/jpeg", "image/png", "application/pdf"];
const MOTIVOS = { vai_fazer_depois: "Deixou pra mais tarde", nao_quer: "Não quis fazer" };
const MSG = {
  limite_excedido: "Muitos envios em pouco tempo. Aguarde alguns minutos e toque em Tentar de novo.",
  arquivo_grande: "Arquivo grande demais (máximo 10 MB).", arquivo_vazio: "Arquivo vazio.",
  conteudo_invalido: "Não é uma imagem JPG/PNG nem um PDF válido.",
  extensao_diverge: "O nome não combina com o tipo do arquivo. Envie o original.",
  pdf_com_conteudo_ativo: "PDF com conteúdo não permitido. Tire uma foto da cotação.",
  motivo_invalido: "Escolha o motivo.",
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tam = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(1).replace(".", ",") + " MB");
const erro = (id, m) => { const el = $("#" + id); el.textContent = m ?? ""; el.classList.toggle("oculto", !m); };

let fila = [], seq = 0, enviando = false, ocrOcupado = false;

function aviso(it) {
  if (it.estado === "ok") return "Enviada ✓";
  if (it.estado === "enviando") return "Enviando…";
  if (it.estado === "erro") return it.msg;
  return it.ocr ?? "";
}

function desenhar() {
  const vazia = fila.length === 0;
  $("#fila-card").classList.toggle("oculto", vazia);
  $("#envia-card").classList.toggle("oculto", vazia);
  $("#fila").innerHTML = fila.map((it) => `
    <li data-id="${it.id}" class="fila-item ${it.estado === "ok" ? "ok" : it.estado === "erro" ? "erro" : ""}">
      <div class="mini" ${it.previa ? `style="background-image:url('${it.previa}')"` : ""}>${it.estado === "ok" ? "✓" : it.previa ? "" : "PDF"}</div>
      <div class="info">
        <div class="peq" style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.arquivo.name)}</div>
        <div class="mut peq">${tam(it.arquivo.size)} · <span class="${it.estado === "erro" ? "txt-erro" : ""}">${esc(aviso(it))}</span></div>
      </div>
      ${it.estado === "ok" ? "" : `
      <div class="motivos" role="radiogroup" aria-label="Motivo">
        ${Object.entries(MOTIVOS).map(([k, v]) => `<label class="motivo"><input type="radio" name="m${it.id}" value="${k}" ${it.motivo === k ? "checked" : ""} ${it.estado === "enviando" ? "disabled" : ""}><span style="min-height:46px">${esc(v)}</span></label>`).join("")}
      </div>
      <button type="button" class="btn peq" data-rm="${it.id}" ${it.estado === "enviando" ? "disabled" : ""}>Remover</button>`}
    </li>`).join("");
  const pend = fila.filter((i) => i.estado !== "ok").length, ok = fila.length - pend;
  $("#enviar").disabled = enviando || pend === 0;
  $("#enviar").textContent = enviando ? "Enviando…" : fila.some((i) => i.estado === "erro") ? "TENTAR DE NOVO" : `ENVIAR ${pend > 1 ? pend + " COTAÇÕES" : "COTAÇÃO"}`;
  if (!enviando) $("#resumo").textContent = ok ? `${ok} enviada${ok > 1 ? "s" : ""} com sucesso${pend ? ` · ${pend} pendente${pend > 1 ? "s" : ""}` : ""}` : "";
  if (!pend && ok) $("#envia-card").classList.add("oculto");
}

function adicionar(lista) {
  erro("erro1", "");
  const msgs = [];
  for (const f of [...lista]) {
    if (fila.filter((i) => i.estado !== "ok").length >= MAX_FILA) { msgs.push(`Máximo de ${MAX_FILA} por vez.`); break; }
    if (!TIPOS.includes(f.type)) { msgs.push(`"${f.name}": envie JPG, PNG ou PDF.`); continue; }
    if (f.size <= 0) { msgs.push(`"${f.name}" está vazio.`); continue; }
    if (f.size > MAX) { msgs.push(`"${f.name}" passa de 10 MB.`); continue; }
    fila.push({ id: ++seq, arquivo: f, previa: f.type === "application/pdf" ? null : URL.createObjectURL(f), motivo: null, estado: "pronto", msg: "", leitura: null, ocr: "" });
  }
  if (msgs.length) erro("erro1", msgs.join(" "));
  desenhar(); lerProxima();
}

// OCR um de cada vez, em segundo plano (não trava o aparelho).
async function lerProxima() {
  if (ocrOcupado) return;
  const it = fila.find((i) => i.leitura === null && i.estado === "pronto");
  if (!it) return;
  ocrOcupado = true;
  it.ocr = "Lendo…";
  it.leitura = lerCotacao(it.arquivo, (p) => { it.ocr = `Lendo… ${p}%`; atualizarTexto(it); }).catch(() => ({ dados: null, origem: null }));
  atualizarTexto(it);
  const r = await it.leitura;
  it.ocr = r.dados ? "Dados lidos ✓" : "";
  atualizarTexto(it);
  ocrOcupado = false;
  lerProxima();
}
function atualizarTexto(it) {
  const li = $(`li[data-id="${it.id}"] .mut span`);
  if (li) li.textContent = aviso(it);
}

// Fotos de celular são grandes: reduz para até 2000 px (JPEG 85%) antes de enviar. Mais rápido e nunca estoura o limite.
async function otimizar(f) {
  if (f.type === "application/pdf" || f.size < 1.2 * 1024 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return f; }
}

async function enviarUm(it) {
  let lido = { dados: null, origem: null };
  if (it.leitura) lido = await Promise.race([it.leitura, new Promise((r) => setTimeout(() => r(lido), 20000))]);
  const fd = new FormData();
  const arq = await otimizar(it.arquivo);
  fd.append("arquivo", arq, arq.name);
  fd.append("motivo", it.motivo);
  fd.append("site", ""); // isca anti-robô: deve ficar vazio
  if (lido.dados) { fd.append("dados", JSON.stringify(lido.dados)); fd.append("origem", lido.origem); }
  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/functions/v1/seg-upload-publico`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY }, body: fd });
  } catch { throw { erro: "rede" }; }
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ok) throw { erro: j.erro ?? "falha" };
}

async function enviar() {
  if (enviando) return;
  erro("erro2", "");
  const alvo = fila.filter((i) => i.estado !== "ok");
  const sem = alvo.filter((i) => !i.motivo);
  if (sem.length) {
    erro("erro2", sem.length === 1 ? "Escolha o motivo da cotação marcada." : `Escolha o motivo de ${sem.length} cotações.`);
    $(`li[data-id="${sem[0].id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  enviando = true; desenhar();
  const barra = $("#barra"); barra.classList.remove("oculto");
  let feitos = 0;
  const prog = () => { const p = Math.round((feitos / alvo.length) * 100); $("#barra-i").style.width = p + "%"; barra.setAttribute("aria-valuenow", p); $("#resumo").textContent = `Enviando ${Math.min(feitos + 1, alvo.length)} de ${alvo.length}…`; };
  prog();
  for (const it of alvo) {
    it.estado = "enviando"; it.msg = ""; desenhar();
    try { await enviarUm(it); it.estado = "ok"; }
    catch (e) {
      it.estado = "erro";
      it.msg = e.erro === "rede" ? "Sem conexão. Toque em Tentar de novo." : (MSG[e.erro] ?? "Não foi possível enviar. Tente de novo.");
      if (e.erro === "limite_excedido") { // para a fila inteira; o resto continua pendente
        break;
      }
    }
    feitos++; prog(); desenhar();
  }
  enviando = false; barra.classList.add("oculto"); desenhar();
  const falhas = fila.filter((i) => i.estado === "erro").length;
  if (!falhas && fila.every((i) => i.estado === "ok")) concluir();
}

function concluir() {
  const n = fila.length;
  $("#fila-card").classList.add("oculto"); $("#envia-card").classList.add("oculto");
  const d = document.createElement("div");
  d.className = "cobertura"; d.setAttribute("role", "alertdialog"); d.setAttribute("aria-modal", "true");
  d.innerHTML = `<div class="card"><div class="grande" aria-hidden="true">✔</div>
    <h2 style="margin-top:.6rem">${n > 1 ? n + " cotações enviadas!" : "Cotação enviada!"}</h2>
    <p class="mut">Recebido pelo setor de recuperação. Obrigado!</p>
    <button type="button" class="btn pri" id="outra" style="width:100%">Enviar mais cotações</button></div>`;
  document.body.appendChild(d);
  const b = d.querySelector("#outra"); b.focus();
  b.addEventListener("click", () => { d.remove(); fila.forEach((i) => i.previa && URL.revokeObjectURL(i.previa)); fila = []; desenhar(); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

const zona = $("#zona"), inp = $("#arquivo");
zona.addEventListener("click", () => inp.click());
zona.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } });
inp.addEventListener("change", () => { adicionar(inp.files); inp.value = ""; });
$("#b-foto").addEventListener("click", () => $("#foto").click());
$("#foto").addEventListener("change", (e) => { adicionar(e.target.files); e.target.value = ""; });
["dragenter", "dragover"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("sobre"); }));
["dragleave", "drop"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("sobre"); }));
zona.addEventListener("drop", (e) => adicionar(e.dataTransfer.files));
window.addEventListener("dragover", (e) => e.preventDefault()); window.addEventListener("drop", (e) => e.preventDefault());

$("#todos").innerHTML = Object.entries(MOTIVOS).map(([k, v]) => `<button type="button" class="btn" data-todos="${k}" style="min-height:52px;font-weight:700">${esc(v)} (todas)</button>`).join("");
$("#todos").addEventListener("click", (e) => {
  const k = e.target.closest("[data-todos]")?.dataset.todos; if (!k) return;
  fila.forEach((i) => { if (i.estado !== "ok" && i.estado !== "enviando") i.motivo = k; });
  erro("erro2", ""); desenhar();
});
$("#fila").addEventListener("change", (e) => {
  const li = e.target.closest("li"); const it = fila.find((i) => i.id === Number(li?.dataset.id));
  if (it && e.target.name?.startsWith("m")) { it.motivo = e.target.value; erro("erro2", ""); }
});
$("#fila").addEventListener("click", (e) => {
  const id = Number(e.target.closest("[data-rm]")?.dataset.rm); if (!id) return;
  const x = fila.find((i) => i.id === id); if (x?.previa) URL.revokeObjectURL(x.previa); fila = fila.filter((i) => i.id !== id); desenhar();
});
$("#enviar").addEventListener("click", enviar);
