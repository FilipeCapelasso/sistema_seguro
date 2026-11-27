// Utilitários de interface (sem dependências).
import { esc } from "./api.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function toast(msg, tipo = "") {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
  const t = document.createElement("div");
  t.className = "toast " + tipo;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), tipo === "erro" ? 6500 : 3500);
}

// Modal simples. Retorna promessa com o valor do botão (ou null se cancelou).
export function modal({ titulo, corpo = "", botoes = [{ t: "OK", v: true, c: "pri" }], aoMontar }) {
  return new Promise((ok) => {
    const fundo = document.createElement("div");
    fundo.className = "modal-fundo";
    fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
      <h2>${esc(titulo)}</h2><div class="corpo">${corpo}</div>
      <div class="acoes">${botoes.map((b, i) => `<button type="button" class="btn ${b.c ?? ""}" data-i="${i}">${esc(b.t)}</button>`).join("")}</div></div>`;
    const anterior = document.activeElement;
    const fechar = (v) => { fundo.remove(); document.removeEventListener("keydown", tecla); anterior?.focus?.(); ok(v); };
    const tecla = (e) => { if (e.key === "Escape") fechar(null); };
    document.addEventListener("keydown", tecla);
    fundo.addEventListener("click", (e) => { if (e.target === fundo) fechar(null); });
    $$("button[data-i]", fundo).forEach((b) => b.addEventListener("click", () => {
      const def = botoes[+b.dataset.i];
      const v = typeof def.v === "function" ? def.v(fundo) : def.v;
      if (v === undefined) return; // validação reprovou: mantém aberto
      fechar(v);
    }));
    document.body.appendChild(fundo);
    aoMontar?.(fundo);
    ($("input,textarea,select", fundo) ?? $("button.pri", fundo) ?? $("button", fundo))?.focus();
  });
}

export const confirmar = (titulo, texto, rotulo = "Confirmar", perigo = false) =>
  modal({ titulo, corpo: `<p>${esc(texto)}</p>`, botoes: [{ t: "Cancelar", v: false }, { t: rotulo, v: true, c: perigo ? "perigo" : "pri" }] }).then((v) => v === true);

export function ocupado(btn, on, textoOcupado = "Aguarde…") {
  if (!btn) return;
  if (on) { btn.dataset.t = btn.textContent; btn.textContent = textoOcupado; btn.disabled = true; }
  else { btn.textContent = btn.dataset.t ?? btn.textContent; btn.disabled = false; }
}

export const debounce = (f, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
