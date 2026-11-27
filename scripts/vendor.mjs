// Copia as bibliotecas de terceiros (instaladas via npm) para assets/vendor,
// para o site funcionar 100% estático e sem depender de CDN externa.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const nm = "node_modules/";
const arquivos = [
  [nm + "@supabase/supabase-js/dist/umd/supabase.js", "assets/vendor/supabase.js"],
  [nm + "pdfjs-dist/build/pdf.min.mjs", "assets/vendor/pdfjs/pdf.min.mjs"],
  [nm + "pdfjs-dist/build/pdf.worker.min.mjs", "assets/vendor/pdfjs/pdf.worker.min.mjs"],
  [nm + "tesseract.js/dist/tesseract.min.js", "assets/vendor/tesseract/tesseract.min.js"],
  [nm + "tesseract.js/dist/worker.min.js", "assets/vendor/tesseract/worker.min.js"],
  [nm + "tesseract.js/node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "assets/vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js"],
  [nm + "tesseract.js/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "assets/vendor/tesseract/tesseract-core-simd-lstm.wasm.js"],
  [nm + "tesseract.js/node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "assets/vendor/tesseract/tesseract-core-lstm.wasm.js"],
  [nm + "@tesseract.js-data/por/4.0.0/por.traineddata.gz", "assets/vendor/tesseract/lang/por.traineddata.gz"],
];
for (const [de, para] of arquivos) {
  mkdirSync(dirname(para), { recursive: true });
  copyFileSync(de, para);
  console.log("ok", para);
}
