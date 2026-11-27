// Lista de clientes (filtros, paginação) e detalhe do cliente (original, dados, WhatsApp, histórico).
import {
  rpc, fn, msgErro, esc, moeda, dataBR, dataHora, tempoRelativo, tamanhoLegivel, copiar,
  MOTIVOS, SITUACOES, CLASSE_SITUACAO, PRIORIDADE, CATEGORIAS_MSG, linkWhatsApp, preencherMensagem,
} from "./api.js";
import { $, $$, toast, confirmar, modal, ocupado, debounce } from "./ui.js";
import { lerCotacao } from "./ocr.js";

const POR_PAGINA = 25;
let estado = { f: {}, pag: 0 };
let ctxGlobal = null;
let mensagensCache = null;

const opts = (obj, vazio) => `<option value="">${esc(vazio)}</option>` + Object.entries(obj).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");

// ===================== LISTA =====================
export async function montarClientes(el, ctx) {
  ctxGlobal = ctx;
  estado = { f: { ordem: "prioridade", ...(ctx.filtroInicial ?? {}) }, pag: 0 };
  const f = estado.f;
  el.innerHTML = `
    <div class="card">
      <div class="filtros">
        <label><span>Nome ou telefone</span><input type="search" id="f-busca" placeholder="Buscar…" value="${esc(f.busca ?? "")}"></label>
        <label><span>Modelo da moto</span><input type="search" id="f-moto" value="${esc(f.moto ?? "")}"></label>
        <label><span>Seguradora</span><input type="search" id="f-seg" value="${esc(f.seguradora ?? "")}"></label>
        <label><span>Motivo da recusa</span><select id="f-motivo">${opts(MOTIVOS, "Todos")}</select></label>
        <label><span>Situação</span><select id="f-sit">${opts(SITUACOES, "Todas")}</select></label>
        <label><span>Recebida de</span><input type="date" id="f-de" value="${esc(f.de ?? "")}"></label>
        <label><span>Recebida até</span><input type="date" id="f-ate" value="${esc(f.ate ?? "")}"></label>
        <label><span>Ordenar por</span><select id="f-ordem"><option value="prioridade">Prioridade</option><option value="recentes">Mais recentes</option><option value="antigos">Mais antigos</option></select></label>
      </div>
      <div class="chips">
        <button type="button" class="chip" id="c-novos" aria-pressed="${f.so_novos ? "true" : "false"}">Só novos</button>
        <button type="button" class="chip" id="c-inc" aria-pressed="${f.so_incompletos ? "true" : "false"}">Dados incompletos</button>
        <button type="button" class="chip" id="c-limpar">Limpar filtros</button>
      </div>
    </div>
    <div id="res" style="margin-top:1rem"><div class="carregando">Carregando…</div></div>`;
  $("#f-motivo").value = f.motivo ?? ""; $("#f-sit").value = f.situacao ?? ""; $("#f-ordem").value = f.ordem;

  const ler = () => {
    estado.f = {
      ordem: $("#f-ordem").value,
      ...($("#f-busca").value.trim() && { busca: $("#f-busca").value.trim() }),
      ...($("#f-moto").value.trim() && { moto: $("#f-moto").value.trim() }),
      ...($("#f-seg").value.trim() && { seguradora: $("#f-seg").value.trim() }),
      ...($("#f-motivo").value && { motivo: $("#f-motivo").value }),
      ...($("#f-sit").value && { situacao: $("#f-sit").value }),
      ...($("#f-de").value && { de: $("#f-de").value }),
      ...($("#f-ate").value && { ate: $("#f-ate").value }),
      ...($("#c-novos").getAttribute("aria-pressed") === "true" && { so_novos: true }),
      ...($("#c-inc").getAttribute("aria-pressed") === "true" && { so_incompletos: true }),
    };
    estado.pag = 0; carregar();
  };
  const deb = debounce(ler);
  ["f-busca", "f-moto", "f-seg"].forEach((i) => $("#" + i).addEventListener("input", deb));
  ["f-motivo", "f-sit", "f-de", "f-ate", "f-ordem"].forEach((i) => $("#" + i).addEventListener("change", ler));
  ["c-novos", "c-inc"].forEach((i) => $("#" + i).addEventListener("click", (e) => {
    e.currentTarget.setAttribute("aria-pressed", String(e.currentTarget.getAttribute("aria-pressed") !== "true")); ler();
  }));
  $("#c-limpar").addEventListener("click", () => ctx.irPara("clientes"));
  ctx.recarregarClientes = carregar;
  await carregar();
}

async function carregar() {
  const alvo = $("#res"); if (!alvo) return;
  let r;
  try { r = await rpc("seguro_listar_clientes", { p_filtros: estado.f, p_limite: POR_PAGINA, p_offset: estado.pag * POR_PAGINA }); }
  catch (e) { alvo.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
  if (!r.itens.length) { alvo.innerHTML = `<div class="card vazio">Nenhum cliente encontrado com esses filtros.</div>`; return; }

  const marcas = (c) =>
    `${c.visto ? "" : `<span class="tag s-novo">Novo</span> `}${c.repetido ? `<span class="tag s-aguard" title="Mesmo telefone em outra cotação">Repetido</span> ` : ""}${c.incompleto ? `<span class="tag" title="Falta nome ou telefone">Incompleto</span>` : ""}`;
  const pri = (c) => `<span class="p${c.prioridade}" title="Prioridade">${esc(PRIORIDADE[c.prioridade])}</span>`;
  const linhas = r.itens.map((c) => `<tr class="clic ${c.visto ? "" : "novo"}" data-id="${c.id}" tabindex="0">
      <td><strong>${esc(c.nome ?? "Sem nome")}</strong><div style="margin-top:.2rem">${marcas(c)}</div></td>
      <td class="nowrap">${esc(c.telefone ?? "—")}</td><td>${esc(c.modelo_moto ?? "—")}</td><td class="nowrap">${esc(dataBR(c.data_entrega))}</td>
      <td class="nowrap">${esc(moeda(c.valor_cotacao))}</td><td>${esc(c.seguradora ?? "—")}</td><td>${esc(MOTIVOS[c.motivo_recusa] ?? "")}</td>
      <td><span class="tag ${CLASSE_SITUACAO[c.situacao]}">${esc(SITUACOES[c.situacao])}</span></td><td>${pri(c)}</td>
      <td class="nowrap mut peq" title="${esc(dataHora(c.recebida_em))}">${esc(tempoRelativo(c.recebida_em))}</td></tr>`).join("");
  const cartoes = r.itens.map((c) => `<div class="cartao ${c.visto ? "" : "novo"}" data-id="${c.id}" tabindex="0">
      <div class="l1"><span>${esc(c.nome ?? "Sem nome")}</span><span class="p${c.prioridade} peq">${esc(PRIORIDADE[c.prioridade])}</span></div>
      <div class="l2">${esc(c.telefone ?? "sem telefone")} · ${esc(c.modelo_moto ?? "moto não identificada")}</div>
      <div class="l3"><span class="tag ${CLASSE_SITUACAO[c.situacao]}">${esc(SITUACOES[c.situacao])}</span>${marcas(c)}
        <span class="mut peq" style="margin-left:auto">${esc(MOTIVOS[c.motivo_recusa] ?? "")} · ${esc(tempoRelativo(c.recebida_em))}</span></div></div>`).join("");
  const de = estado.pag * POR_PAGINA + 1, ate = Math.min(r.total, de + r.itens.length - 1);
  alvo.innerHTML = `<div class="tabela-wrap"><table><thead><tr><th>Cliente</th><th>Telefone</th><th>Moto</th><th>Entrega</th><th>Valor</th><th>Seguradora</th><th>Motivo</th><th>Situação</th><th>Prioridade</th><th>Recebida</th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="lista-cartoes">${cartoes}</div>
    <div class="pag"><span class="mut peq">${de}–${ate} de ${r.total}</span><span>
      <button class="btn peq" id="ant" ${estado.pag === 0 ? "disabled" : ""}>Anterior</button>
      <button class="btn peq" id="prox" ${ate >= r.total ? "disabled" : ""}>Próxima</button></span></div>`;
  $$("[data-id]", alvo).forEach((n) => {
    const abrir = () => abrirCliente(n.dataset.id, ctxGlobal);
    n.addEventListener("click", abrir);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") abrir(); });
  });
  $("#ant")?.addEventListener("click", () => { estado.pag--; carregar(); });
  $("#prox")?.addEventListener("click", () => { estado.pag++; carregar(); });
}

// ===================== DETALHE =====================
const SUGESTAO = { achou_caro: "achou_caro", vai_pensar: "vai_pensar", vai_fazer_depois: "vai_fazer_depois", nao_quer: "nao_quer", ja_possui: "ja_possui", outro: "primeira_abordagem" };

export async function abrirCliente(id, ctx) {
  ctxGlobal = ctx ?? ctxGlobal;
  const fundo = $("#detalhe");
  fundo.classList.remove("oculto");
  fundo.innerHTML = `<div class="painel-det" role="dialog" aria-modal="true" aria-label="Detalhe do cliente"><div class="carregando">Carregando…</div></div>`;
  document.body.style.overflow = "hidden";
  const fechar = () => { fundo.classList.add("oculto"); fundo.innerHTML = ""; document.body.style.overflow = ""; document.removeEventListener("keydown", esc_); if ($("#res")) carregar(); else if (ctxGlobal?.aba === "painel") ctxGlobal.irPara("painel"); };
  const esc_ = (e) => { if (e.key === "Escape" && !$(".modal-fundo")) fechar(); };
  document.addEventListener("keydown", esc_);
  fundo.onclick = (e) => { if (e.target === fundo) fechar(); };
  try {
    const c = await rpc("seguro_obter_cliente", { p_id: id });
    if (!mensagensCache) mensagensCache = await rpc("seguro_listar_mensagens");
    desenharDetalhe(fundo, c, fechar);
  } catch (e) {
    $(".painel-det", fundo).innerHTML = `<div style="padding:1rem"><div class="aviso erro">${esc(msgErro(e))}</div><button class="btn" id="x">Fechar</button></div>`;
    $("#x", fundo).addEventListener("click", fechar);
  }
}

function desenharDetalhe(fundo, c, fechar) {
  const root = $(".painel-det", fundo);
  const cot = c.cotacao;
  const perfil = ctxGlobal?.perfil;
  const eAdmin = perfil?.papel === "admin";
  const zapSimples = linkWhatsApp(c.telefone_norm);
  const sugCat = SUGESTAO[cot.motivo_recusa] ?? "primeira_abordagem";
  const lidoAuto = cot.dados_extraidos && cot.extracao_origem && !c.dados_conferidos;

  root.innerHTML = `
  <header>
    <button class="btn peq" id="d-fechar" aria-label="Fechar">← Voltar</button>
    <h2>${esc(c.nome ?? "Cliente sem nome")}</h2>
    <span class="tag ${CLASSE_SITUACAO[c.situacao]}" id="tag-sit">${esc(SITUACOES[c.situacao])}</span>
    ${zapSimples ? `<a class="btn peq ok" id="d-zap" href="${zapSimples}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
  </header>
  <div class="det-corpo">
    <div>
      <div class="card">
        <h3>Cotação original</h3>
        <div class="chips" style="margin-bottom:.5rem">
          <button class="chip" id="z-mais" type="button">＋ Zoom</button><button class="chip" id="z-menos" type="button">－ Zoom</button>
          <button class="chip" id="z-reset" type="button">Ajustar</button><button class="btn peq" id="d-baixar" type="button">Baixar original</button>
        </div>
        <div class="visor" id="visor"><span class="mut">Carregando arquivo…</span></div>
        <p class="mut peq" style="margin:.6rem 0 0">${esc(cot.arquivo_nome)} · ${esc(tamanhoLegivel(cot.arquivo_tamanho))} · enviado por ${esc(cot.enviado_por ?? "—")} em ${esc(dataHora(cot.recebida_em))}. O original é preservado e nunca é alterado.</p>
      </div>
      <div class="card"><h3>Motivo informado no envio</h3>
        <p style="margin:0"><strong>${esc(MOTIVOS[cot.motivo_recusa] ?? "")}</strong>${cot.observacao_envio ? `<br><span class="mut">“${esc(cot.observacao_envio)}”</span>` : ""}</p></div>
      ${c.outras_cotacoes.length ? `<div class="card"><h3>Outras cotações com este telefone</h3><ul class="hist">${c.outras_cotacoes.map((o) =>
        `<li><span class="peq">${esc(dataBR(o.recebida_em))} · ${esc(o.moto ?? "moto não identificada")}</span><button class="btn peq" data-outra="${o.id}">Abrir</button></li>`).join("")}</ul></div>` : ""}
    </div>

    <div>
      <div class="card">
        <h3>Situação</h3>
        <div class="linha" style="align-items:end">
          <label class="campo" style="margin:0"><span>Alterar para</span><select id="sit">${Object.entries(SITUACOES).map(([k, v]) => `<option value="${k}" ${k === c.situacao ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
          <label class="campo" style="margin:0;flex:2 1 200px"><span>Observação (opcional)</span><input type="text" id="sit-obs" maxlength="500"></label>
          <button class="btn pri" id="sit-salvar" style="flex:0 0 auto">Salvar</button>
        </div>
        <p class="mut peq" style="margin:.5rem 0 0">Prioridade: <span class="p${c.prioridade}"><strong>${esc(PRIORIDADE[c.prioridade])}</strong></span> · Último contato: ${esc(c.ultimo_contato_em ? dataHora(c.ultimo_contato_em) : "nenhum")}</p>
      </div>

      <div class="card">
        <h3>Dados do cliente</h3>
        ${lidoAuto ? `<div class="aviso info">Dados lidos automaticamente da cotação. Confira antes de usar.</div>` : ""}
        <div id="ocr-aviso"></div>
        <form id="f-dados" novalidate>
          <div class="grade2">
            <label class="campo"><span>Nome</span><input type="text" id="d-nome" maxlength="120" value="${esc(c.nome ?? "")}"></label>
            <label class="campo"><span>Telefone (com DDD)</span><input type="tel" id="d-tel" maxlength="30" value="${esc(c.telefone ?? "")}" inputmode="tel"></label>
            <label class="campo"><span>Modelo da moto</span><input type="text" id="d-moto" maxlength="120" value="${esc(c.modelo_moto ?? "")}"></label>
            <label class="campo"><span>Data de entrega</span><input type="date" id="d-ent" value="${esc(c.data_entrega ?? "")}"></label>
            <label class="campo"><span>Valor da cotação (R$)</span><input type="text" id="d-val" inputmode="decimal" value="${c.valor_cotacao != null ? String(c.valor_cotacao).replace(".", ",") : ""}"></label>
            <label class="campo"><span>Seguradora</span><input type="text" id="d-seg" maxlength="80" value="${esc(c.seguradora ?? "")}"></label>
          </div>
          <div id="d-erro" class="aviso erro oculto" role="alert"></div>
          <button class="btn pri" type="submit">Salvar dados</button>
        </form>
      </div>

      <div class="card">
        <h3>Mensagens para o WhatsApp</h3>
        ${c.telefone_norm ? "" : `<div class="aviso atencao">Cadastre um telefone válido para abrir o WhatsApp.</div>`}
        <div class="chips" id="cats"></div>
        <div class="msgs" id="msgs"></div>
        <div id="confirma-contato"></div>
        <details style="margin-top:.8rem"><summary class="peq mut" style="cursor:pointer">Registrar contato por outro canal</summary>
          <div class="linha" style="margin-top:.5rem;align-items:end"><label class="campo" style="margin:0"><span>Canal</span><select id="ct-canal"><option value="ligacao">Ligação</option><option value="presencial">Presencial</option><option value="whatsapp">WhatsApp</option><option value="outro">Outro</option></select></label>
          <label class="campo" style="margin:0;flex:2 1 200px"><span>Anotação</span><input type="text" id="ct-txt" maxlength="500"></label><button class="btn" id="ct-ok" style="flex:0 0 auto">Registrar</button></div></details>
      </div>

      <div class="card">
        <h3>Histórico</h3>
        <div class="linha" style="align-items:end;margin-bottom:.8rem"><label class="campo" style="margin:0;flex:3 1 200px"><span>Nova observação</span><input type="text" id="ob-txt" maxlength="500"></label><button class="btn" id="ob-ok" style="flex:0 0 auto">Adicionar</button></div>
        <ul class="tl">${c.historico.map((h) => `<li class="${esc(h.tipo)}"><div class="peq mut">${esc(dataHora(h.em))}${h.usuario ? " · " + esc(h.usuario) : ""}</div>
          <div>${h.tipo === "contato" ? `<strong>Contato (${esc(h.canal ?? "")})</strong>` : h.tipo === "situacao" ? `<strong>Situação:</strong> ${esc(SITUACOES[h.de] ?? "—")} → ${esc(SITUACOES[h.para] ?? "—")}` : ""}
          ${h.texto ? ` ${esc(h.texto)}` : ""}</div></li>`).join("")}</ul>
      </div>
      ${eAdmin ? `<div class="card"><h3>Privacidade (LGPD)</h3><p class="mut peq">Exclui definitivamente o cliente, a cotação original e o histórico. A exclusão fica registrada na auditoria.</p><button class="btn perigo" id="d-excluir">Excluir cliente definitivamente</button></div>` : ""}
    </div>
  </div>`;

  $("#d-fechar", root).addEventListener("click", fechar);
  $$("[data-outra]", root).forEach((b) => b.addEventListener("click", () => abrirCliente(b.dataset.outra, ctxGlobal)));

  // ----- visor do original -----
  let escala = 1, blobDaImagem = null;
  const visor = $("#visor", root);
  const pedirUrl = (download) => fn("seg-arquivo", { cotacao_id: cot.id, download });
  pedirUrl(false).then(async (r) => {
    if (cot.arquivo_tipo === "application/pdf") {
      visor.innerHTML = `<iframe title="Cotação em PDF" src="${esc(r.url)}"></iframe>`;
      $$("#z-mais,#z-menos,#z-reset", root).forEach((b) => (b.disabled = true));
    } else {
      visor.innerHTML = `<img alt="Cotação original" src="${esc(r.url)}">`;
    }
    if (!cot.dados_extraidos) tentarLerAgora(r.url);
  }).catch((e) => { visor.innerHTML = `<span class="aviso erro">${esc(msgErro(e))}</span>`; });
  const zoom = (f) => { const im = $("img", visor); if (!im) return; escala = f === 0 ? 1 : Math.min(4, Math.max(0.4, escala * f)); im.style.transform = `scale(${escala})`; };
  $("#z-mais", root).addEventListener("click", () => zoom(1.25));
  $("#z-menos", root).addEventListener("click", () => zoom(0.8));
  $("#z-reset", root).addEventListener("click", () => zoom(0));
  $("#d-baixar", root).addEventListener("click", async (e) => {
    ocupado(e.currentTarget, true, "Preparando…");
    try { const r = await pedirUrl(true); window.open(r.url, "_blank", "noopener"); } catch (x) { toast(msgErro(x), "erro"); }
    ocupado(e.currentTarget, false);
  });

  // leitura automática de reserva (quando o envio não conseguiu ler)
  async function tentarLerAgora(url) {
    const av = $("#ocr-aviso", root);
    try {
      av.innerHTML = `<div class="aviso info">Lendo a cotação para preencher os dados…</div>`;
      const blob = await (await fetch(url)).blob();
      const arq = new File([blob], cot.arquivo_nome, { type: cot.arquivo_tipo });
      const r = await lerCotacao(arq);
      if (!r.dados) { av.innerHTML = ""; return; }
      const s = await rpc("seguro_salvar_extracao", { p_cotacao: cot.id, p_dados: r.dados, p_origem: r.origem });
      if (s.preenchido) { toast("Dados lidos da cotação. Confira antes de usar."); const novo = await rpc("seguro_obter_cliente", { p_id: c.id }); desenharDetalhe(fundo, novo, fechar); }
      else av.innerHTML = "";
    } catch { av.innerHTML = ""; }
  }

  // ----- situação / dados / observações / contato -----
  const recarregar = async () => { const novo = await rpc("seguro_obter_cliente", { p_id: c.id }); desenharDetalhe(fundo, novo, fechar); };
  const executar = async (btn, texto, fnc, okMsg) => {
    ocupado(btn, true, texto);
    try { await fnc(); if (okMsg) toast(okMsg, "ok"); await recarregar(); } catch (e) { toast(msgErro(e), "erro"); ocupado(btn, false); }
  };
  $("#sit-salvar", root).addEventListener("click", (e) => {
    const nova = $("#sit", root).value;
    if (nova === c.situacao && !$("#sit-obs", root).value.trim()) return toast("Escolha outra situação.");
    executar(e.currentTarget, "Salvando…", () => rpc("seguro_alterar_situacao", { p_id: c.id, p_situacao: nova, p_texto: $("#sit-obs", root).value }), "Situação atualizada");
  });
  $("#f-dados", root).addEventListener("submit", (e) => {
    e.preventDefault();
    const val = $("#d-val", root).value.trim().replace(/\./g, "").replace(",", ".");
    if (val && !(Number(val) > 0)) { const er = $("#d-erro", root); er.textContent = "Valor inválido."; er.classList.remove("oculto"); return; }
    $("#d-erro", root).classList.add("oculto");
    const dados = { nome: $("#d-nome", root).value, telefone: $("#d-tel", root).value, modelo_moto: $("#d-moto", root).value,
      data_entrega: $("#d-ent", root).value, valor_cotacao: val, seguradora: $("#d-seg", root).value };
    executar(e.submitter, "Salvando…", () => rpc("seguro_atualizar_cliente", { p_id: c.id, p_dados: dados }), "Dados salvos");
  });
  $("#ob-ok", root).addEventListener("click", (e) => {
    const t = $("#ob-txt", root).value.trim(); if (!t) return toast("Escreva a observação.");
    executar(e.currentTarget, "Salvando…", () => rpc("seguro_adicionar_observacao", { p_id: c.id, p_texto: t }));
  });
  $("#ct-ok", root).addEventListener("click", (e) =>
    executar(e.currentTarget, "Registrando…", () => rpc("seguro_registrar_contato", { p_id: c.id, p_canal: $("#ct-canal", root).value, p_texto: $("#ct-txt", root).value }), "Contato registrado"));
  $("#d-excluir", root)?.addEventListener("click", async () => {
    const mot = await modal({ titulo: "Excluir cliente definitivamente?", corpo: `<p>Isso apaga a cotação original, os dados e o histórico. Não dá para desfazer.</p><label class="campo"><span>Motivo (fica na auditoria)</span><input type="text" id="mx" maxlength="300"></label>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Excluir", c: "perigo", v: (m) => $("#mx", m).value.trim() || undefined }] });
    if (!mot) return;
    try { await fn("seg-admin", { acao: "excluir_cliente", cliente_id: c.id, motivo: mot }); toast("Cliente excluído", "ok"); fechar(); } catch (e) { toast(msgErro(e), "erro"); }
  });

  // ----- mensagens (sugerida primeiro; nunca envio automático) -----
  let cat = sugCat;
  const desenharMsgs = () => {
    const ativas = mensagensCache.filter((m) => m.ativo);
    const cats = [...new Set(ativas.map((m) => m.categoria))];
    $("#cats", root).innerHTML = cats.map((k) => `<button class="chip" type="button" data-cat="${k}" aria-pressed="${k === cat}">${esc(CATEGORIAS_MSG[k])}${k === sugCat ? " ★" : ""}</button>`).join("");
    $$("[data-cat]", root).forEach((b) => b.addEventListener("click", () => { cat = b.dataset.cat; desenharMsgs(); }));
    const lista = ativas.filter((m) => m.categoria === cat);
    $("#msgs", root).innerHTML = lista.length ? lista.map((m, i) => {
      const t = preencherMensagem(m.texto, c, perfil?.nome);
      return `<div class="msg ${cat === sugCat && i === 0 ? "sug" : ""}"><strong>${esc(m.titulo)}</strong>${cat === sugCat && i === 0 ? ` <span class="tag s-novo">Sugerida</span>` : ""}
        <pre>${esc(t)}</pre><div class="acoes"><button class="btn peq" data-copiar="${i}">Copiar</button>
        ${c.telefone_norm ? `<button class="btn peq ok" data-zap="${i}">Abrir no WhatsApp</button>` : ""}</div></div>`;
    }).join("") : `<div class="vazio">Nenhuma mensagem nesta categoria.</div>`;
    $$("[data-copiar]", root).forEach((b) => b.addEventListener("click", async () => {
      const t = preencherMensagem(lista[+b.dataset.copiar].texto, c, perfil?.nome);
      toast((await copiar(t)) ? "Mensagem copiada" : "Não foi possível copiar", "ok");
    }));
    $$("[data-zap]", root).forEach((b) => b.addEventListener("click", () => {
      const m = lista[+b.dataset.zap];
      window.open(linkWhatsApp(c.telefone_norm, preencherMensagem(m.texto, c, perfil?.nome)), "_blank", "noopener");
      perguntarEnvio(m.titulo);
    }));
  };
  // o contato só entra no histórico (e na conversão) se a atendente confirmar que enviou
  function perguntarEnvio(titulo) {
    const box = $("#confirma-contato", root);
    box.innerHTML = `<div class="aviso info">${titulo ? `Você enviou a mensagem “${esc(titulo)}”?` : "Você enviou mensagem para o cliente?"} <div class="acoes" style="margin-top:.5rem;display:flex;gap:.5rem">
      <button class="btn peq ok" id="env-sim">Sim, registrar contato</button><button class="btn peq" id="env-nao">Não enviei</button></div></div>`;
    $("#env-nao", root).addEventListener("click", () => (box.innerHTML = ""));
    $("#env-sim", root).addEventListener("click", (e) =>
      executar(e.currentTarget, "Registrando…", () => rpc("seguro_registrar_contato", { p_id: c.id, p_canal: "whatsapp", p_texto: titulo ? `Mensagem enviada: ${titulo}` : "Conversa iniciada pelo WhatsApp" }), "Contato registrado"));
  }
  desenharMsgs();
  const zap = $("#d-zap", root);
  zap?.addEventListener("click", () => perguntarEnvio(null));
}

export function limparCacheMensagens() { mensagensCache = null; }
