#!/usr/bin/env python3
"""Servidor estático local para testes: aplica os mesmos cabeçalhos do vercel.json
(inclusive a CSP), para pegar problemas de segurança antes de publicar.
Uso: python3 scripts/servir-local.py [porta]"""
import http.server, json, os, sys

raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = json.load(open(os.path.join(raiz, "vercel.json")))
fixos = {h["key"]: h["value"] for r in cfg["headers"] if r["source"] == "/(.*)" for h in r["headers"]}

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=raiz, **k)
    def end_headers(self):
        for k, v in fixos.items(): self.send_header(k, v)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a): pass

porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
http.server.ThreadingHTTPServer(("127.0.0.1", porta), H).serve_forever()
