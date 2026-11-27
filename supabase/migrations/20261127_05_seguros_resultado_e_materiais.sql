-- =====================================================================
-- Migration 05: resultado das próprias cotações (envio) + remoção de
-- arquivos de materiais pelo painel.
-- O "resultado" é grosseiro de propósito: quem envia não vê dados do
-- cliente, só se a cotação foi recebida, está em andamento ou fechou.
-- =====================================================================
create or replace function public.seguro_minhas_cotacoes(p_limite integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform seguros.exigir('envio', 'recuperacao', 'admin');
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.criado_em desc)
      from (select k.id, k.criado_em, k.arquivo_nome, k.motivo_recusa,
                   case c.situacao
                     when 'seguro_contratado' then 'fechou'
                     when 'recusou_novamente' then 'sem_sucesso'
                     when 'nao_foi_possivel_contato' then 'sem_sucesso'
                     when 'novo' then 'recebida'
                     else 'em_andamento'
                   end as resultado
              from seguros.cotacoes k
              left join seguros.clientes c on c.cotacao_id = k.id
             where k.enviado_por = v_uid
             order by k.criado_em desc
             limit least(greatest(coalesce(p_limite, 20), 1), 50)) x
  ), '[]'::jsonb);
end $$;
revoke all on function public.seguro_minhas_cotacoes(integer) from public, anon, authenticated;
grant execute on function public.seguro_minhas_cotacoes(integer) to authenticated;

-- painel remove o arquivo do material excluído (somente bucket de materiais)
drop policy if exists seguros_materiais_del on storage.objects;
create policy seguros_materiais_del on storage.objects for delete to authenticated
  using (bucket_id = 'seguros-materiais' and seguros.papel_ok('recuperacao', 'admin'));
