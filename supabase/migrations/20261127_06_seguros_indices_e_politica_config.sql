-- =====================================================================
-- Migration 06: índices das chaves estrangeiras do schema seguros e
-- política explícita "ninguém" em seguros.config (acesso só via service_role).
-- Só toca objetos do schema seguros.
-- =====================================================================
create index if not exists clientes_duplicado_de_idx on seguros.clientes (duplicado_de) where duplicado_de is not null;
create index if not exists clientes_visto_por_idx    on seguros.clientes (visto_por)    where visto_por is not null;
create index if not exists historico_usuario_idx     on seguros.historico (usuario_id)  where usuario_id is not null;
create index if not exists materiais_criado_por_idx  on seguros.materiais (criado_por)  where criado_por is not null;
create index if not exists perfis_criado_por_idx     on seguros.perfis (criado_por)     where criado_por is not null;

drop policy if exists config_ninguem on seguros.config;
create policy config_ninguem on seguros.config for all to authenticated using (false) with check (false);
