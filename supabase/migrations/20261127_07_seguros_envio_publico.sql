-- =====================================================================
-- Migration 07: envio público (sem login) para as meninas.
-- O navegador não ganha nenhum acesso novo ao banco: o envio passa pela
-- Edge Function seg-upload-publico (service_role), que valida o arquivo,
-- limita por IP e grava como o perfil técnico "Envio público".
-- =====================================================================
create table if not exists seguros.envios_publicos (
  id        bigint generated always as identity primary key,
  ip_hash   text not null,
  criado_em timestamptz not null default now()
);
create index if not exists envios_publicos_ip_idx on seguros.envios_publicos (ip_hash, criado_em desc);
create index if not exists envios_publicos_criado_idx on seguros.envios_publicos (criado_em);
alter table seguros.envios_publicos enable row level security;
drop policy if exists envios_publicos_ninguem on seguros.envios_publicos;
create policy envios_publicos_ninguem on seguros.envios_publicos for all to authenticated using (false) with check (false);
revoke all on seguros.envios_publicos from public, anon, authenticated;

create or replace function public.seguro_edge_perfil_publico()
returns uuid language sql stable security definer set search_path = '' as $$
  select c.valor::uuid from seguros.config c
   where c.chave = 'perfil_publico' and exists (select 1 from seguros.perfis p where p.id = c.valor::uuid and p.ativo)
$$;

create or replace function public.seguro_edge_criar_perfil_publico(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from seguros.config where chave = 'perfil_publico') then raise exception 'ja_existe'; end if;
  insert into seguros.perfis (id, nome, papel) values (p_uid, 'Envio público', 'envio');
  insert into seguros.config (chave, valor) values ('perfil_publico', p_uid::text);
  perform seguros.auditar('criou_perfil_envio_publico', 'perfil', p_uid::text, null, p_uid);
  return jsonb_build_object('ok', true);
end $$;

-- Limite por IP (30 envios / 10 min) e global (300 / 10 min). Registra a tentativa aceita.
create or replace function public.seguro_edge_limite_publico(p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ip integer; v_all integer;
begin
  if p_ip_hash is null or char_length(p_ip_hash) < 16 then raise exception 'ip_invalido'; end if;
  delete from seguros.envios_publicos where criado_em < now() - interval '2 days';
  select count(*) into v_ip from seguros.envios_publicos where ip_hash = p_ip_hash and criado_em > now() - interval '10 minutes';
  select count(*) into v_all from seguros.envios_publicos where criado_em > now() - interval '10 minutes';
  if v_ip >= 30 or v_all >= 300 then raise exception 'limite_excedido'; end if;
  insert into seguros.envios_publicos (ip_hash) values (p_ip_hash);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_edge_registrar_cotacao(
  p_uid uuid, p_path text, p_nome_arquivo text, p_tipo text, p_tamanho integer, p_sha256 text,
  p_motivo text, p_dados jsonb default null, p_origem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cot uuid; v_cli uuid; v_size integer; v_mime text; v_d jsonb;
begin
  -- só o perfil técnico de envio público pode usar esta porta
  if p_uid is null or p_uid is distinct from (select c.valor::uuid from seguros.config c where c.chave = 'perfil_publico') then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  if p_path is null or p_path !~ ('^' || p_uid::text || '/[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.(jpg|png|pdf)$') then raise exception 'caminho_invalido'; end if;
  if p_tipo is null or p_tipo not in ('image/jpeg', 'image/png', 'application/pdf') then raise exception 'tipo_invalido'; end if;
  if p_motivo is null or p_motivo not in ('nao_quer', 'vai_fazer_depois') then raise exception 'motivo_invalido'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalido'; end if;
  if p_tamanho is null or p_tamanho <= 0 or p_tamanho > 10485760 then raise exception 'tamanho_invalido'; end if;

  select (o.metadata->>'size')::integer, o.metadata->>'mimetype' into v_size, v_mime
    from storage.objects o where o.bucket_id = 'seguros-cotacoes' and o.name = p_path;
  if v_size is null then raise exception 'arquivo_nao_encontrado'; end if;
  if v_size <> p_tamanho or v_mime <> p_tipo then raise exception 'arquivo_divergente'; end if;

  v_d := seguros.parse_dados(p_dados);

  insert into seguros.cotacoes (enviado_por, arquivo_path, arquivo_nome, arquivo_tipo, arquivo_tamanho,
                                arquivo_sha256, motivo_recusa, dados_extraidos, extracao_origem)
  values (p_uid, p_path, coalesce(seguros.limpar(p_nome_arquivo, 200), 'cotacao'), p_tipo, p_tamanho,
          p_sha256, p_motivo, v_d, case when v_d is not null and p_origem in ('ocr_navegador', 'texto_pdf') then p_origem end)
  returning id into v_cot;

  insert into seguros.clientes (cotacao_id, nome, telefone, modelo_moto, data_entrega, valor_cotacao, seguradora)
  values (v_cot, v_d->>'nome', v_d->>'telefone', v_d->>'modelo_moto',
          (v_d->>'data_entrega')::date, (v_d->>'valor_cotacao')::numeric, v_d->>'seguradora')
  returning id into v_cli;

  insert into seguros.historico (cliente_id, tipo, texto, usuario_id) values (v_cli, 'sistema', 'Cotação recebida (envio público).', p_uid);
  perform seguros.auditar('enviou_cotacao', 'cotacao', v_cot::text,
                          jsonb_build_object('motivo', p_motivo, 'tipo', p_tipo, 'tamanho', p_tamanho, 'via', 'publico'), p_uid);
  return jsonb_build_object('id', v_cot, 'recebida_em', now());
end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('seguro_edge_perfil_publico','seguro_edge_criar_perfil_publico','seguro_edge_limite_publico','seguro_edge_registrar_cotacao')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.f);
    execute format('grant execute on function %s to service_role', r.f);
  end loop;
end $$;
