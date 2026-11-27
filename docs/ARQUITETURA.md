# Arquitetura

## Visão geral

```
Navegador (site estático)
  ├─ Auth (supabase-js) ──────────────► Supabase Auth
  ├─ RPC seguro_* (JWT do usuário) ───► Postgres: funções SECURITY DEFINER → schema "seguros"
  ├─ seg-upload (multipart) ──────────► Edge Function → valida arquivo → Storage privado + RPC
  ├─ seg-arquivo ─────────────────────► Edge Function → URL assinada 60 s (+ auditoria)
  └─ seg-admin ───────────────────────► Edge Function → usuários / primeiro acesso / LGPD
```

O navegador **nunca** acessa as tabelas diretamente: o schema `seguros` não está exposto na Data API e as
tabelas têm RLS (apenas SELECT, por defesa em profundidade). Toda escrita passa por funções `seguro_*`
que checam o papel no servidor (`seguros.exigir`). Esconder botão não é segurança; aqui o servidor decide.

## Banco (schema `seguros`)

| Tabela | Função |
|---|---|
| `perfis` | Quem tem acesso e com qual papel (`envio`, `recuperacao`, `admin`) |
| `cotacoes` | A cotação **original** (arquivo, motivo, hash). Imutável |
| `clientes` | A oportunidade de recuperação (dados corrigíveis, situação, datas de contato) |
| `historico` | Linha do tempo de cada cliente. Só acrescenta |
| `mensagens_modelo` | Biblioteca de mensagens prontas |
| `materiais` | Biblioteca de materiais de venda (vídeo, imagem, texto, link) |
| `auditoria` | Quem enviou/viu/alterou. Só acrescenta |
| `config` | Hash do código de primeiro acesso (ninguém lê, só `service_role`) |

Funções-ponte em `public` com prefixo `seguro_` (a Data API só expõe `public`): `search_path` vazio, checagem de papel,
`EXECUTE` só para `authenticated` (nunca `anon`); as `seguro_edge_*` só para `service_role`.

## Regras de negócio

- **Situações:** Novo cliente, Aguardando primeiro contato, Primeiro contato realizado, Aguardando resposta,
  Em negociação, Interessado, Seguro contratado, Recusou novamente, Não foi possível contato.
- **Contatado:** cliente com `primeiro_contato_em` preenchido (registrou contato ou avançou além de novo/aguardando).
- **Taxa de conversão:** seguros contratados ÷ clientes contatados. Interesse **não** é venda.
- **Período dos relatórios:** data de recebimento da cotação, fuso America/Rio_Branco.
- **Novas:** cotações ainda não abertas por ninguém do painel.
- **Prioridade (automática):** alta/média/baixa/encerrado conforme situação, motivo e tempo sem contato.
- **Duplicidade:** pelo telefone normalizado (`55` + DDD + número); o painel mostra "Repetido" e as outras cotações.
- **WhatsApp:** botão abre a conversa já com a mensagem personalizada; **não há envio automático**. O contato só entra no histórico
  (e na conversão) quando a atendente confirma que enviou.
- **Dados da cotação:** lidos no navegador (texto do PDF ou OCR) e conferidos no painel. Nada é inventado: sem rótulo
  ou padrão claro, o campo fica vazio para a atendente completar. A imagem não sai do aparelho para serviços de terceiros.
- **Original preservado:** o arquivo e os dados de envio não mudam; correções vão para `clientes`.

## Notificação de nova cotação

O painel consulta um resumo a cada 30 s (e ao voltar para a aba) e avisa com toast, contador na aba e no título.
Não usa Realtime, para não alterar a publicação do banco compartilhado.

## Estrutura de arquivos

```
index.html            página pública das meninas (sem login)
admin/<caminho secreto>/admin/   login e painel
painel/               painel do dono / admin
assets/               css, módulos JS (api, ui, parse, ocr, clientes, biblioteca, relatorios, admin) e vendor/
supabase/migrations/  schema, funções, storage, políticas
supabase/functions/   seg-upload, seg-arquivo, seg-admin
tests/                testes da extração de dados
vercel.json           cabeçalhos de segurança
```
