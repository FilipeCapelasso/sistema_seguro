// Mensagens prontas e materiais de venda — editáveis pelo painel, sem mexer em código.
import { sb, rpc, msgErro, esc, copiar, CATEGORIAS_MSG, TIPOS_MATERIAL, tamanhoLegivel } from "./api.js";
import { $, $$, toast, modal, confirmar, ocupado } from "./ui.js";
import { limparCacheMensagens } from "./clientes.js";

const MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4",
  "video/webm": "webm", "video/quicktime": "mov", "application/pdf": "pdf",
};
const MAX_MATERIAL = 50 * 1024 * 1024;

export async function montarBiblioteca(el, ctx, qual) {
  return qual === "mensagens" ? montarMensagens(el) : montarMateriais(el);
}

// ===================== MENSAGENS =====================
async function montarMensagens(el) {
  let lista = await rpc("seguro_listar_mensagens");
  let filtro = "";
  const desenhar = () => {
    const vis = lista.filter((m) => !filtro || m.categoria === filtro);
    el.innerHTML = `
      <div class="card"><div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
        <h2 style="margin:0;flex:1">Mensagens prontas</h2><button class="btn pri" id="nova">+ Nova mensagem</button></div>
        <p class="mut peq">Use as variáveis <code>{primeiro_nome}</code> <code>{nome}</code> <code>{moto}</code> <code>{valor}</code> <code>{seguradora}</code> <code>{atendente}</code>; elas são preenchidas com os dados do cliente. O envio é sempre manual: nada é disparado automaticamente.</p>
        <div class="chips"><button class="chip" data-c="" aria-pressed="${!filtro}">Todas</button>${Object.entries(CATEGORIAS_MSG).map(([k, v]) => `<button class="chip" data-c="${k}" aria-pressed="${filtro === k}">${esc(v)}</button>`).join("")}</div>
      </div>
      <div class="msgs" style="margin-top:1rem">${vis.length ? vis.map((m) => `<div class="msg"><div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"><strong style="flex:1">${esc(m.titulo)}</strong>
        <span class="tag">${esc(CATEGORIAS_MSG[m.categoria])}</span>${m.ativo ? "" : `<span class="tag s-no">Inativa</span>`}</div><pre>${esc(m.texto)}</pre>
        <div class="acoes"><button class="btn peq" data-copiar="${m.id}">Copiar</button><button class="btn peq" data-editar="${m.id}">Editar</button><button class="btn peq perigo" data-excluir="${m.id}">Excluir</button></div></div>`).join("")
        : `<div class="card vazio">Nenhuma mensagem nesta categoria.</div>`}</div>`;
    $$("[data-c]", el).forEach((b) => b.addEventListener("click", () => { filtro = b.dataset.c; desenhar(); }));
    $("#nova", el).addEventListener("click", () => editar(null));
    $$("[data-copiar]", el).forEach((b) => b.addEventListener("click", async () => toast((await copiar(lista.find((m) => m.id === b.dataset.copiar).texto)) ? "Copiada" : "Não foi possível copiar")));
    $$("[data-editar]", el).forEach((b) => b.addEventListener("click", () => editar(lista.find((m) => m.id === b.dataset.editar))));
    $$("[data-excluir]", el).forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmar("Excluir mensagem?", "Essa mensagem deixará de aparecer para a equipe.", "Excluir", true))) return;
      try { await rpc("seguro_excluir_mensagem", { p_id: b.dataset.excluir }); await recarregar(); toast("Mensagem excluída", "ok"); } catch (e) { toast(msgErro(e), "erro"); }
    }));
  };
  const recarregar = async () => { lista = await rpc("seguro_listar_mensagens"); limparCacheMensagens(); desenhar(); };
  async function editar(m) {
    const r = await modal({
      titulo: m ? "Editar mensagem" : "Nova mensagem",
      corpo: `<label class="campo"><span>Título</span><input type="text" id="m-t" maxlength="80" value="${esc(m?.titulo ?? "")}"></label>
        <label class="campo"><span>Categoria</span><select id="m-c">${Object.entries(CATEGORIAS_MSG).map(([k, v]) => `<option value="${k}" ${m?.categoria === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="campo"><span>Texto</span><textarea id="m-x" maxlength="1500" rows="6">${esc(m?.texto ?? "")}</textarea></label>
        <label class="campo"><input type="checkbox" id="m-a" ${m?.ativo === false ? "" : "checked"}> Ativa</label><div id="m-e" class="aviso erro oculto"></div>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Salvar", c: "pri", v: (md) => {
        const t = $("#m-t", md).value.trim(), x = $("#m-x", md).value.trim();
        if (t.length < 2 || x.length < 5) { const e = $("#m-e", md); e.textContent = "Preencha título e texto."; e.classList.remove("oculto"); return undefined; }
        return { id: m?.id ?? null, titulo: t, categoria: $("#m-c", md).value, texto: x, ativo: $("#m-a", md).checked, ordem: m?.ordem ?? 100 };
      } }],
    });
    if (!r) return;
    try { await rpc("seguro_salvar_mensagem", { p: r }); await recarregar(); toast("Mensagem salva", "ok"); } catch (e) { toast(msgErro(e), "erro"); }
  }
  desenhar();
}

// ===================== MATERIAIS =====================
async function montarMateriais(el) {
  let lista = await rpc("seguro_listar_materiais");
  let filtro = "";
  const urls = new Map();
  const urlArquivo = async (path) => {
    if (urls.has(path)) return urls.get(path);
    const { data, error } = await sb.storage.from("seguros-materiais").createSignedUrl(path, 3600);
    if (error) return null;
    urls.set(path, data.signedUrl); return data.signedUrl;
  };
  const desenhar = async () => {
    const vis = lista.filter((m) => !filtro || m.tipo === filtro);
    el.innerHTML = `
      <div class="card"><div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap"><h2 style="margin:0;flex:1">Materiais de venda</h2><button class="btn pri" id="novo">+ Adicionar material</button></div>
        <p class="mut peq">Vídeos, imagens, frases, argumentos e coberturas para usar na conversa. Tudo guardado com segurança; só a equipe de recuperação vê.</p>
        <div class="chips"><button class="chip" data-t="" aria-pressed="${!filtro}">Todos</button>${Object.entries(TIPOS_MATERIAL).map(([k, v]) => `<button class="chip" data-t="${k}" aria-pressed="${filtro === k}">${esc(v)}</button>`).join("")}</div></div>
      <div class="grade-mat" style="margin-top:1rem" id="grade">${vis.length ? "" : `<div class="card vazio" style="grid-column:1/-1">Nada por aqui ainda.</div>`}</div>`;
    $$("[data-t]", el).forEach((b) => b.addEventListener("click", () => { filtro = b.dataset.t; desenhar(); }));
    $("#novo", el).addEventListener("click", () => editar(null));
    const grade = $("#grade", el);
    for (const m of vis) {
      const card = document.createElement("div");
      card.className = "card mat";
      card.innerHTML = `<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap"><strong style="flex:1">${esc(m.titulo)}</strong><span class="tag">${esc(TIPOS_MATERIAL[m.tipo])}</span>${m.ativo ? "" : `<span class="tag s-no">Inativo</span>`}</div>
        ${m.descricao ? `<div class="mut peq">${esc(m.descricao)}</div>` : ""}<div class="prev"></div>
        ${m.texto ? `<pre>${esc(m.texto)}</pre>` : ""}
        <div class="acoes" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:auto">
          ${m.texto ? `<button class="btn peq" data-cp>Copiar texto</button>` : ""}
          ${m.link_externo ? `<a class="btn peq" href="${esc(m.link_externo)}" target="_blank" rel="noopener noreferrer">Abrir link</a>` : ""}
          <button class="btn peq" data-ed>Editar</button><button class="btn peq perigo" data-ex>Excluir</button></div>`;
      grade.appendChild(card);
      card.querySelector("[data-cp]")?.addEventListener("click", async () => toast((await copiar(m.texto)) ? "Texto copiado" : "Não foi possível copiar"));
      card.querySelector("[data-ed]").addEventListener("click", () => editar(m));
      card.querySelector("[data-ex]").addEventListener("click", () => excluir(m));
      if (m.arquivo_path) {
        const prev = card.querySelector(".prev");
        urlArquivo(m.arquivo_path).then((u) => {
          if (!u) { prev.innerHTML = `<span class="mut peq">Arquivo indisponível</span>`; return; }
          const t = m.arquivo_tipo ?? "";
          prev.innerHTML = t.startsWith("video/") ? `<video controls preload="metadata" playsinline src="${esc(u)}"></video>`
            : t.startsWith("image/") ? `<img alt="${esc(m.titulo)}" loading="lazy" src="${esc(u)}">`
            : `<a class="btn peq" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Abrir PDF (${esc(tamanhoLegivel(m.arquivo_tamanho ?? 0))})</a>`;
        });
      }
    }
  };
  const recarregar = async () => { lista = await rpc("seguro_listar_materiais"); urls.clear(); await desenhar(); };

  async function excluir(m) {
    if (!(await confirmar("Excluir material?", `“${m.titulo}” será removido${m.arquivo_path ? ", junto com o arquivo" : ""}.`, "Excluir", true))) return;
    try {
      const r = await rpc("seguro_excluir_material", { p_id: m.id });
      if (r?.arquivo_path) await sb.storage.from("seguros-materiais").remove([r.arquivo_path]);
      await recarregar(); toast("Material excluído", "ok");
    } catch (e) { toast(msgErro(e), "erro"); }
  }

  async function editar(m) {
    const r = await modal({
      titulo: m ? "Editar material" : "Adicionar material",
      corpo: `<label class="campo"><span>Tipo</span><select id="x-tipo">${Object.entries(TIPOS_MATERIAL).map(([k, v]) => `<option value="${k}" ${m?.tipo === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="campo"><span>Título</span><input type="text" id="x-tit" maxlength="120" value="${esc(m?.titulo ?? "")}"></label>
        <label class="campo"><span>Descrição (opcional)</span><input type="text" id="x-desc" maxlength="500" value="${esc(m?.descricao ?? "")}"></label>
        <label class="campo"><span>Texto (frase, argumento, cobertura)</span><textarea id="x-txt" maxlength="4000" rows="4">${esc(m?.texto ?? "")}</textarea></label>
        <label class="campo"><span>Arquivo (vídeo, imagem ou PDF, até 50 MB)${m?.arquivo_path ? " — enviar outro substitui o atual" : ""}</span><input type="file" id="x-arq" accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,application/pdf"></label>
        <label class="campo"><span>Link externo (https://…, opcional)</span><input type="text" id="x-link" maxlength="500" value="${esc(m?.link_externo ?? "")}"></label>
        <label class="campo"><input type="checkbox" id="x-ativo" ${m?.ativo === false ? "" : "checked"}> Ativo</label><div id="x-e" class="aviso erro oculto"></div>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Salvar", c: "pri", v: (md) => {
        const e = $("#x-e", md); const falha = (t) => { e.textContent = t; e.classList.remove("oculto"); return undefined; };
        const tit = $("#x-tit", md).value.trim(), txt = $("#x-txt", md).value.trim(), link = $("#x-link", md).value.trim(), arq = $("#x-arq", md).files[0] ?? null;
        if (tit.length < 2) return falha("Informe o título.");
        if (link && !/^https:\/\//i.test(link)) return falha("O link precisa começar com https://");
        if (arq && !MIME_EXT[arq.type]) return falha("Tipo de arquivo não permitido.");
        if (arq && arq.size > MAX_MATERIAL) return falha("Arquivo maior que 50 MB.");
        if (!txt && !link && !arq && !m?.arquivo_path) return falha("Informe um texto, um arquivo ou um link.");
        return { tipo: $("#x-tipo", md).value, titulo: tit, descricao: $("#x-desc", md).value.trim(), texto: txt, link, arq, ativo: $("#x-ativo", md).checked };
      } }],
    });
    if (!r) return;
    const prog = document.createElement("div"); prog.className = "toast"; prog.textContent = r.arq ? "Enviando arquivo…" : "Salvando…";
    (document.getElementById("toasts") ?? (() => { toast("."); return document.getElementById("toasts"); })()).appendChild(prog);
    let novoPath = null;
    try {
      let path = m?.arquivo_path ?? null;
      if (r.arq) {
        novoPath = `materiais/${crypto.randomUUID()}.${MIME_EXT[r.arq.type]}`;
        const up = await sb.storage.from("seguros-materiais").upload(novoPath, r.arq, { contentType: r.arq.type, upsert: false });
        if (up.error) throw up.error;
        path = novoPath;
      }
      await rpc("seguro_salvar_material", { p: { id: m?.id ?? null, tipo: r.tipo, titulo: r.titulo, descricao: r.descricao, texto: r.texto, arquivo_path: path, link_externo: r.link, ativo: r.ativo, ordem: m?.ordem ?? 100 } });
      if (r.arq && m?.arquivo_path) await sb.storage.from("seguros-materiais").remove([m.arquivo_path]);
      await recarregar(); toast("Material salvo", "ok");
    } catch (e) {
      if (novoPath) sb.storage.from("seguros-materiais").remove([novoPath]).catch(() => {});
      toast(e?.message && !e.erro ? "Não foi possível enviar o arquivo. Verifique tipo e tamanho." : msgErro(e), "erro");
    } finally { prog.remove(); }
  }
  await desenhar();
}
