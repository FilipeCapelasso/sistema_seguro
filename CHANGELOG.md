# Changelog

## 1.2.0 — 2026-11-27
- Visual renovado (tema 2.0): topo, abas em pílulas, cartões e KPIs, botões, animações suaves, esqueleto de carregamento.
- Página pública: miniaturas, barra de progresso, botão de envio fixo no celular, fotos grandes reduzidas automaticamente antes do envio.
- Painel: filtros recolhidos no celular; consulta de novas cotações pausa com a aba em segundo plano.

## 1.1.0 — 2026-11-27
- Página pública sem login na raiz (`/`): várias cotações em fila, motivo "Deixou pra mais tarde" ou "Não quis fazer".
- Nova Edge Function `seg-upload-publico` + migration 07 (limite por IP, perfil técnico "Envio público").
- Login e painel movidos para o caminho administrativo não divulgado; `/envio/` e `/painel/` removidos.

## 1.0.0 — 2026-11-27
Primeira versão.
- Banco: schema isolado `seguros` (perfis, cotações, clientes, histórico, mensagens, materiais, auditoria), RLS, funções `seguro_*`,
  buckets privados, migrations 01–06.
- Edge Functions: `seg-upload`, `seg-arquivo`, `seg-admin`.
- Front-end: login/primeiro acesso, tela de envio das meninas (com leitura automática da cotação no navegador), painel do dono
  (dashboard, clientes, detalhe com original/zoom, WhatsApp manual, mensagens prontas, materiais de venda, relatórios) e administração.
- Não altera nenhum objeto dos sistemas Honda (`public`) ou maquiagem.
