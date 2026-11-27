// Seletor de período compartilhado (painel e relatórios). Datas no fuso de Rio Branco.
import { hojeISO } from "./api.js";
import { esc } from "./api.js";

const somarDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function periodoParaDatas(p) {
  const hoje = hojeISO();
  switch (p.tipo) {
    case "hoje": return { de: hoje, ate: hoje };
    case "7": return { de: somarDias(hoje, -6), ate: hoje };
    case "30": return { de: somarDias(hoje, -29), ate: hoje };
    case "mes": return { de: hoje.slice(0, 8) + "01", ate: hoje };
    case "custom": return { de: p.de || null, ate: p.ate || null };
    default: return { de: null, ate: null };
  }
}

export function seletorPeriodo(el, estado, aoMudar) {
  el.innerHTML = `<div class="linha" style="align-items:end">
    <label class="campo" style="margin:0"><span>Período (data de recebimento)</span>
      <select id="per-tipo"><option value="tudo">Todo o período</option><option value="hoje">Hoje</option><option value="7">Últimos 7 dias</option>
      <option value="30">Últimos 30 dias</option><option value="mes">Este mês</option><option value="custom">Escolher datas…</option></select></label>
    <label class="campo oculto" style="margin:0" id="w-de"><span>De</span><input type="date" id="per-de"></label>
    <label class="campo oculto" style="margin:0" id="w-ate"><span>Até</span><input type="date" id="per-ate"></label></div>`;
  const tipo = el.querySelector("#per-tipo");
  tipo.value = estado.tipo;
  const mostrar = () => ["#w-de", "#w-ate"].forEach((s) => el.querySelector(s).classList.toggle("oculto", tipo.value !== "custom"));
  mostrar();
  tipo.addEventListener("change", () => { estado.tipo = tipo.value; mostrar(); if (tipo.value !== "custom") aoMudar(); });
  el.querySelector("#per-de").addEventListener("change", (e) => { estado.de = e.target.value; aoMudar(); });
  el.querySelector("#per-ate").addEventListener("change", (e) => { estado.ate = e.target.value; aoMudar(); });
}
