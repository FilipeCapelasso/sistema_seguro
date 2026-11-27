# Changelog

## 1.0.0 — 2026-11-27
Primeira versão.
- Banco: schema isolado `seguros` (perfis, cotações, clientes, histórico, mensagens, materiais, auditoria), RLS, funções `seguro_*`,
  buckets privados, migrations 01–06.
- Edge Functions: `seg-upload`, `seg-arquivo`, `seg-admin`.
- Front-end: login/primeiro acesso, tela de envio das meninas (com leitura automática da cotação no navegador), painel do dono
  (dashboard, clientes, detalhe com original/zoom, WhatsApp manual, mensagens prontas, materiais de venda, relatórios) e administração.
- Não altera nenhum objeto dos sistemas Honda (`public`) ou maquiagem.
