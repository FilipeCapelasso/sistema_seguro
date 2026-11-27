// Painel de recuperação: casca (abas, notificações) + painel inicial.
import { sessao, sair, rpc, msgErro, esc, raiz, hojeISO, SITUACOES } from "./api.js";
import { $, toast } from "./ui.js";
import { montarClientes, abrirCliente } from "./clientes.js";
import { montarBiblioteca } from "./biblioteca.js";
import { montarRelatorios } from "./relatorios.js";
import { montarAdmin } from "./admin.js";
import { seletorPeriodo, periodoParaDatas } from "./periodo.js";

const ctx = { perfil: null, novas: null, aba: "painel", filtroInicial: null };

const ABAS = [
  { id: "painel", t: "Painel" },
  { id: "clientes", t: "Clientes" },
  { id: "mensagens", t: "Mensagens prontas" },
  { id: "materiais", t: "Materiais de venda" },
  { id: "relatorios", t: "Relatórios" },
  { id: "admin", t: "Administração", so: "admin" },
];

function desenharAbas() {
  const abas = ABAS.filter((a) => !a.so || a.so === ctx.perfil.papel);
  $("#abas").innerHTML = abas.map((a) =>
    `<button class="aba" role="tab" id="aba-${a.id}" data-aba="${a.id}" aria-selected="${a.id === ctx.aba}">${esc(a.t)}${a.id === "clientes" ? `<span class="badge oculto" id="badge-novas"></span>` : ""}</button>`).join("");
  $("#abas").querySelectorAll(".aba").forEach((b) => b.addEventListener("click", () => irPara(b.dataset.aba)));
  atualizarBadge();
}

export function irPara(aba, filtro = null) {
  ctx.aba = aba; ctx.filtroInicial = filtro;
  $("#abas").querySelectorAll(".aba").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aba === aba)));
  const el = $("#conteudo");
  el.innerHTML = `<div class="carregando">Carregando…</div>`;
  const h = { painel: montarPainel, clientes: montarClientes, mensagens: (e, c) => montarBiblioteca(e, c, "mensagens"),
    materiais: (e, c) => montarBiblioteca(e, c, "materiais"), relatorios: montarRelatorios, admin: montarAdmin }[aba];
  Promise.resolve(h(el, ctx)).catch((e) => { el.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; });
  history.replaceState(null, "", "#" + aba);
}
ctx.irPara = irPara;
ctx.abrirCliente = abrirCliente;

function atualizarBadge() {
  const b = $("#badge-novas");
  if (b) { b.textContent = ctx.novas ?? 0; b.classList.toggle("oculto", !ctx.novas); }
  document.title = (ctx.novas ? `(${ctx.novas}) ` : "") + "Recuperação de Seguros — Painel";
}

// Notificação de nova cotação: consulta leve a cada 30 s (sem alterar nada no banco compartilhado).
async function vigiar() {
  if (document.hidden) return; // aba em segundo plano: não consulta
  try {
    const d = await rpc("seguro_dashboard");
    if (ctx.novas != null && d.recebidos > (ctx.ultimoTotal ?? d.recebidos)) {
      toast(`Nova cotação recebida (${d.novas} para ver)`, "ok");
      if (ctx.aba === "painel") irPara("painel"); else if (ctx.aba === "clientes") ctx.recarregarClientes?.();
    }
    ctx.novas = d.novas; ctx.ultimoTotal = d.recebidos;
    atualizarBadge();
  } catch (e) { if (e.erro === "nao_autenticado") location.replace(raiz()); }
}

// ---------- painel inicial ----------
async function montarPainel(el) {
  const per = { tipo: "tudo" };
  el.innerHTML = `<div class="linha" style="align-items:end;margin-bottom:1rem"><div id="per" style="flex:3 1 300px"></div></div><div id="kpis" class="carregando">Carregando…</div><div id="prio"></div>`;
  const carregar = async () => {
    const { de, ate } = periodoParaDatas(per);
    const [d, lista] = await Promise.all([
      rpc("seguro_dashboard", { p_de: de, p_ate: ate }),
      rpc("seguro_listar_clientes", { p_filtros: { ordem: "prioridade", ...(de ? { de } : {}), ...(ate ? { ate } : {}) }, p_limite: 8, p_offset: 0 }),
    ]);
    ctx.novas = d.novas; atualizarBadge();
    const k = (n, t, dest, f) => `<${f ? "button" : "div"} class="kpi ${dest ? "dest" : ""}" ${f ? `data-f='${esc(JSON.stringify(f))}' type="button"` : ""}><div class="n">${n}</div><div class="t">${esc(t)}</div></${f ? "button" : "div"}>`;
    $("#kpis").className = "";
    $("#kpis").innerHTML = `<div class="kpis">
      ${k(d.recebidos, "Cotações recebidas", false, {})}
      ${k(d.novas, "Novas (ainda não vistas)", d.novas > 0, { so_novos: true })}
      ${k(d.aguardando_contato, "Aguardando contato", false, { situacao: "aguardando_primeiro_contato" })}
      ${k(d.a_recontatar, "Recontatar (+3 dias sem retorno)", d.a_recontatar > 0, { situacao: "aguardando_resposta" })}
      ${k(d.em_negociacao, "Em negociação", false, { situacao: "em_negociacao" })}
      ${k(d.interessados, "Interessados", false, { situacao: "interessado" })}
      ${k(d.contratados, "Seguros contratados", false, { situacao: "seguro_contratado" })}
      ${k(d.recusaram_novamente, "Recusaram novamente", false, { situacao: "recusou_novamente" })}
      ${k(d.sem_contato, "Sem contato", false, { situacao: "nao_foi_possivel_contato" })}
      ${k(d.taxa_conversao == null ? "—" : String(d.taxa_conversao).replace(".", ",") + "%", "Conversão (contratos ÷ contatados)", true)}
    </div>
    ${d.dados_incompletos ? `<div class="aviso atencao" style="margin-top:1rem">${d.dados_incompletos} cotação(ões) com nome ou telefone faltando. <a href="#" id="ver-inc">Ver e completar</a></div>` : ""}`;
    $("#kpis").querySelectorAll("button.kpi").forEach((b) => b.addEventListener("click", () => irPara("clientes", JSON.parse(b.dataset.f))));
    $("#ver-inc")?.addEventListener("click", (e) => { e.preventDefault(); irPara("clientes", { so_incompletos: true }); });
    $("#prio").innerHTML = `<div class="card" style="margin-top:1rem"><h2>Prioridades</h2>
      ${lista.itens.length ? `<div class="tabela-wrap" style="border:0"><table><tbody>${lista.itens.map((c) =>
        `<tr class="clic ${c.visto ? "" : "novo"}" data-id="${c.id}"><td><strong>${esc(c.nome ?? "Sem nome")}</strong><div class="mut peq">${esc(c.modelo_moto ?? "Moto não identificada")}</div></td>
         <td class="peq">${esc(SITUACOES[c.situacao])}</td><td class="peq mut">${esc(c.telefone ?? "sem telefone")}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="vazio">Nenhuma cotação neste período.</div>`}</div>`;
    $("#prio").querySelectorAll("tr.clic").forEach((tr) => tr.addEventListener("click", () => abrirCliente(tr.dataset.id, ctx)));
  };
  seletorPeriodo($("#per"), per, () => carregar().catch((e) => toast(msgErro(e), "erro")));
  await carregar();
}

async function iniciar() {
  const s = await sessao().catch(() => null);
  if (!s || !s.perfil || s.perfil.papel === "envio") { location.replace(s?.perfil?.papel === "envio" ? "/" : raiz()); return; }
  ctx.perfil = s.perfil;
  $("#quem").textContent = `${s.perfil.nome} · ${s.perfil.papel === "admin" ? "Administrador" : "Recuperação"}`;
  $("#sair").addEventListener("click", sair);
  const h = location.hash.slice(1);
  ctx.aba = ABAS.some((a) => a.id === h && (!a.so || a.so === s.perfil.papel)) ? h : "painel";
  desenharAbas();
  $("#app").hidden = false;
  irPara(ctx.aba);
  setInterval(vigiar, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) vigiar(); });
}
iniciar();
