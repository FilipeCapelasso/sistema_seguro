// Leitura automática da cotação, 100% no navegador (a imagem não sai do aparelho para
// nenhum serviço de terceiros). PDF com texto → lê o texto; imagem/PDF escaneado → OCR.
// Nunca bloqueia o envio: se falhar, devolve null e a atendente completa os dados depois.
import { extrairDados } from "./parse.js";

const BASE = new URL("./vendor/", import.meta.url).href;
let promessaTesseract = null;

function carregarScript(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => erro(new Error("falha ao carregar " + src));
    document.head.appendChild(s);
  });
}

async function tesseract() {
  if (!promessaTesseract) {
    promessaTesseract = (async () => {
      if (!window.Tesseract) await carregarScript(BASE + "tesseract/tesseract.min.js");
      return window.Tesseract;
    })();
    promessaTesseract.catch(() => { promessaTesseract = null; });
  }
  return promessaTesseract;
}

async function ocrCanvas(canvas, aoProgredir) {
  const T = await tesseract();
  const worker = await T.createWorker("por", 1, {
    workerPath: BASE + "tesseract/worker.min.js",
    corePath: BASE + "tesseract",
    langPath: BASE + "tesseract/lang",
    workerBlobURL: false,
    gzip: true,
    logger: (m) => {
      if (m.status === "recognizing text" && aoProgredir) aoProgredir(Math.round(m.progress * 100));
    },
  });
  try {
    const { data } = await worker.recognize(canvas);
    return data.text ?? "";
  } finally {
    worker.terminate().catch(() => {});
  }
}

async function imagemParaCanvas(file, maxLado = 2200) {
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * escala));
  c.height = Math.max(1, Math.round(bmp.height * escala));
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

async function carregarPdfJs() {
  const pdfjs = await import(BASE + "pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = BASE + "pdfjs/pdf.worker.min.mjs";
  return pdfjs;
}

async function textoDoPdf(pdf, paginas = 2) {
  let out = "";
  for (let i = 1; i <= Math.min(pdf.numPages, paginas); i++) {
    const pg = await pdf.getPage(i);
    const tc = await pg.getTextContent();
    let linha = "";
    for (const it of tc.items) {
      linha += it.str;
      if (it.hasEOL) { out += linha + "\n"; linha = ""; } else linha += " ";
    }
    out += linha + "\n";
  }
  return out;
}

async function canvasDaPrimeiraPagina(pdf) {
  const pg = await pdf.getPage(1);
  const base = pg.getViewport({ scale: 1 });
  const escala = Math.min(3, 2200 / Math.max(base.width, base.height));
  const vp = pg.getViewport({ scale: escala });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await pg.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "#ffffff" }).promise;
  return c;
}

const limite = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tempo esgotado")), ms))]);

/**
 * @returns {Promise<{dados: object|null, origem: 'ocr_navegador'|'texto_pdf'|null}>}
 */
export async function lerCotacao(file, aoProgredir = () => {}) {
  try {
    return await limite(lerInterno(file, aoProgredir), 60_000);
  } catch (e) {
    console.warn("Leitura automática não concluída:", e?.message ?? e);
    return { dados: null, origem: null };
  }
}

async function lerInterno(file, aoProgredir) {
  if (file.type === "application/pdf") {
    const pdfjs = await carregarPdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const texto = await textoDoPdf(pdf);
    if (texto.replace(/\s/g, "").length >= 60) {
      const dados = extrairDados(texto);
      if (dados) return { dados, origem: "texto_pdf" };
    }
    const canvas = await canvasDaPrimeiraPagina(pdf);
    const dados = extrairDados(await ocrCanvas(canvas, aoProgredir));
    return { dados, origem: dados ? "ocr_navegador" : null };
  }
  const canvas = await imagemParaCanvas(file);
  const dados = extrairDados(await ocrCanvas(canvas, aoProgredir));
  return { dados, origem: dados ? "ocr_navegador" : null };
}
