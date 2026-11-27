// Relatórios: funil, evolução mensal e motivos de recusa. Números direto do banco.
import { rpc, esc, MOTIVOS, SITUACOES, msgErro } from "./api.js";
import { $, toast } from "./ui.js";
import { seletorPeriodo, periodoParaDatas } from "./periodo.js";

const nomeMes = (ym) => { const [a, m] = ym.split("-"); return new Date(+a, +m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }).replace(".", ""); };
const pct = (a, b) => (b ? (100 * a / b).toFixed(1).replace(".", ",") + "%" : "—");

export async function montarRelatorios(el) {
  const per = { tipo: "tudo" };
  el.innerHTML = `<div class="card"><div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:end"><div id="per" style="flex:1 1 320px"></div><button class="btn" id="imp">Imprimir</button></div></div><div id="rel" style="margin-top:1rem" class="carregando">Carregando…</div>`;
  $("#imp").addEventListener("click", () => window.print());
  const carregar = async () => {
    const { de, ate } = periodoParaDatas(per);
    const r = await rpc("seguro_relatorio", { p_de: de, p_ate: ate });
    const t = r.totais;
    const maxMes = Math.max(1, ...r.mensal.map((m) => m.recebidas));
    const maxMot = Math.max(1, ...r.motivos.map((m) => m.total));
    $("#rel").className = "";
    $("#rel").innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="n">${t.recebidos}</div><div class="t">Cotações recebidas</div></div>
        <div class="kpi"><div class="n">${t.contatados}</div><div class="t">Clientes contatados</div></div>
        <div class="kpi"><div class="n">${t.ja_interessados}</div><div class="t">Demonstraram interesse</div></div>
        <div class="kpi"><div class="n">${t.contratados}</div><div class="t">Seguros contratados</div></div>
        <div class="kpi"><div class="n">${t.recusaram_novamente}</div><div class="t">Recusaram novamente</div></div>
        <div class="kpi dest"><div class="n">${t.taxa_conversao == null ? "—" : String(t.taxa_conversao).replace(".", ",") + "%"}</div><div class="t">Taxa de conversão</div></div>
      </div>
      <p class="mut peq" style="margin:.6rem 0 0">Conversão = seguros contratados ÷ clientes contatados. Interesse não conta como venda; só entra como contratado quando a situação é “Seguro contratado”. O período considera a data em que a cotação foi recebida.</p>

      <div class="card" style="margin-top:1rem"><h2>Evolução mensal</h2>
        ${r.mensal.length ? `<div class="evo">${r.mensal.map((m) => `<div class="col" title="${esc(nomeMes(m.mes))}: ${m.recebidas} recebidas, ${m.contratados} contratados">
          <div class="par"><i class="rec" style="height:${Math.max(2, 100 * m.recebidas / maxMes)}%"></i><i class="con" style="height:${Math.max(2, 100 * m.contratados / maxMes)}%"></i></div>
          <span>${esc(nomeMes(m.mes))}</span><span style="color:var(--tx);font-weight:700">${m.recebidas}/${m.contratados}</span></div>`).join("")}</div>
          <div class="leg"><span><i class="rec" style="background:#9aa6b5"></i>Recebidas</span><span><i style="background:var(--ok)"></i>Contratadas</span></div>` : `<div class="vazio">Sem dados no período.</div>`}</div>

      <div class="grade2" style="margin-top:1rem;gap:1rem">
        <div class="card" style="margin:0"><h2>Motivos de recusa</h2>
          ${r.motivos.length ? `<div class="barras">${r.motivos.map((m) => `<div class="b"><span>${esc(MOTIVOS[m.motivo] ?? m.motivo)}</span><div class="tr"><i style="width:${100 * m.total / maxMot}%"></i></div><span class="dir">${m.total}</span></div>`).join("")}</div>
          <p class="mut peq" style="margin:.6rem 0 0">Contratados por motivo: ${r.motivos.map((m) => `${esc(MOTIVOS[m.motivo] ?? m.motivo)} ${m.contratados}`).join(" · ")}</p>` : `<div class="vazio">Sem dados no período.</div>`}</div>
        <div class="card" style="margin:0"><h2>Situação atual dos clientes</h2>
          ${r.situacoes.length ? `<table><tbody>${r.situacoes.map((s) => `<tr><td>${esc(SITUACOES[s.situacao] ?? s.situacao)}</td><td class="dir"><strong>${s.total}</strong></td><td class="dir mut peq">${pct(s.total, t.recebidos)}</td></tr>`).join("")}</tbody></table>` : `<div class="vazio">Sem dados no período.</div>`}</div>
      </div>`;
  };
  seletorPeriodo($("#per"), per, () => carregar().catch((e) => toast(msgErro(e), "erro")));
  await carregar();
}
