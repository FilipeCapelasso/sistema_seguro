-- =====================================================================
-- Migration 02: API do envio de cotações e do painel de recuperação
--
-- Funções-ponte em "public" com prefixo seguro_ (a Data API só expõe
-- public). Todas: SECURITY DEFINER, search_path vazio, checagem de papel
-- no servidor (seguros.exigir), execute apenas para "authenticated".
-- Nenhuma tabela do Honda é lida ou alterada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internas: totais e evolução mensal (período = data de recebimento)
-- ---------------------------------------------------------------------
create or replace function seguros.totais(p_de date, p_ate date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recebidos',           count(*),
    'novas',               count(*) filter (where c.visto_em is null),
    'aguardando_contato',  count(*) filter (where c.situacao in ('novo', 'aguardando_primeiro_contato')),
    'a_recontatar',        count(*) filter (where c.situacao in ('primeiro_contato_realizado', 'aguardando_resposta')
                                             and coalesce(c.ultimo_contato_em, c.primeiro_contato_em, c.criado_em) < now() - interval '3 days'),
    'em_negociacao',       count(*) filter (where c.situacao = 'em_negociacao'),
    'interessados',        count(*) filter (where c.situacao = 'interessado'),
    'contratados',         count(*) filter (where c.situacao = 'seguro_contratado'),
    'recusaram_novamente', count(*) filter (where c.situacao = 'recusou_novamente'),
    'sem_contato',         count(*) filter (where c.situacao = 'nao_foi_possivel_contato'),
    'contatados',          count(*) filter (where c.primeiro_contato_em is not null),
    'ja_interessados',     count(*) filter (where c.interesse_em is not null),
    'dados_incompletos',   count(*) filter (where c.nome is null or c.telefone_norm is null),
    'taxa_conversao',      case when count(*) filter (where c.primeiro_contato_em is not null) = 0 then null
                                else round(100.0 * count(*) filter (where c.situacao = 'seguro_contratado')
                                           / count(*) filter (where c.primeiro_contato_em is not null), 1) end
  )
  from seguros.clientes c
  where (p_de  is null or (c.criado_em at time zone 'America/Rio_Branco')::date >= p_de)
    and (p_ate is null or (c.criado_em at time zone 'America/Rio_Branco')::date <= p_ate)
$$;

create or replace function seguros.resumo_mensal(p_de date, p_ate date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(m order by m.mes), '[]'::jsonb)
  from (
    select to_char(date_trunc('month', c.criado_em at time zone 'America/Rio_Branco'), 'YYYY-MM') as mes,
           count(*)                                                       as recebidas,
           count(*) filter (where c.primeiro_contato_em is not null)       as contatados,
           count(*) filter (where c.interesse_em is not null)              as interessados,
           count(*) filter (where c.situacao = 'seguro_contratado')        as contratados,
           count(*) filter (where c.situacao = 'recusou_novamente')        as recusas
      from seguros.clientes c
     where (p_de  is null or (c.criado_em at time zone 'America/Rio_Branco')::date >= p_de)
       and (p_ate is null or (c.criado_em at time zone 'America/Rio_Branco')::date <= p_ate)
     group by 1
  ) m
$$;
revoke all on function seguros.totais(date, date), seguros.resumo_mensal(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Perfil e envio
-- ---------------------------------------------------------------------
create or replace function public.seguro_meu_perfil()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'nome', p.nome, 'papel', p.papel)
    from seguros.perfis p
   where p.id = (select auth.uid()) and p.ativo
$$;

create or replace function public.seguro_minhas_cotacoes(p_limite integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform seguros.exigir('envio', 'recuperacao', 'admin');
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.criado_em desc)
      from (select k.id, k.criado_em, k.arquivo_nome, k.motivo_recusa
              from seguros.cotacoes k
             where k.enviado_por = v_uid
             order by k.criado_em desc
             limit least(greatest(coalesce(p_limite, 20), 1), 50)) x
  ), '[]'::jsonb);
end $$;

create or replace function public.seguro_registrar_cotacao(
  p_path text, p_nome_arquivo text, p_tipo text, p_tamanho integer, p_sha256 text,
  p_motivo text, p_observacao text default null, p_dados jsonb default null, p_origem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cot uuid; v_cli uuid; v_size integer; v_mime text; v_d jsonb;
begin
  perform seguros.exigir('envio', 'recuperacao', 'admin');

  if p_path is null or p_path !~ ('^' || v_uid::text || '/[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.(jpg|png|pdf)$') then
    raise exception 'caminho_invalido';
  end if;
  if p_tipo is null or p_tipo not in ('image/jpeg', 'image/png', 'application/pdf') then raise exception 'tipo_invalido'; end if;
  if p_motivo is null or p_motivo not in ('nao_quer','achou_caro','vai_pensar','vai_fazer_depois','ja_possui','outro') then
    raise exception 'motivo_invalido';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalido'; end if;
  if p_tamanho is null or p_tamanho <= 0 or p_tamanho > 10485760 then raise exception 'tamanho_invalido'; end if;

  if (select count(*) from seguros.cotacoes where enviado_por = v_uid and criado_em > now() - interval '10 minutes') >= 40 then
    raise exception 'limite_excedido';
  end if;

  -- o arquivo precisa existir no bucket privado, com o mesmo tamanho e tipo declarados
  select (o.metadata->>'size')::integer, o.metadata->>'mimetype'
    into v_size, v_mime
    from storage.objects o
   where o.bucket_id = 'seguros-cotacoes' and o.name = p_path;
  if v_size is null then raise exception 'arquivo_nao_encontrado'; end if;
  if v_size <> p_tamanho or v_mime <> p_tipo then raise exception 'arquivo_divergente'; end if;

  v_d := seguros.parse_dados(p_dados);

  insert into seguros.cotacoes (enviado_por, arquivo_path, arquivo_nome, arquivo_tipo, arquivo_tamanho,
                                arquivo_sha256, motivo_recusa, observacao_envio, dados_extraidos, extracao_origem)
  values (v_uid, p_path, coalesce(seguros.limpar(p_nome_arquivo, 200), 'cotacao'), p_tipo, p_tamanho,
          p_sha256, p_motivo, seguros.limpar_ml(p_observacao, 500), v_d,
          case when v_d is not null and p_origem in ('ocr_navegador', 'texto_pdf') then p_origem end)
  returning id into v_cot;

  insert into seguros.clientes (cotacao_id, nome, telefone, modelo_moto, data_entrega, valor_cotacao, seguradora)
  values (v_cot, v_d->>'nome', v_d->>'telefone', v_d->>'modelo_moto',
          (v_d->>'data_entrega')::date, (v_d->>'valor_cotacao')::numeric, v_d->>'seguradora')
  returning id into v_cli;

  insert into seguros.historico (cliente_id, tipo, texto, usuario_id)
  values (v_cli, 'sistema', 'Cotação recebida.', v_uid);

  perform seguros.auditar('enviou_cotacao', 'cotacao', v_cot::text,
                          jsonb_build_object('motivo', p_motivo, 'tipo', p_tipo, 'tamanho', p_tamanho));

  return jsonb_build_object('id', v_cot, 'recebida_em', now(),
    'dados_lidos', coalesce(v_d ?| array['nome', 'telefone', 'modelo_moto', 'valor_cotacao', 'seguradora', 'data_entrega'], false));
end $$;

-- ---------------------------------------------------------------------
-- Painel: dashboard, lista, detalhe
-- ---------------------------------------------------------------------
create or replace function public.seguro_dashboard(p_de date default null, p_ate date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  return seguros.totais(p_de, p_ate)
      || jsonb_build_object('mensal', seguros.resumo_mensal(
            coalesce(p_de, date_trunc('month', current_date - interval '11 months')::date), p_ate));
end $$;

create or replace function public.seguro_listar_clientes(
  p_filtros jsonb default '{}'::jsonb, p_limite integer default 25, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f        jsonb   := coalesce(p_filtros, '{}'::jsonb);
  v_busca  text    := seguros.limpar(f->>'busca', 80);
  v_dig    text;
  v_moto   text    := seguros.limpar(f->>'moto', 80);
  v_motivo text    := nullif(f->>'motivo', '');
  v_sit    text    := nullif(f->>'situacao', '');
  v_seg    text    := seguros.limpar(f->>'seguradora', 80);
  v_de     date    := seguros.data_ou_nula(f->>'de');
  v_ate    date    := seguros.data_ou_nula(f->>'ate');
  v_novos  boolean := coalesce(f->>'so_novos', '') = 'true';
  v_inc    boolean := coalesce(f->>'so_incompletos', '') = 'true';
  v_ordem  text    := coalesce(nullif(f->>'ordem', ''), 'prioridade');
  v_lim    integer := least(greatest(coalesce(p_limite, 25), 1), 100);
  v_off    integer := greatest(coalesce(p_offset, 0), 0);
  r        jsonb;
begin
  perform seguros.exigir('recuperacao', 'admin');
  v_dig := nullif(regexp_replace(coalesce(v_busca, ''), '\D', '', 'g'), '');

  with q as (
    select c.id, c.nome, c.telefone, c.telefone_norm, c.modelo_moto, c.data_entrega, c.valor_cotacao,
           c.seguradora, k.motivo_recusa, c.situacao, c.dados_conferidos,
           (c.telefone_norm is not null and exists (
              select 1 from seguros.clientes d where d.telefone_norm = c.telefone_norm and d.id <> c.id)) as repetido,
           (c.visto_em is not null) as visto,
           c.criado_em as recebida_em, c.ultimo_contato_em,
           seguros.calc_prioridade(c.situacao, k.motivo_recusa, c.criado_em,
                                   coalesce(c.ultimo_contato_em, c.primeiro_contato_em)) as prioridade,
           (c.nome is null or c.telefone_norm is null) as incompleto
      from seguros.clientes c
      join seguros.cotacoes k on k.id = c.cotacao_id
     where (v_busca is null
            or position(lower(v_busca) in lower(coalesce(c.nome, ''))) > 0
            or (v_dig is not null and (position(v_dig in coalesce(c.telefone_norm, '')) > 0
                or position(v_dig in regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g')) > 0)))
       and (v_moto   is null or position(lower(v_moto) in lower(coalesce(c.modelo_moto, ''))) > 0)
       and (v_motivo is null or k.motivo_recusa = v_motivo)
       and (v_sit    is null or c.situacao = v_sit)
       and (v_seg    is null or position(lower(v_seg) in lower(coalesce(c.seguradora, ''))) > 0)
       and (v_de     is null or (c.criado_em at time zone 'America/Rio_Branco')::date >= v_de)
       and (v_ate    is null or (c.criado_em at time zone 'America/Rio_Branco')::date <= v_ate)
       and (not v_novos or c.visto_em is null)
       and (not v_inc or c.nome is null or c.telefone_norm is null)
  )
  select jsonb_build_object(
           'total', (select count(*) from q),
           'itens', coalesce((
             select jsonb_agg(to_jsonb(x) - 'rn' order by x.rn)
               from (select q.*, row_number() over (
                              order by (case when v_ordem = 'prioridade' then q.prioridade else 0 end) desc,
                                       (case when v_ordem = 'antigos' then extract(epoch from q.recebida_em)
                                             else -extract(epoch from q.recebida_em) end) asc) as rn
                       from q
                      order by rn
                      limit v_lim offset v_off) x), '[]'::jsonb))
    into r;
  return r;
end $$;

create or replace function public.seguro_obter_cliente(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_uid uuid := (select auth.uid());
begin
  perform seguros.exigir('recuperacao', 'admin');

  update seguros.clientes set visto_em = now(), visto_por = v_uid where id = p_id and visto_em is null;

  select jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'telefone', c.telefone, 'telefone_norm', c.telefone_norm,
    'modelo_moto', c.modelo_moto, 'data_entrega', c.data_entrega, 'valor_cotacao', c.valor_cotacao,
    'seguradora', c.seguradora, 'situacao', c.situacao, 'dados_conferidos', c.dados_conferidos,
    'recebida_em', c.criado_em, 'primeiro_contato_em', c.primeiro_contato_em,
    'ultimo_contato_em', c.ultimo_contato_em, 'contratado_em', c.contratado_em,
    'prioridade', seguros.calc_prioridade(c.situacao, k.motivo_recusa, c.criado_em,
                                          coalesce(c.ultimo_contato_em, c.primeiro_contato_em)),
    'cotacao', jsonb_build_object(
        'id', k.id, 'arquivo_nome', k.arquivo_nome, 'arquivo_tipo', k.arquivo_tipo,
        'arquivo_tamanho', k.arquivo_tamanho, 'motivo_recusa', k.motivo_recusa,
        'observacao_envio', k.observacao_envio, 'dados_extraidos', k.dados_extraidos,
        'extracao_origem', k.extracao_origem, 'recebida_em', k.criado_em,
        'enviado_por', (select p.nome from seguros.perfis p where p.id = k.enviado_por)),
    'historico', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', h.id, 'tipo', h.tipo, 'de', h.situacao_de, 'para', h.situacao_para,
                    'canal', h.canal, 'texto', h.texto, 'em', h.criado_em,
                    'usuario', (select p.nome from seguros.perfis p where p.id = h.usuario_id))
                    order by h.criado_em desc, h.id desc), '[]'::jsonb)
                    from seguros.historico h where h.cliente_id = c.id),
    'outras_cotacoes', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', d.id, 'recebida_em', d.criado_em, 'situacao', d.situacao, 'moto', d.modelo_moto)
                    order by d.criado_em desc), '[]'::jsonb)
                    from seguros.clientes d
                   where c.telefone_norm is not null and d.telefone_norm = c.telefone_norm and d.id <> c.id)
  )
    into v
    from seguros.clientes c
    join seguros.cotacoes k on k.id = c.cotacao_id
   where c.id = p_id;

  if v is null then raise exception 'nao_encontrado'; end if;
  perform seguros.auditar('visualizou_cliente', 'cliente', p_id::text);
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Painel: alterações
-- ---------------------------------------------------------------------
create or replace function public.seguro_atualizar_cliente(p_id uuid, p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p jsonb := coalesce(p_dados, '{}'::jsonb); v_tel text;
begin
  perform seguros.exigir('recuperacao', 'admin');

  if p ? 'telefone' then
    v_tel := seguros.limpar(p->>'telefone', 30);
    if v_tel is not null and seguros.normalizar_telefone(v_tel) is null then raise exception 'telefone_invalido'; end if;
  end if;
  if p ? 'data_entrega' and seguros.limpar(p->>'data_entrega', 20) is not null
     and seguros.data_ou_nula(p->>'data_entrega') is null then raise exception 'data_invalida'; end if;
  if p ? 'valor_cotacao' and seguros.limpar(p->>'valor_cotacao', 20) is not null
     and seguros.numero_ou_nulo(p->>'valor_cotacao') is null then raise exception 'valor_invalido'; end if;

  update seguros.clientes set
    nome          = case when p ? 'nome'          then seguros.limpar(p->>'nome', 120) else nome end,
    telefone      = case when p ? 'telefone'      then seguros.limpar(p->>'telefone', 30) else telefone end,
    modelo_moto   = case when p ? 'modelo_moto'   then seguros.limpar(p->>'modelo_moto', 120) else modelo_moto end,
    data_entrega  = case when p ? 'data_entrega'  then seguros.data_ou_nula(p->>'data_entrega') else data_entrega end,
    valor_cotacao = case when p ? 'valor_cotacao' then seguros.numero_ou_nulo(p->>'valor_cotacao') else valor_cotacao end,
    seguradora    = case when p ? 'seguradora'    then seguros.limpar(p->>'seguradora', 80) else seguradora end,
    dados_conferidos = true
  where id = p_id;
  if not found then raise exception 'nao_encontrado'; end if;

  perform seguros.auditar('alterou_dados_cliente', 'cliente', p_id::text,
                          jsonb_build_object('campos', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p) k)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_alterar_situacao(p_id uuid, p_situacao text, p_texto text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_obs text := seguros.limpar_ml(p_texto, 2000);
begin
  perform seguros.exigir('recuperacao', 'admin');
  if p_situacao is null or p_situacao not in ('novo','aguardando_primeiro_contato','primeiro_contato_realizado',
       'aguardando_resposta','em_negociacao','interessado','seguro_contratado','recusou_novamente','nao_foi_possivel_contato') then
    raise exception 'situacao_invalida';
  end if;
  update seguros.clientes set situacao = p_situacao where id = p_id;
  if not found then raise exception 'nao_encontrado'; end if;
  if v_obs is not null then
    insert into seguros.historico (cliente_id, tipo, texto, usuario_id) values (p_id, 'observacao', v_obs, (select auth.uid()));
  end if;
  perform seguros.auditar('alterou_situacao', 'cliente', p_id::text, jsonb_build_object('para', p_situacao));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_registrar_contato(p_id uuid, p_canal text default 'whatsapp', p_texto text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  if p_canal is null or p_canal not in ('whatsapp', 'ligacao', 'presencial', 'outro') then raise exception 'canal_invalido'; end if;
  update seguros.clientes set
    ultimo_contato_em   = now(),
    primeiro_contato_em = coalesce(primeiro_contato_em, now()),
    situacao = case when situacao in ('novo', 'aguardando_primeiro_contato') then 'primeiro_contato_realizado' else situacao end
  where id = p_id;
  if not found then raise exception 'nao_encontrado'; end if;
  insert into seguros.historico (cliente_id, tipo, canal, texto, usuario_id)
  values (p_id, 'contato', p_canal, seguros.limpar_ml(p_texto, 2000), (select auth.uid()));
  perform seguros.auditar('registrou_contato', 'cliente', p_id::text, jsonb_build_object('canal', p_canal));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.seguro_adicionar_observacao(p_id uuid, p_texto text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text := seguros.limpar_ml(p_texto, 2000);
begin
  perform seguros.exigir('recuperacao', 'admin');
  if v is null then raise exception 'texto_vazio'; end if;
  perform 1 from seguros.clientes where id = p_id;
  if not found then raise exception 'nao_encontrado'; end if;
  insert into seguros.historico (cliente_id, tipo, texto, usuario_id) values (p_id, 'observacao', v, (select auth.uid()));
  perform seguros.auditar('adicionou_observacao', 'cliente', p_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- Preenche (uma única vez) os dados lidos da cotação e completa só os campos vazios do cliente.
create or replace function public.seguro_salvar_extracao(p_cotacao uuid, p_dados jsonb, p_origem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform seguros.exigir('recuperacao', 'admin');
  v := seguros.parse_dados(p_dados);
  if v is null then return jsonb_build_object('ok', true, 'preenchido', false); end if;

  update seguros.cotacoes
     set dados_extraidos = v,
         extracao_origem = case when p_origem in ('ocr_navegador', 'texto_pdf') then p_origem end
   where id = p_cotacao and dados_extraidos is null;
  if not found then return jsonb_build_object('ok', true, 'preenchido', false); end if;

  update seguros.clientes c set
    nome          = coalesce(c.nome, v->>'nome'),
    telefone      = coalesce(c.telefone, v->>'telefone'),
    modelo_moto   = coalesce(c.modelo_moto, v->>'modelo_moto'),
    data_entrega  = coalesce(c.data_entrega, (v->>'data_entrega')::date),
    valor_cotacao = coalesce(c.valor_cotacao, (v->>'valor_cotacao')::numeric),
    seguradora    = coalesce(c.seguradora, v->>'seguradora')
  where c.cotacao_id = p_cotacao;

  perform seguros.auditar('extraiu_dados', 'cotacao', p_cotacao::text);
  return jsonb_build_object('ok', true, 'preenchido', true);
end $$;

-- ---------------------------------------------------------------------
-- Mensagens prontas
-- ---------------------------------------------------------------------
create or replace function public.seguro_listar_mensagens()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  return coalesce((select jsonb_agg(to_jsonb(m) - 'criado_em' - 'atualizado_em' order by m.ordem, m.titulo)
                     from seguros.mensagens_modelo m), '[]'::jsonb);
end $$;

create or replace function public.seguro_salvar_mensagem(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform seguros.exigir('recuperacao', 'admin');
  if p->>'categoria' is null or seguros.limpar(p->>'titulo', 80) is null or seguros.limpar_ml(p->>'texto', 1500) is null then
    raise exception 'dados_incompletos';
  end if;
  insert into seguros.mensagens_modelo (id, categoria, titulo, texto, ativo, ordem)
  values (coalesce(v_id, gen_random_uuid()), p->>'categoria', seguros.limpar(p->>'titulo', 80),
          seguros.limpar_ml(p->>'texto', 1500), coalesce((p->>'ativo')::boolean, true), coalesce((p->>'ordem')::integer, 100))
  on conflict (id) do update set categoria = excluded.categoria, titulo = excluded.titulo,
          texto = excluded.texto, ativo = excluded.ativo, ordem = excluded.ordem
  returning id into v_id;
  perform seguros.auditar('salvou_mensagem', 'mensagem', v_id::text);
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.seguro_excluir_mensagem(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  delete from seguros.mensagens_modelo where id = p_id;
  if not found then raise exception 'nao_encontrado'; end if;
  perform seguros.auditar('excluiu_mensagem', 'mensagem', p_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Biblioteca de materiais de vendas
-- ---------------------------------------------------------------------
create or replace function public.seguro_listar_materiais()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  return coalesce((select jsonb_agg(to_jsonb(m) - 'criado_por' - 'atualizado_em' order by m.ordem, m.criado_em desc)
                     from seguros.materiais m), '[]'::jsonb);
end $$;

create or replace function public.seguro_salvar_material(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_path text := nullif(p->>'arquivo_path', '');
  v_link text := seguros.limpar(p->>'link_externo', 500);
  v_tipo_arq text; v_tam bigint;
begin
  perform seguros.exigir('recuperacao', 'admin');
  if p->>'tipo' is null or seguros.limpar(p->>'titulo', 120) is null then raise exception 'dados_incompletos'; end if;
  if v_link is not null and v_link !~* '^https://' then raise exception 'link_invalido'; end if;

  if v_path is not null then
    if v_path !~ '^materiais/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm|mov|pdf)$' then raise exception 'caminho_invalido'; end if;
    select o.metadata->>'mimetype', (o.metadata->>'size')::bigint into v_tipo_arq, v_tam
      from storage.objects o where o.bucket_id = 'seguros-materiais' and o.name = v_path;
    if v_tam is null then raise exception 'arquivo_nao_encontrado'; end if;
  end if;

  insert into seguros.materiais (id, tipo, titulo, descricao, texto, arquivo_path, arquivo_tipo, arquivo_tamanho,
                                 link_externo, ativo, ordem, criado_por)
  values (coalesce(v_id, gen_random_uuid()), p->>'tipo', seguros.limpar(p->>'titulo', 120),
          seguros.limpar(p->>'descricao', 500), seguros.limpar_ml(p->>'texto', 4000),
          v_path, v_tipo_arq, v_tam, v_link,
          coalesce((p->>'ativo')::boolean, true), coalesce((p->>'ordem')::integer, 100), (select auth.uid()))
  on conflict (id) do update set tipo = excluded.tipo, titulo = excluded.titulo, descricao = excluded.descricao,
          texto = excluded.texto, arquivo_path = excluded.arquivo_path, arquivo_tipo = excluded.arquivo_tipo,
          arquivo_tamanho = excluded.arquivo_tamanho, link_externo = excluded.link_externo,
          ativo = excluded.ativo, ordem = excluded.ordem
  returning id into v_id;
  perform seguros.auditar('salvou_material', 'material', v_id::text);
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.seguro_excluir_material(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  perform seguros.exigir('recuperacao', 'admin');
  delete from seguros.materiais where id = p_id returning arquivo_path into v_path;
  if not found then raise exception 'nao_encontrado'; end if;
  perform seguros.auditar('excluiu_material', 'material', p_id::text);
  return jsonb_build_object('ok', true, 'arquivo_path', v_path);
end $$;

-- ---------------------------------------------------------------------
-- Relatórios (período = data de recebimento da cotação)
-- ---------------------------------------------------------------------
create or replace function public.seguro_relatorio(p_de date default null, p_ate date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform seguros.exigir('recuperacao', 'admin');
  return jsonb_build_object(
    'periodo', jsonb_build_object('de', p_de, 'ate', p_ate),
    'totais',  seguros.totais(p_de, p_ate),
    'mensal',  seguros.resumo_mensal(p_de, p_ate),
    'motivos', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.total desc, m.motivo)
        from (select k.motivo_recusa as motivo, count(*) as total,
                     count(*) filter (where c.situacao = 'seguro_contratado') as contratados
                from seguros.clientes c join seguros.cotacoes k on k.id = c.cotacao_id
               where (p_de  is null or (c.criado_em at time zone 'America/Rio_Branco')::date >= p_de)
                 and (p_ate is null or (c.criado_em at time zone 'America/Rio_Branco')::date <= p_ate)
               group by k.motivo_recusa) m), '[]'::jsonb),
    'situacoes', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.total desc)
        from (select c.situacao, count(*) as total
                from seguros.clientes c
               where (p_de  is null or (c.criado_em at time zone 'America/Rio_Branco')::date >= p_de)
                 and (p_ate is null or (c.criado_em at time zone 'America/Rio_Branco')::date <= p_ate)
               group by c.situacao) s), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------
-- Permissões das funções-ponte: só usuários logados (nunca anon)
-- ---------------------------------------------------------------------
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
