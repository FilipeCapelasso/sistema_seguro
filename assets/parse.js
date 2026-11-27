// Extração de dados de uma cotação a partir de texto (OCR ou texto do PDF).
// Regra de ouro: nunca inventar. Só devolve um campo quando há um rótulo ou um
// padrão inequívoco no texto; na dúvida, o campo fica vazio para a atendente
// completar. Funções puras (sem DOM) — testadas em tests/parse.test.mjs.

const SEGURADORAS = [
  "Porto Seguro", "Bradesco Seguros", "Allianz", "Tokio Marine", "HDI", "Liberty", "Mapfre",
  "Azul Seguros", "Sompo", "Suhai", "Youse", "Zurich", "Itaú Seguros", "Yelum", "Justos",
  "Mitsui", "Sul América", "SulAmérica", "Generali", "Alfa Seguradora", "Essor", "Pottencial",
  "Honda Seguros", "Kovr", "Ezze", "Tokio", "Bradesco", "Itaú",
];

const MOTOS = [
  "CG 125", "CG 150", "CG 160", "BIZ 100", "BIZ 110i", "BIZ 125", "POP 110i", "POP 100",
  "PCX 150", "PCX 160", "PCX", "ELITE 125", "LEAD 110", "XRE 190", "XRE 300", "XRE 300 SAHARA",
  "SAHARA 300", "NXR 150", "NXR 160", "BROS 160", "BROS 150", "CB 250F", "CB 300F", "CB 300R",
  "CB 500F", "CB 500X", "CB 650F", "CB 650R", "CB 1000R", "CBR 250R", "CBR 500R", "CBR 650R",
  "CBR 1000RR", "CBR 600RR", "TWISTER", "HORNET", "FAN 125", "FAN 150", "FAN 160", "TITAN 150",
  "TITAN 160", "START 160", "ADV 150", "ADV 350", "NC 750X", "AFRICA TWIN", "XL 750 TRANSALP",
  "TRANSALP", "SH 150", "SH 300", "FORZA 350", "FORZA 750", "GOLD WING", "CRF 230F", "CRF 250F",
  "CRF 450R", "CRF 1100L", "REBEL 500", "REBEL 1100", "NXR 125", "BIZ", "CG", "POP",
];

const sem = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const compactar = (s) => s.replace(/[ \t]+/g, " ").trim();
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function limparTexto(bruto) {
  return String(bruto ?? "")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- telefone ----------
const DDDS = new Set([
  11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,
  51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99,
]);

function telefoneValido(digitos) {
  let d = digitos;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (!DDDS.has(ddd)) return null;
  const num = d.slice(2);
  if (num.length === 11 && num[0] !== "9") return null; // celular tem 9 na frente
  if (/^(\d)\1+$/.test(num)) return null; // 999999999 etc.
  return d;
}

export function formatarTelefone(d) {
  if (!d) return "";
  const ddd = d.slice(0, 2), n = d.slice(2);
  return n.length === 9 ? `(${ddd}) ${n.slice(0, 5)}-${n.slice(5)}` : `(${ddd}) ${n.slice(0, 4)}-${n.slice(4)}`;
}

export function acharTelefone(texto) {
  const linhas = texto.split("\n");
  const rotulo = /(tel|fone|celular|whats|contato|cel\b)/i;
  const re = /(?<!\d)(?:\+?55[\s.-]?)?\(?\s*(\d{2})\s*\)?[\s.-]?(9?\s?\d{4})[\s.-]?(\d{4})(?!\d)/g;
  const achados = [];
  linhas.forEach((linha, i) => {
    const comRotulo = rotulo.test(linha) || (i > 0 && rotulo.test(linhas[i - 1]) && linha.length < 40);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(linha))) {
      const dig = (m[1] + m[2] + m[3]).replace(/\D/g, "");
      const v = telefoneValido(dig);
      if (v) achados.push({ v, comRotulo });
    }
  });
  const pref = achados.find((a) => a.comRotulo);
  // sem rótulo só aceitamos se houver UM único candidato (evita pegar CPF/apólice por engano)
  if (pref) return formatarTelefone(pref.v);
  const unicos = [...new Set(achados.map((a) => a.v))];
  return unicos.length === 1 ? formatarTelefone(unicos[0]) : null;
}

// ---------- valor ----------
export function paraNumero(txt) {
  const m = String(txt).match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(?!\d)/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, "") + "." + m[2]);
  return n > 0 && n < 10_000_000 ? n : null;
}

export function acharValor(texto) {
  const linhas = texto.split("\n");
  const fortes = /(pr[eê]mio\s*total|valor\s*total|total\s*(?:a\s*pagar|do\s*seguro|geral)?|pre[cç]o\s*(?:total|final)?|investimento)/i;
  const fracos = /(pr[eê]mio|valor|parcela|à vista|a vista)/i;
  const moeda = /R\s?\$\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/gi;
  const cand = [];
  linhas.forEach((l, i) => {
    const alvo = l + " " + (linhas[i + 1] ?? "");
    let m;
    moeda.lastIndex = 0;
    while ((m = moeda.exec(alvo))) {
      const n = paraNumero(m[1]);
      if (n == null) continue;
      const forca = fortes.test(l) ? 2 : fracos.test(l) ? 1 : 0;
      if (forca > 0 && !/parcela|x de|\d\s*x\b/i.test(l)) cand.push({ n, forca, i });
    }
  });
  if (!cand.length) return null;
  cand.sort((a, b) => b.forca - a.forca || a.i - b.i);
  return cand[0].n;
}

// ---------- seguradora ----------
export function acharSeguradora(texto) {
  const t = sem(texto).toLowerCase();
  for (const s of SEGURADORAS) {
    const alvo = sem(s).toLowerCase();
    if (new RegExp(`(^|[^a-z])${escapar(alvo)}([^a-z]|$)`).test(t)) return s;
  }
  return null;
}

// ---------- nome ----------
const PALAVRAS_NAO_NOME = /(seguro|seguradora|cotacao|cota[cç][aã]o|proposta|apolice|cobertura|franquia|valor|premio|total|moto|veiculo|placa|chassi|cpf|cnpj|telefone|email|e-mail|data|vigencia|corretor|loja|honda|star motos)/i;

function pareceNome(s) {
  const t = compactar(s);
  if (t.length < 5 || t.length > 80) return false;
  if (/\d/.test(t)) return false;
  if (!/^[A-Za-zÀ-ÿ' .-]+$/.test(t)) return false;
  const palavras = t.split(" ").filter(Boolean);
  if (palavras.length < 2 || palavras.length > 7) return false;
  if (PALAVRAS_NAO_NOME.test(sem(t))) return false;
  return true;
}

function titulo(s) {
  const peq = new Set(["da", "de", "do", "das", "dos", "e"]);
  return compactar(s).toLowerCase().split(" ")
    .map((p, i) => (i > 0 && peq.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(" ");
}

export function acharNome(texto) {
  const re = /^\s*(?:nome(?:\s*completo)?(?:\s*do\s*(?:segurado|cliente|proponente|condutor))?|segurado|proponente|cliente|condutor)\s*[:\-–]\s*(.+)$/i;
  for (const l of texto.split("\n")) {
    const m = l.match(re);
    if (m) {
      const cand = m[1].replace(/\b(cpf|cnpj|tel|fone|celular|e-?mail|nascimento)\b.*$/i, "").trim();
      if (pareceNome(cand)) return titulo(cand);
    }
  }
  return null;
}

// ---------- modelo da moto ----------
export function acharModelo(texto) {
  const t = sem(texto).toUpperCase();
  const lista = [...MOTOS].sort((a, b) => b.length - a.length);
  const rot = /^\s*(?:modelo|ve[ií]culo|moto|marca\s*\/\s*modelo|descri[cç][aã]o do ve[ií]culo)\s*[:\-–]\s*(.+)$/im;
  const m = texto.match(rot);
  if (m) {
    const v = compactar(m[1]).replace(/\b(placa|chassi|ano|cor)\b.*$/i, "").trim();
    if (v.length >= 2 && v.length <= 60 && /[A-Za-z]/.test(v) && !/R\s?\$/.test(v)) return v.toUpperCase().startsWith("HONDA") ? compactar(v) : compactar(v);
  }
  for (const nome of lista) {
    if (nome.length < 3) continue;
    const re = new RegExp(`(^|[^A-Z0-9])(?:HONDA\\s+)?${escapar(nome).replace(/ /g, "\\s*")}(?:\\s*(?:FLEX|ABS|CBS|STD|DLX|EX|ESP|SPORT|TWISTER|SAHARA))?([^A-Z0-9]|$)`);
    const mm = t.match(re);
    if (mm) {
      const ini = mm.index + mm[1].length;
      const trecho = texto.slice(ini, ini + mm[0].length - mm[1].length - mm[mm.length - 1].length);
      return compactar(trecho).toUpperCase();
    }
  }
  return null;
}

// ---------- data de entrega ----------
export function acharDataEntrega(texto, hoje = new Date()) {
  const linhas = texto.split("\n");
  const rot = /(entrega|retirada|data\s*da\s*compra|data\s*de\s*venda)/i;
  const re = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})(?!\d)/;
  for (let i = 0; i < linhas.length; i++) {
    if (!rot.test(linhas[i])) continue;
    const m = (linhas[i] + " " + (linhas[i + 1] ?? "")).match(re);
    if (!m) continue;
    let [_, d, mo, a] = m; d = +d; mo = +mo; a = +a; if (a < 100) a += 2000;
    const dt = new Date(Date.UTC(a, mo - 1, d));
    if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) continue;
    const lim = new Date(hoje.getTime() + 366 * 86400000);
    if (dt < new Date(Date.UTC(2015, 0, 1)) || dt > lim) continue;
    return `${a}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

// ---------- orquestração ----------
export function extrairDados(bruto) {
  const texto = limparTexto(bruto);
  if (texto.length < 15) return null;
  const r = {
    nome: acharNome(texto),
    telefone: acharTelefone(texto),
    modelo_moto: acharModelo(texto),
    data_entrega: acharDataEntrega(texto),
    valor_cotacao: acharValor(texto),
    seguradora: acharSeguradora(texto),
  };
  const out = {};
  for (const [k, v] of Object.entries(r)) if (v != null && v !== "") out[k] = v;
  if (!Object.keys(out).length) return null;
  out.texto_bruto = texto.slice(0, 6000);
  return out;
}
