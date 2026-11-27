// Tela das meninas: anexar → motivo → enviar. Nada de digitar dados do cliente.
import { sessao, sair, fn, rpc, msgErro, esc, MOTIVOS, tamanhoLegivel, dataHora, raiz } from "./api.js";
import { lerCotacao } from "./ocr.js";
import { $, $$ } from "./ui.js";

const MAX = 10 * 1024 * 1024;
const TIPOS = ["image/jpeg", "image/png", "application/pdf"];
let arquivo = null, urlPrevia = null, leitura = null, enviando = false;

const erro = (id, m) => { const el = $("#" + id); el.textContent = m ?? ""; el.classList.toggle("oculto", !m); };
const limparErros = () => ["erro1", "erro2", "erro3"].forEach((i) => erro(i, ""));

function montarMotivos() {
  $("#motivos").innerHTML = Object.entries(MOTIVOS).map(([k, v]) =>
    `<label class="motivo"><input type="radio" name="motivo" value="${k}"><span>${esc(v)}</span></label>`).join("");
  $$("input[name=motivo]").forEach((r) => r.addEventListener("change", () => erro("erro2", "")));
}

function definirArquivo(f) {
  erro("erro1", "");
  if (!f) return;
  if (!TIPOS.includes(f.type)) return erro("erro1", "Envie uma foto JPG/PNG ou um PDF.");
  if (f.size <= 0) return erro("erro1", "O arquivo está vazio.");
  if (f.size > MAX) return erro("erro1", "O arquivo é grande demais (máximo 10 MB).");
  arquivo = f;
  if (urlPrevia) URL.revokeObjectURL(urlPrevia);
  const mini = $("#mini");
  if (f.type === "application/pdf") { mini.textContent = "PDF"; }
  else { urlPrevia = URL.createObjectURL(f); mini.innerHTML = `<img alt="Prévia da cotação" src="${urlPrevia}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`; }
  $("#nome-arq").textContent = f.name;
  $("#info-arq").textContent = `${tamanhoLegivel(f.size)} · ${f.type === "application/pdf" ? "PDF" : "Imagem"}`;
  $("#previa").classList.remove("oculto");
  $("#zona").classList.add("oculto");
  $("#b-foto").parentElement.classList.add("oculto");
  // leitura automática começa já, em segundo plano
  $("#status-ocr").textContent = "Lendo a cotação…";
  const atual = f;
  leitura = lerCotacao(f, (p) => { if (arquivo === atual) $("#status-ocr").textContent = `Lendo a cotação… ${p}%`; })
    .then((r) => { if (arquivo === atual) $("#status-ocr").textContent = r.dados ? "Dados lidos ✓" : ""; return r; });
}

function limpar() {
  arquivo = null; leitura = null;
  if (urlPrevia) { URL.revokeObjectURL(urlPrevia); urlPrevia = null; }
  $("#arquivo").value = ""; $("#foto").value = "";
  $("#previa").classList.add("oculto"); $("#zona").classList.remove("oculto");
  $("#b-foto").parentElement.classList.remove("oculto");
  $$("input[name=motivo]").forEach((r) => (r.checked = false));
  $("#obs").value = ""; $("#status-ocr").textContent = ""; limparErros();
}

async function enviar() {
  if (enviando) return;
  limparErros();
  if (!arquivo) { erro("erro1", "Anexe a cotação."); $("#passo1").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  const motivo = $("input[name=motivo]:checked")?.value;
  if (!motivo) { erro("erro2", "Escolha o motivo."); $("#passo2").scrollIntoView({ behavior: "smooth", block: "center" }); return; }

  enviando = true;
  const btn = $("#enviar"); btn.disabled = true; btn.textContent = "Enviando…";
  try {
    // espera a leitura terminar (até 20 s); se não der, envia assim mesmo
    let lido = { dados: null, origem: null };
    if (leitura) lido = await Promise.race([leitura, new Promise((r) => setTimeout(() => r(lido), 20000))]);
    const fd = new FormData();
    fd.append("arquivo", arquivo, arquivo.name);
    fd.append("motivo", motivo);
    const obs = $("#obs").value.trim();
    if (obs) fd.append("observacao", obs);
    if (lido.dados) { fd.append("dados", JSON.stringify(lido.dados)); fd.append("origem", lido.origem); }
    await fn("seg-upload", fd, { form: true });
    $("#ok").classList.remove("oculto");
    $("#outra").focus();
    limpar();
    carregarLista();
  } catch (e) {
    if (e.erro === "nao_autenticado") { location.replace(raiz()); return; }
    erro("erro3", msgErro(e));
  } finally {
    enviando = false; btn.disabled = false; btn.textContent = "ENVIAR COTAÇÃO";
  }
}

const RESULTADO = {
  recebida: ["Recebida", ""], em_andamento: ["Em andamento", "s-contato"],
  fechou: ["Seguro fechado 🎉", "s-ok"], sem_sucesso: ["Sem sucesso", "s-no"],
};
async function carregarLista() {
  try {
    const itens = await rpc("seguro_minhas_cotacoes", { p_limite: 15 });
    $("#lista").innerHTML = itens.length
      ? itens.map((i) => { const [t, c] = RESULTADO[i.resultado] ?? RESULTADO.recebida;
          return `<li><div style="min-width:0"><div class="peq" style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.arquivo_nome)}</div>
          <div class="mut peq">${esc(dataHora(i.criado_em))} · ${esc(MOTIVOS[i.motivo_recusa] ?? "")}</div></div><span class="tag ${c}">${esc(t)}</span></li>`; }).join("")
      : `<li class="mut">Você ainda não enviou nenhuma cotação.</li>`;
  } catch { $("#lista").innerHTML = `<li class="mut">Não foi possível carregar a lista.</li>`; }
}

async function iniciar() {
  const s = await sessao().catch(() => null);
  if (!s || !s.perfil) { location.replace(raiz()); return; }
  $("#quem").textContent = s.perfil.nome;
  if (s.perfil.papel !== "envio") $("#ir-painel").classList.remove("oculto");
  $("#sair").addEventListener("click", sair);
  montarMotivos();
  const zona = $("#zona"), inp = $("#arquivo");
  zona.addEventListener("click", () => inp.click());
  zona.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } });
  inp.addEventListener("change", () => definirArquivo(inp.files[0]));
  $("#b-foto").addEventListener("click", () => $("#foto").click());
  $("#foto").addEventListener("change", (e) => definirArquivo(e.target.files[0]));
  $("#trocar").addEventListener("click", () => { limpar(); inp.click(); });
  ["dragenter", "dragover"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("sobre"); }));
  ["dragleave", "drop"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("sobre"); }));
  zona.addEventListener("drop", (e) => definirArquivo(e.dataTransfer.files[0]));
  // evita abrir o arquivo no navegador se soltarem fora da zona
  window.addEventListener("dragover", (e) => e.preventDefault()); window.addEventListener("drop", (e) => e.preventDefault());
  $("#enviar").addEventListener("click", enviar);
  $("#outra").addEventListener("click", () => { $("#ok").classList.add("oculto"); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#app").hidden = false;
  carregarLista();
}
iniciar();
