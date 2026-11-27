# Sistema de Recuperação de Seguros — Star Motos

Sistema web independente para recuperar vendas de seguro de moto no setor de entrega.
As meninas anexam a cotação recusada, escolhem o motivo e enviam. O dono trabalha as oportunidades
em um painel (WhatsApp manual, mensagens prontas, materiais de venda, histórico e relatórios).

- **Front-end:** site estático (HTML + JS puro, sem build). Mobile primeiro.
- **Back-end:** Supabase (Auth, Postgres com RLS, Storage privado, Edge Functions).
- **Independente:** usa o mesmo projeto Supabase (`vendashonda`) do sistema Honda, mas **só** o
  schema `seguros`, funções `seguro_*`, buckets `seguros-*` e Edge Functions `seg-*`.
  Nada dos outros projetos (`public` do Honda, `maquiagem`) é lido ou alterado.

## Telas

| Caminho | Quem | O que faz |
|---|---|---|
| `/` | todos | Login e primeiro acesso do administrador |
| `/` | meninas (**sem login**) | Anexar várias cotações em fila → motivo por cotação ("Deixou pra mais tarde" / "Não quis fazer") → **ENVIAR** |
| `/admin/ISIF02KCXNKS002393McÇ@f/admin/` | dono / admin | Login e primeiro acesso (caminho não divulgado; só obscuridade, o login continua obrigatório) |
| `…/admin/painel/` | dono / admin | Painel, clientes, mensagens prontas, materiais de venda, relatórios |
| `…/admin/painel/#admin` | admin | Usuários e auditoria |

## Perfis

| Perfil | Pode |
|---|---|
| `envio` | Enviar cotações; ver o resultado (recebida / em andamento / fechou / sem sucesso) das **suas** cotações. Não vê dados de clientes. |
| `recuperacao` | Tudo do painel: clientes, original, WhatsApp, mensagens, materiais, relatórios. |
| `admin` | Tudo de `recuperacao` + usuários, auditoria e exclusão LGPD. |

Só entra quem tem perfil em `seguros.perfis`. Usuários do sistema Honda (que compartilham o login do
Supabase) **não** têm acesso aqui, a menos que o admin crie um perfil para eles.

## Primeiro acesso (uma vez)

1. Abra o site e clique em **Primeiro acesso do sistema**.
2. Informe o **código de primeiro acesso** (entregue na implantação), nome, e-mail e senha (mín. 10 caracteres).
3. O código é de uso único: depois do primeiro administrador criado ele deixa de funcionar.
4. No painel → **Administração**, crie as contas das meninas (perfil *Envio*) e do dono (*Recuperação*).

Para gerar um novo código (ex.: o código foi perdido e ainda não existe administrador):

```bash
CODIGO=$(python3 -c "import secrets;print(secrets.token_hex(6).upper())"); echo "$CODIGO"
printf %s "$CODIGO" | sha256sum   # copie o hash
```
```sql
insert into seguros.config(chave, valor) values ('bootstrap_hash', '<HASH>')
on conflict (chave) do update set valor = excluded.valor;
```
O código só vale enquanto não houver nenhum administrador ativo.

## Publicar o site

Qualquer hospedagem estática serve. Com a Vercel: importar o repositório, **Framework: Other**, sem comando de build,
diretório raiz. O `vercel.json` já aplica os cabeçalhos de segurança (CSP, HSTS, etc.).
Para testar localmente com os mesmos cabeçalhos: `python3 scripts/servir-local.py 8099`.

As bibliotecas (supabase-js, pdf.js, tesseract.js e o idioma português do OCR) ficam em `assets/vendor/`,
então o site não depende de CDN. Para atualizá-las: `npm install && npm run vendor`.

A chave pública (`anon`) e a URL do Supabase ficam em `assets/config.js`. **Nunca** coloque a `service_role` ali.

## Banco e funções

Migrations em `supabase/migrations/` (já aplicadas no projeto). Edge Functions em `supabase/functions/`:
`seg-upload` (valida e guarda a cotação), `seg-arquivo` (URL assinada de 60 s para ver/baixar o original),
`seg-admin` (usuários, primeiro acesso, exclusão LGPD).

## Testes

`npm test` roda os testes da extração de dados da cotação (`tests/parse.test.mjs`).

Mais detalhes: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) · [docs/SEGURANCA_LGPD.md](docs/SEGURANCA_LGPD.md) · [CHANGELOG.md](CHANGELOG.md)

## Envio público (sem login)
A página `/` chama a Edge Function `seg-upload-publico` (sem JWT). Defesas: só os motivos `nao_quer` e `vai_fazer_depois`, validação do
conteúdo real (JPG/PNG/PDF), ≤10 MB, bloqueio de PDF com conteúdo ativo, limite por IP (30/10 min) e global (300/10 min), campo isca anti-robô.
Os registros entram como o perfil técnico **"Envio público"** (criado automaticamente). Quem é dono do link pode enviar cotações: não
publique o endereço fora da loja.
