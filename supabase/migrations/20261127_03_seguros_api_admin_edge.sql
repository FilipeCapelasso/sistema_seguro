-- =====================================================================
-- Migration 03: administração (usuários, auditoria) e funções de apoio
-- das Edge Functions.
--
-- seguro_admin_*  -> chamadas pelo navegador do administrador (checam papel).
-- seguro_edge_*   -> execute SOMENTE para service_role: o navegador nunca
--                    consegue chamar; só as Edge Functions, que já validaram
--                    o JWT do usuário.
-- =====================================================================

create or replace function public.seguro_admin_listar_usuarios()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform seguros.exigir('admin');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'nome', p.nome, 'papel', p.papel, 'ativo', p.ativo,
             'email', u.email, 'ultimo_acesso', u.last_sign_in_at, 'criado_em', p.criado_em)
           order by p.criado_em)
      from seguros.perfis p join auth.users u on u.id = p.id), '[]'::jsonb);
end $$;

create or replace function public.seguro_admin_auditoria(
  p_filtros jsonb default '{}'::jsonb, p_limite integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_acao text := seguros.limpar(f->>'acao', 60);
  v_usr  uuid := nullif(f->>'usuario_id', '')::uuid;
  v_de   date := seguros.data_ou_nula(f->>'de');
  v_ate  date := seguros.data_ou_nula(f->>'ate');
  v_lim  integer := least(greatest(coalesce(p_limite, 50), 1), 200);
  v_off  integer := greatest(coalesce(p_offset, 0), 0);
  r jsonb;
begin
  perform seguros.exigir('admin');
  with q as (
    select a.id, a.criado_em, a.usuario_id, a.usuario_nome, a.acao, a.entidade, a.entidade_id, a.detalhes
      from seguros.auditoria a
     where (v_acao is null or a.acao = v_acao)
       and (v_usr is null or a.usuario_id = v_usr)
       and (v_de is null or (a.criado_em at time zone 'America/Rio_Branco')::date >= v_de)
       and (v_ate is null or (a.criado_em at time zone 'America/Rio_Branco')::date <= v_ate)
  )
  select jsonb_build_object(
           'total', (select count(*) from q),
           'itens', coalesce((select jsonb_agg(to_jsonb(x) order by x.criado_em desc, x.id desc)
                                from (select * from q order by criado_em desc, id desc limit v_lim offset v_off) x), '[]'::jsonb))
    into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Funções de apoio das Edge Functions (somente service_role)
-- ---------------------------------------------------------------------
create or replace function public.seguro_edge_perfil(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'nome', p.nome, 'papel', p.papel)
    from seguros.perfis p where p.id = p_uid and p.ativo
$$;

create or replace function public.seguro_edge_perfil_existe(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from seguros.perfis p where p.id = p_uid)
$$;

create or replace function public.seguro_edge_precisa_setup()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from seguros.config where chave = 'bootstrap_hash')
     and not exists (select 1 from seguros.perfis where papel = 'admin' and ativo)
$$;

create or replace function public.seguro_edge_bootstrap_ok(p_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.seguro_edge_precisa_setup() then raise exception 'setup_indisponivel'; end if;
  if (select count(*) from seguros.auditoria
       where acao = 'bootstrap_falhou' and criado_em > now() - interval '15 minutes') >= 5 then
    raise exception 'muitas_tentativas';
  end if;
  if p_hash is not null and exists (select 1 from seguros.config where chave = 'bootstrap_hash' and valor = p_hash) then
    return true;
  end if;
  perform seguros.auditar('bootstrap_falhou');
  return false;
end $$;

create or replace function public.seguro_edge_bootstrap_concluir(p_uid uuid, p_nome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('seguros_bootstrap'));
  if exists (select 1 from seguros.perfis where papel = 'admin' and ativo) then raise exception 'setup_ja_concluido'; end if;
  if not exists (select 1 from seguros.config where chave = 'bootstrap_hash') then raise exception 'setup_indisponivel'; end if;
  insert into seguros.perfis (id, nome, papel, criado_por)
  values (p_uid, coalesce(seguros.limpar(p_nome, 80), 'Administrador'), 'admin', p_uid);
  delete from seguros.config where chave = 'bootstrap_hash';
  perform seguros.auditar('primeiro_acesso_admin', 'perfil', p_uid::text, null, p_uid);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_edge_criar_perfil(p_por uuid, p_uid uuid, p_nome text, p_papel text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from seguros.perfis where id = p_por and papel = 'admin' and ativo) then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  if p_papel is null or p_papel not in ('envio', 'recuperacao', 'admin') then raise exception 'papel_invalido'; end if;
  if seguros.limpar(p_nome, 80) is null or char_length(seguros.limpar(p_nome, 80)) < 2 then raise exception 'nome_invalido'; end if;
  insert into seguros.perfis (id, nome, papel, criado_por) values (p_uid, seguros.limpar(p_nome, 80), p_papel, p_por);
  perform seguros.auditar('criou_usuario', 'perfil', p_uid::text, jsonb_build_object('papel', p_papel), p_por);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_edge_atualizar_perfil(
  p_por uuid, p_uid uuid, p_nome text default null, p_papel text default null, p_ativo boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_atual seguros.perfis; v_novo_papel text; v_novo_ativo boolean;
begin
  if not exists (select 1 from seguros.perfis where id = p_por and papel = 'admin' and ativo) then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  select * into v_atual from seguros.perfis where id = p_uid;
  if not found then raise exception 'nao_encontrado'; end if;
  if p_papel is not null and p_papel not in ('envio', 'recuperacao', 'admin') then raise exception 'papel_invalido'; end if;

  v_novo_papel := coalesce(p_papel, v_atual.papel);
  v_novo_ativo := coalesce(p_ativo, v_atual.ativo);

  if p_uid = p_por and (v_novo_papel <> 'admin' or not v_novo_ativo) then
    raise exception 'nao_pode_alterar_a_si_mesmo';
  end if;
  if v_atual.papel = 'admin' and v_atual.ativo and (v_novo_papel <> 'admin' or not v_novo_ativo)
     and not exists (select 1 from seguros.perfis where papel = 'admin' and ativo and id <> p_uid) then
    raise exception 'ultimo_admin';
  end if;

  update seguros.perfis
     set nome = coalesce(seguros.limpar(p_nome, 80), nome), papel = v_novo_papel, ativo = v_novo_ativo
   where id = p_uid;
  perform seguros.auditar('alterou_usuario', 'perfil', p_uid::text,
                          jsonb_build_object('papel', v_novo_papel, 'ativo', v_novo_ativo), p_por);
  return jsonb_build_object('ok', true, 'papel', v_novo_papel, 'ativo', v_novo_ativo);
end $$;

create or replace function public.seguro_edge_arquivo(p_uid uuid, p_cotacao uuid, p_download boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not exists (select 1 from seguros.perfis where id = p_uid and ativo and papel in ('recuperacao', 'admin')) then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  select jsonb_build_object('path', k.arquivo_path, 'nome', k.arquivo_nome, 'tipo', k.arquivo_tipo)
    into v from seguros.cotacoes k where k.id = p_cotacao;
  if v is null then raise exception 'nao_encontrado'; end if;
  perform seguros.auditar(case when p_download then 'baixou_arquivo' else 'visualizou_arquivo' end,
                          'cotacao', p_cotacao::text, null, p_uid);
  return v;
end $$;

-- Exclusão definitiva (direito do titular / LGPD). Só administrador.
create or replace function public.seguro_edge_excluir_cliente(p_uid uuid, p_cliente uuid, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cot uuid; v_path text;
begin
  if not exists (select 1 from seguros.perfis where id = p_uid and papel = 'admin' and ativo) then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  select k.id, k.arquivo_path into v_cot, v_path
    from seguros.clientes c join seguros.cotacoes k on k.id = c.cotacao_id where c.id = p_cliente;
  if v_cot is null then raise exception 'nao_encontrado'; end if;

  perform set_config('seguros.excluindo', 'on', true);
  delete from seguros.cotacoes where id = v_cot;          -- cascata: cliente e histórico
  perform set_config('seguros.excluindo', 'off', true);

  perform seguros.auditar('excluiu_cliente', 'cliente', p_cliente::text,
                          jsonb_build_object('motivo', seguros.limpar(p_motivo, 300), 'cotacao_id', v_cot,
                                             'arquivo_path', v_path), p_uid);
  return jsonb_build_object('ok', true, 'arquivo_path', v_path);
end $$;

create or replace function public.seguro_edge_auditar(
  p_uid uuid, p_acao text, p_entidade text default null, p_entidade_id text default null, p_detalhes jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform seguros.auditar(left(p_acao, 60), left(p_entidade, 60), left(p_entidade_id, 80), p_detalhes, p_uid);
end $$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as f, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'seguro\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.f);
    if r.proname like 'seguro\_edge\_%' then
      execute format('grant execute on function %s to service_role', r.f);
    else
      execute format('grant execute on function %s to authenticated', r.f);
    end if;
  end loop;
end $$;
