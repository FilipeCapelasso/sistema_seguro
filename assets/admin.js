// Administração: usuários e auditoria (somente administrador; reforçado no servidor).
import { rpc, fn, msgErro, esc, dataHora } from "./api.js";
import { $, $$, toast, modal, confirmar } from "./ui.js";

const PAPEIS = { envio: "Envio (meninas)", recuperacao: "Recuperação (dono)", admin: "Administrador" };
const ACOES = {
  enviou_cotacao: "Enviou cotação", visualizou_cliente: "Visualizou cliente", visualizou_arquivo: "Visualizou arquivo", baixou_arquivo: "Baixou arquivo",
  alterou_dados_cliente: "Alterou dados", alterou_situacao: "Alterou situação", registrou_contato: "Registrou contato", adicionou_observacao: "Adicionou observação",
  extraiu_dados: "Leitura automática", salvou_mensagem: "Salvou mensagem", excluiu_mensagem: "Excluiu mensagem", salvou_material: "Salvou material",
  excluiu_material: "Excluiu material", criou_usuario: "Criou usuário", alterou_usuario: "Alterou usuário", redefiniu_senha: "Redefiniu senha",
  excluiu_cliente: "Excluiu cliente (LGPD)", upload_rejeitado: "Upload rejeitado", primeiro_acesso: "Primeiro acesso",
};

export async function montarAdmin(el, ctx) {
  el.innerHTML = `<div class="chips"><button class="chip" id="t-usu" aria-pressed="true">Usuários</button><button class="chip" id="t-aud" aria-pressed="false">Auditoria</button></div><div id="adm"></div>`;
  const troca = (qual) => { $("#t-usu").setAttribute("aria-pressed", String(qual === "u")); $("#t-aud").setAttribute("aria-pressed", String(qual === "a")); (qual === "u" ? usuarios : auditoria)($("#adm"), ctx); };
  $("#t-usu").addEventListener("click", () => troca("u")); $("#t-aud").addEventListener("click", () => troca("a"));
  troca("u");
}

async function usuarios(el, ctx) {
  el.innerHTML = `<div class="carregando">Carregando…</div>`;
  const lista = await rpc("seguro_admin_listar_usuarios");
  el.innerHTML = `<div class="card"><div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap"><h2 style="margin:0;flex:1">Usuários</h2><button class="btn pri" id="novo">+ Novo usuário</button></div>
    <p class="mut peq">Meninas usam o perfil <strong>Envio</strong> (só enviam e veem o resultado das próprias cotações). O dono usa <strong>Recuperação</strong>. Contas de outros sistemas que usam o mesmo banco não têm acesso aqui.</p>
    <div class="tabela-wrap" style="border:0"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>
    ${lista.map((u) => `<tr><td><strong>${esc(u.nome)}</strong></td><td>${esc(u.email)}</td><td>${esc(PAPEIS[u.papel])}</td>
      <td><span class="tag ${u.ativo ? "s-ok" : "s-no"}">${u.ativo ? "Ativo" : "Desativado"}</span></td><td class="peq mut">${esc(u.ultimo_acesso ? dataHora(u.ultimo_acesso) : "nunca")}</td>
      <td class="nowrap"><button class="btn peq" data-ed="${u.id}">Editar</button> <button class="btn peq" data-sn="${u.id}">Nova senha</button>
      ${u.id === ctx.perfil.id ? "" : `<button class="btn peq ${u.ativo ? "perigo" : ""}" data-at="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>`}</td></tr>`).join("")}</tbody></table></div></div>`;
  const por = (id) => lista.find((u) => u.id === id);
  const executar = async (acao, extra, ok) => { try { await fn("seg-admin", { acao, ...extra }); toast(ok, "ok"); await usuarios(el, ctx); } catch (e) { toast(msgErro(e), "erro"); } };

  $("#novo", el).addEventListener("click", async () => {
    const r = await modal({ titulo: "Novo usuário", corpo: `
      <label class="campo"><span>Nome</span><input type="text" id="u-n" maxlength="80"></label>
      <label class="campo"><span>E-mail</span><input type="email" id="u-e" autocomplete="off"></label>
      <label class="campo"><span>Senha inicial (mín. 10 caracteres, letras e números)</span><input type="password" id="u-s" autocomplete="new-password"></label>
      <label class="campo"><span>Perfil</span><select id="u-p">${Object.entries(PAPEIS).map(([k, v]) => `<option value="${k}" ${k === "envio" ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <div id="u-er" class="aviso erro oculto"></div>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Criar", c: "pri", v: (m) => {
        const d = { nome: $("#u-n", m).value.trim(), email: $("#u-e", m).value.trim(), senha: $("#u-s", m).value, papel: $("#u-p", m).value };
        if (d.nome.length < 2 || !/^\S+@\S+\.\S+$/.test(d.email) || d.senha.length < 10) { const e = $("#u-er", m); e.textContent = "Confira nome, e-mail e senha (mín. 10 caracteres)."; e.classList.remove("oculto"); return undefined; }
        return d; } }] });
    if (r) executar("criar_usuario", r, "Usuário criado");
  });
  $$("[data-ed]", el).forEach((b) => b.addEventListener("click", async () => {
    const u = por(b.dataset.ed);
    const r = await modal({ titulo: "Editar usuário", corpo: `<label class="campo"><span>Nome</span><input type="text" id="e-n" maxlength="80" value="${esc(u.nome)}"></label>
      <label class="campo"><span>Perfil</span><select id="e-p" ${u.id === ctx.perfil.id ? "disabled" : ""}>${Object.entries(PAPEIS).map(([k, v]) => `<option value="${k}" ${k === u.papel ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Salvar", c: "pri", v: (m) => ({ nome: $("#e-n", m).value.trim(), papel: $("#e-p", m).value }) }] });
    if (r) executar("atualizar_usuario", { id: u.id, nome: r.nome, ...(u.id === ctx.perfil.id ? {} : { papel: r.papel }) }, "Usuário atualizado");
  }));
  $$("[data-sn]", el).forEach((b) => b.addEventListener("click", async () => {
    const u = por(b.dataset.sn);
    const s = await modal({ titulo: `Nova senha para ${u.nome}`, corpo: `<label class="campo"><span>Nova senha (mín. 10 caracteres)</span><input type="password" id="n-s" autocomplete="new-password"></label>`,
      botoes: [{ t: "Cancelar", v: null }, { t: "Redefinir", c: "pri", v: (m) => ($("#n-s", m).value.length >= 10 ? $("#n-s", m).value : undefined) }] });
    if (s) executar("redefinir_senha", { id: u.id, senha: s }, "Senha redefinida");
  }));
  $$("[data-at]", el).forEach((b) => b.addEventListener("click", async () => {
    const u = por(b.dataset.at);
    if (u.ativo && !(await confirmar("Desativar usuário?", `${u.nome} não conseguirá mais entrar.`, "Desativar", true))) return;
    executar("atualizar_usuario", { id: u.id, ativo: !u.ativo }, u.ativo ? "Usuário desativado" : "Usuário reativado");
  }));
}

async function auditoria(el) {
  const f = { acao: "", de: "", ate: "" }; let pag = 0; const N = 50;
  el.innerHTML = `<div class="card"><h2>Auditoria</h2><p class="mut peq">Quem enviou, visualizou ou alterou. Registro permanente, não editável.</p>
    <div class="filtros"><label><span>Ação</span><select id="a-ac"><option value="">Todas</option>${Object.entries(ACOES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
    <label><span>De</span><input type="date" id="a-de"></label><label><span>Até</span><input type="date" id="a-ate"></label></div></div><div id="a-res" style="margin-top:1rem"></div>`;
  const carregar = async () => {
    const alvo = $("#a-res", el);
    try {
      const r = await rpc("seguro_admin_auditoria", { p_filtros: Object.fromEntries(Object.entries(f).filter(([, v]) => v)), p_limite: N, p_offset: pag * N });
      alvo.innerHTML = r.itens.length ? `<div class="tabela-wrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>${r.itens.map((a) =>
        `<tr><td class="nowrap peq">${esc(dataHora(a.criado_em))}</td><td>${esc(a.usuario_nome ?? "—")}</td><td>${esc(ACOES[a.acao] ?? a.acao)}</td>
        <td class="peq mut">${esc(a.entidade ?? "")} ${a.detalhes ? esc(JSON.stringify(a.detalhes)) : ""}</td></tr>`).join("")}</tbody></table></div>
        <div class="pag"><span class="mut peq">${pag * N + 1}–${pag * N + r.itens.length} de ${r.total}</span><span><button class="btn peq" id="a-ant" ${pag === 0 ? "disabled" : ""}>Anterior</button> <button class="btn peq" id="a-prox" ${(pag + 1) * N >= r.total ? "disabled" : ""}>Próxima</button></span></div>`
        : `<div class="card vazio">Nenhum registro.</div>`;
      $("#a-ant", el)?.addEventListener("click", () => { pag--; carregar(); }); $("#a-prox", el)?.addEventListener("click", () => { pag++; carregar(); });
    } catch (e) { alvo.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; }
  };
  [["a-ac", "acao"], ["a-de", "de"], ["a-ate", "ate"]].forEach(([id, k]) => $("#" + id, el).addEventListener("change", (e) => { f[k] = e.target.value; pag = 0; carregar(); }));
  await carregar();
}
