// Tela de entrada: login, primeiro acesso e redirecionamento por papel.
import { sb, fn, sessao, msgErro } from "./api.js";
import { $ } from "./ui.js";

const mostrar = (id) => ["carregando", "f-login", "f-primeiro", "sem-acesso"].forEach((x) => $("#" + x).classList.toggle("oculto", x !== id));
const erro = (el, m) => { el.textContent = m; el.classList.toggle("oculto", !m); };

async function destino(s) {
  if (!s) return false;
  if (!s.perfil) { mostrar("sem-acesso"); return true; }
  location.replace(s.perfil.papel === "envio" ? "envio/" : "painel/");
  return true;
}

async function iniciar() {
  try { if (await destino(await sessao())) return; } catch { /* segue para o login */ }
  let setup = false;
  try { setup = (await fn("seg-admin", { acao: "status" })).setup === true; } catch { /* ignora */ }
  mostrar("f-login");
  $("#l-primeiro-wrap").innerHTML = setup ? `<a href="#" id="l-primeiro">Primeiro acesso do sistema</a>` : "";
  $("#l-primeiro")?.addEventListener("click", (e) => { e.preventDefault(); mostrar("f-primeiro"); $("#p-codigo").focus(); });
}

$("#f-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? $("#f-login button[type=submit]");
  erro($("#l-erro"), "");
  const email = $("#l-email").value.trim(), senha = $("#l-senha").value;
  if (!email || !senha) return erro($("#l-erro"), "Informe e-mail e senha.");
  btn.disabled = true;
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    if (error) throw error;
    const s = await sessao();
    if (!(await destino(s))) throw new Error("sem sessão");
  } catch (err) {
    erro($("#l-erro"), msgErro(err));
    btn.disabled = false;
  }
});

$("#f-primeiro").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? $("#f-primeiro button[type=submit]");
  erro($("#p-erro"), "");
  const email = $("#p-email").value.trim(), senha = $("#p-senha").value;
  btn.disabled = true;
  try {
    await fn("seg-admin", { acao: "primeiro_acesso", codigo: $("#p-codigo").value, nome: $("#p-nome").value, email, senha });
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    if (error) throw error;
    await destino(await sessao());
  } catch (err) {
    erro($("#p-erro"), msgErro(err));
    btn.disabled = false;
  }
});

$("#p-voltar").addEventListener("click", (e) => { e.preventDefault(); mostrar("f-login"); });
$("#b-sair").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
iniciar();
