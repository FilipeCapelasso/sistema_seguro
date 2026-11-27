-- =====================================================================
-- Sistema de Recuperação de Seguros – Star Motos
-- Migration 01: schema isolado, tabelas, triggers, RLS
--
-- ISOLAMENTO: tudo vive no schema "seguros". Nada é criado/alterado nos
-- schemas "public" (projeto Honda) nem "maquiagem". O schema não é
-- exposto na Data API e anon/authenticated não têm acesso às tabelas
-- (somente SELECT sob RLS, para defesa em profundidade).
-- =====================================================================

create schema if not exists seguros;
comment on schema seguros is 'Sistema de Recuperação de Seguros (Star Motos). Independente de public (Honda) e maquiagem.';
revoke all on schema seguros from public, anon, authenticated;
-- USAGE é necessário só para as policies do Storage chamarem seguros.papel_ok(); não expõe tabelas.
grant usage on schema seguros to authenticated;

-- ---------------------------------------------------------------------
-- Funções utilitárias
-- ---------------------------------------------------------------------
create or replace function seguros.limpar(p text, p_max int)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g')), p_max), '')
$$;

create or replace function seguros.limpar_ml(p text, p_max int)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g')), p_max), '')
$$;

-- Telefone brasileiro normalizado: 55 + DDD + número (12 ou 13 dígitos)
create or replace function seguros.normalizar_telefone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  d := regexp_replace(d, '^0+', '');
  if length(d) in (10, 11) then return '55' || d; end if;
  if length(d) in (12, 13) and left(d, 2) = '55' then return d; end if;
  return null;
end $$;

create or replace function seguros.data_ou_nula(p text)
returns date language plpgsql stable set search_path = '' as $$
declare d date;
begin
  if p is null or btrim(p) = '' then return null; end if;
  begin d := btrim(p)::date; exception when others then return null; end;
  if d < date '2015-01-01' or d > current_date + 366 then return null; end if;
  return d;
end $$;

create or replace function seguros.numero_ou_nulo(p text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare n numeric;
begin
  if p is null or btrim(p) = '' then return null; end if;
  begin n := btrim(p)::numeric; exception when others then return null; end;
  if n <= 0 or n >= 10000000 then return null; end if;
  return round(n, 2);
end $$;

-- Sanitiza os dados sugeridos pelo OCR/leitura de PDF (nada é inventado:
-- só entra o que passa na validação).
create or replace function seguros.parse_dados(p jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_tel text; r jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  v_tel := seguros.limpar(p->>'telefone', 30);
  if seguros.normalizar_telefone(v_tel) is null then v_tel := null; end if;
  r := jsonb_strip_nulls(jsonb_build_object(
    'nome',         seguros.limpar(p->>'nome', 120),
    'telefone',     v_tel,
    'modelo_moto',  seguros.limpar(p->>'modelo_moto', 120),
    'data_entrega', seguros.data_ou_nula(p->>'data_entrega'),
    'valor_cotacao', seguros.numero_ou_nulo(p->>'valor_cotacao'),
    'seguradora',   seguros.limpar(p->>'seguradora', 80),
    'texto_bruto',  seguros.limpar_ml(p->>'texto_bruto', 6000)
  ));
  if r = '{}'::jsonb then return null; end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists seguros.perfis (
  id            uuid primary key references auth.users(id) on delete cascade,
  nome          text not null check (char_length(nome) between 2 and 80),
  papel         text not null check (papel in ('envio', 'recuperacao', 'admin')),
  ativo         boolean not null default true,
  criado_por    uuid references auth.users(id) on delete set null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table seguros.perfis is 'Perfis do sistema de seguros. Só quem tem linha aqui acessa o sistema.';

create table if not exists seguros.cotacoes (
  id               uuid primary key default gen_random_uuid(),
  enviado_por      uuid not null references seguros.perfis(id) on delete restrict,
  arquivo_path     text not null unique,
  arquivo_nome     text not null check (char_length(arquivo_nome) between 1 and 200),
  arquivo_tipo     text not null check (arquivo_tipo in ('image/jpeg', 'image/png', 'application/pdf')),
  arquivo_tamanho  integer not null check (arquivo_tamanho > 0 and arquivo_tamanho <= 10485760),
  arquivo_sha256   text not null check (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  motivo_recusa    text not null check (motivo_recusa in ('nao_quer','achou_caro','vai_pensar','vai_fazer_depois','ja_possui','outro')),
  observacao_envio text check (char_length(observacao_envio) <= 500),
  dados_extraidos  jsonb,
  extracao_origem  text check (extracao_origem in ('ocr_navegador', 'texto_pdf')),
  criado_em        timestamptz not null default now()
);
comment on table seguros.cotacoes is 'Cotação original enviada. Imutável: o arquivo e os dados de envio nunca mudam.';
create index if not exists cotacoes_enviado_por_idx on seguros.cotacoes (enviado_por, criado_em desc);
create index if not exists cotacoes_sha_idx on seguros.cotacoes (arquivo_sha256);

create table if not exists seguros.clientes (
  id                  uuid primary key default gen_random_uuid(),
  cotacao_id          uuid not null unique references seguros.cotacoes(id) on delete cascade,
  nome                text check (char_length(nome) <= 120),
  telefone            text check (char_length(telefone) <= 30),
  telefone_norm       text check (telefone_norm ~ '^55[0-9]{10,11}$'),
  modelo_moto         text check (char_length(modelo_moto) <= 120),
  data_entrega        date,
  valor_cotacao       numeric(12,2) check (valor_cotacao is null or (valor_cotacao > 0 and valor_cotacao < 10000000)),
  seguradora          text check (char_length(seguradora) <= 80),
  situacao            text not null default 'novo' check (situacao in (
                        'novo','aguardando_primeiro_contato','primeiro_contato_realizado',
                        'aguardando_resposta','em_negociacao','interessado',
                        'seguro_contratado','recusou_novamente','nao_foi_possivel_contato')),
  dados_conferidos    boolean not null default false,
  duplicado_de        uuid references seguros.clientes(id) on delete set null,
  visto_em            timestamptz,
  visto_por           uuid references seguros.perfis(id) on delete set null,
  primeiro_contato_em timestamptz,
  ultimo_contato_em   timestamptz,
  interesse_em        timestamptz,
  contratado_em       timestamptz,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now()
);
comment on table seguros.clientes is 'Oportunidade de recuperação (uma por cotação). Dados corrigíveis; a cotação original fica preservada em cotacoes.';
create index if not exists clientes_situacao_idx   on seguros.clientes (situacao);
create index if not exists clientes_criado_idx     on seguros.clientes (criado_em desc);
create index if not exists clientes_telefone_idx   on seguros.clientes (telefone_norm);

create table if not exists seguros.historico (
  id             bigint generated always as identity primary key,
  cliente_id     uuid not null references seguros.clientes(id) on delete cascade,
  tipo           text not null check (tipo in ('situacao','contato','observacao','dados','sistema')),
  situacao_de    text,
  situacao_para  text,
  canal          text check (canal in ('whatsapp','ligacao','presencial','outro')),
  texto          text check (char_length(texto) <= 2000),
  usuario_id     uuid references seguros.perfis(id) on delete set null,
  criado_em      timestamptz not null default now()
);
comment on table seguros.historico is 'Histórico cronológico e imutável de cada cliente.';
create index if not exists historico_cliente_idx on seguros.historico (cliente_id, criado_em desc);

create table if not exists seguros.mensagens_modelo (
  id          uuid primary key default gen_random_uuid(),
  categoria   text not null check (categoria in ('primeira_abordagem','achou_caro','vai_pensar','vai_fazer_depois','nao_quer','ja_possui','sem_resposta','interesse','coberturas')),
  titulo      text not null check (char_length(titulo) between 2 and 80),
  texto       text not null check (char_length(texto) between 5 and 1500),
  ativo       boolean not null default true,
  ordem       integer not null default 100,
  criado_em   timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists seguros.materiais (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('video','video_curto','imagem','frase','argumento','cobertura')),
  titulo          text not null check (char_length(titulo) between 2 and 120),
  descricao       text check (char_length(descricao) <= 500),
  texto           text check (char_length(texto) <= 4000),
  arquivo_path    text unique,
  arquivo_tipo    text,
  arquivo_tamanho bigint,
  link_externo    text check (link_externo is null or link_externo ~* '^https://'),
  ativo           boolean not null default true,
  ordem           integer not null default 100,
  criado_por      uuid references seguros.perfis(id) on delete set null,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  check (texto is not null or arquivo_path is not null or link_externo is not null)
);

create table if not exists seguros.auditoria (
  id           bigint generated always as identity primary key,
  usuario_id   uuid,
  usuario_nome text,
  acao         text not null,
  entidade     text,
  entidade_id  text,
  detalhes     jsonb,
  criado_em    timestamptz not null default now()
);
comment on table seguros.auditoria is 'Registro de quem enviou, visualizou ou alterou. Imutável.';
create index if not exists auditoria_criado_idx on seguros.auditoria (criado_em desc);
create index if not exists auditoria_usuario_idx on seguros.auditoria (usuario_id, criado_em desc);

create table if not exists seguros.config (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);
comment on table seguros.config is 'Configuração interna (ex.: hash do código de primeiro acesso). Sem acesso por nenhum papel de usuário.';

-- ---------------------------------------------------------------------
-- Papéis e auditoria (internas)
-- ---------------------------------------------------------------------
create or replace function seguros.papel()
returns text language sql stable security definer set search_path = '' as $$
  select p.papel from seguros.perfis p where p.id = (select auth.uid()) and p.ativo
$$;

create or replace function seguros.papel_ok(variadic p_papeis text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(seguros.papel() = any (p_papeis), false)
$$;

create or replace function seguros.exigir(variadic p_papeis text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text := seguros.papel();
begin
  if v is null or not (v = any (p_papeis)) then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function seguros.auditar(p_acao text, p_entidade text default null,
  p_entidade_id text default null, p_detalhes jsonb default null, p_uid uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := coalesce(p_uid, (select auth.uid())); v_nome text;
begin
  select nome into v_nome from seguros.perfis where id = v_uid;
  insert into seguros.auditoria (usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes)
  values (v_uid, v_nome, p_acao, p_entidade, p_entidade_id, p_detalhes);
end $$;

create or replace function seguros.calc_prioridade(p_situacao text, p_motivo text, p_criado timestamptz, p_ultimo timestamptz)
returns integer language sql stable set search_path = '' as $$
  select case
    when p_situacao in ('seguro_contratado', 'recusou_novamente') then 0
    when p_situacao in ('interessado', 'em_negociacao') then 3
    when p_situacao in ('primeiro_contato_realizado', 'aguardando_resposta') then
      case when coalesce(p_ultimo, p_criado) < now() - interval '3 days' then 3 else 1 end
    when p_situacao = 'nao_foi_possivel_contato' then 1
    else case when p_motivo in ('vai_pensar', 'vai_fazer_depois') then 3
              when p_motivo in ('achou_caro', 'outro') then 2
              else 1 end
  end
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
-- Registros imutáveis (histórico e auditoria). Exclusão só na rotina
-- administrativa de exclusão LGPD, que liga seguros.excluindo na transação.
create or replace function seguros.tg_imutavel()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('seguros.excluindo', true) = 'on' then
    return old;
  end if;
  raise exception 'registro_imutavel' using errcode = '42501';
end $$;

drop trigger if exists historico_imutavel on seguros.historico;
create trigger historico_imutavel before update or delete on seguros.historico
  for each row execute function seguros.tg_imutavel();

drop trigger if exists auditoria_imutavel on seguros.auditoria;
create trigger auditoria_imutavel before update or delete on seguros.auditoria
  for each row execute function seguros.tg_imutavel();

-- Cotação original preservada: só é permitido preencher dados_extraidos uma vez.
create or replace function seguros.tg_cotacao_preservar()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('seguros.excluindo', true) = 'on' then return old; end if;
    raise exception 'cotacao_original_preservada' using errcode = '42501';
  end if;
  if old.dados_extraidos is not null
     or (to_jsonb(new) - 'dados_extraidos' - 'extracao_origem') is distinct from (to_jsonb(old) - 'dados_extraidos' - 'extracao_origem') then
    raise exception 'cotacao_original_preservada' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists cotacoes_preservar on seguros.cotacoes;
create trigger cotacoes_preservar before update or delete on seguros.cotacoes
  for each row execute function seguros.tg_cotacao_preservar();

-- Cliente: normaliza telefone, detecta duplicado, carimbos de etapa
create or replace function seguros.tg_cliente_before()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.telefone_norm := seguros.normalizar_telefone(new.telefone);

  if tg_op = 'INSERT'
     or (to_jsonb(new) - 'visto_em' - 'visto_por' - 'atualizado_em') is distinct from (to_jsonb(old) - 'visto_em' - 'visto_por' - 'atualizado_em') then
    new.atualizado_em := now();
  end if;

  if tg_op = 'INSERT' or new.telefone_norm is distinct from old.telefone_norm then
    new.duplicado_de := null;
    if new.telefone_norm is not null then
      select c.id into new.duplicado_de
        from seguros.clientes c
       where c.telefone_norm = new.telefone_norm and c.id <> new.id and c.duplicado_de is null
       order by c.criado_em limit 1;
    end if;
  end if;

  if tg_op = 'INSERT' or new.situacao is distinct from old.situacao then
    if new.situacao not in ('novo', 'aguardando_primeiro_contato') and new.primeiro_contato_em is null then
      new.primeiro_contato_em := now();
    end if;
    if new.situacao in ('interessado', 'em_negociacao', 'seguro_contratado') and new.interesse_em is null then
      new.interesse_em := now();
    end if;
    if new.situacao = 'seguro_contratado' then
      new.contratado_em := coalesce(new.contratado_em, now());
    else
      new.contratado_em := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists clientes_before on seguros.clientes;
create trigger clientes_before before insert or update on seguros.clientes
  for each row execute function seguros.tg_cliente_before();

-- Histórico automático de mudança de situação e de correção de dados
create or replace function seguros.tg_cliente_historico()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_mud text;
begin
  if new.situacao is distinct from old.situacao then
    insert into seguros.historico (cliente_id, tipo, situacao_de, situacao_para, usuario_id)
    values (new.id, 'situacao', old.situacao, new.situacao, v_uid);
  end if;

  select string_agg(q.k || ': ' || coalesce(q.o, '(vazio)') || ' → ' || coalesce(q.n, '(vazio)'), '; ')
    into v_mud
    from (
      select 'nome' k, old.nome o, new.nome n where old.nome is distinct from new.nome
      union all select 'telefone', old.telefone, new.telefone where old.telefone is distinct from new.telefone
      union all select 'moto', old.modelo_moto, new.modelo_moto where old.modelo_moto is distinct from new.modelo_moto
      union all select 'data da entrega', old.data_entrega::text, new.data_entrega::text where old.data_entrega is distinct from new.data_entrega
      union all select 'valor', old.valor_cotacao::text, new.valor_cotacao::text where old.valor_cotacao is distinct from new.valor_cotacao
      union all select 'seguradora', old.seguradora, new.seguradora where old.seguradora is distinct from new.seguradora
    ) q;

  if v_mud is not null then
    insert into seguros.historico (cliente_id, tipo, texto, usuario_id)
    values (new.id, 'dados', left(v_mud, 1900), v_uid);
  end if;
  return null;
end $$;

drop trigger if exists clientes_historico on seguros.clientes;
create trigger clientes_historico after update on seguros.clientes
  for each row execute function seguros.tg_cliente_historico();

create or replace function seguros.tg_atualizado()
returns trigger language plpgsql set search_path = '' as $$
begin new.atualizado_em := now(); return new; end $$;

drop trigger if exists perfis_atualizado on seguros.perfis;
create trigger perfis_atualizado before update on seguros.perfis for each row execute function seguros.tg_atualizado();
drop trigger if exists mensagens_atualizado on seguros.mensagens_modelo;
create trigger mensagens_atualizado before update on seguros.mensagens_modelo for each row execute function seguros.tg_atualizado();
drop trigger if exists materiais_atualizado on seguros.materiais;
create trigger materiais_atualizado before update on seguros.materiais for each row execute function seguros.tg_atualizado();

-- ---------------------------------------------------------------------
-- RLS (defesa em profundidade: o acesso real é por funções com checagem de papel)
-- ---------------------------------------------------------------------
alter table seguros.perfis           enable row level security;
alter table seguros.cotacoes         enable row level security;
alter table seguros.clientes         enable row level security;
alter table seguros.historico        enable row level security;
alter table seguros.mensagens_modelo enable row level security;
alter table seguros.materiais        enable row level security;
alter table seguros.auditoria        enable row level security;
alter table seguros.config           enable row level security;

revoke all on all tables in schema seguros from public, anon, authenticated;
grant select on seguros.perfis, seguros.cotacoes, seguros.clientes, seguros.historico,
                seguros.mensagens_modelo, seguros.materiais, seguros.auditoria to authenticated;

drop policy if exists perfis_sel on seguros.perfis;
create policy perfis_sel on seguros.perfis for select to authenticated
  using (id = (select auth.uid()) or seguros.papel_ok('admin'));

drop policy if exists cotacoes_sel on seguros.cotacoes;
create policy cotacoes_sel on seguros.cotacoes for select to authenticated
  using ((enviado_por = (select auth.uid()) and seguros.papel_ok('envio', 'recuperacao', 'admin'))
         or seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists clientes_sel on seguros.clientes;
create policy clientes_sel on seguros.clientes for select to authenticated
  using (seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists historico_sel on seguros.historico;
create policy historico_sel on seguros.historico for select to authenticated
  using (seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists mensagens_sel on seguros.mensagens_modelo;
create policy mensagens_sel on seguros.mensagens_modelo for select to authenticated
  using (seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists materiais_sel on seguros.materiais;
create policy materiais_sel on seguros.materiais for select to authenticated
  using (seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists auditoria_sel on seguros.auditoria;
create policy auditoria_sel on seguros.auditoria for select to authenticated
  using (seguros.papel_ok('admin'));

-- Funções internas: ninguém de fora chama; só papel_ok/exigir ficam acessíveis ao Storage.
revoke all on function seguros.papel(), seguros.exigir(text[]), seguros.papel_ok(text[]),
  seguros.auditar(text, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function seguros.papel_ok(text[]) to authenticated;
