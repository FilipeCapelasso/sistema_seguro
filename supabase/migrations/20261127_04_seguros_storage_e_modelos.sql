-- =====================================================================
-- Migration 04: buckets privados, políticas de acesso aos arquivos e
-- conteúdo inicial editável (mensagens prontas e uma frase de venda).
--
-- Os buckets são PRIVADOS. seguros-cotacoes não tem NENHUMA policy:
-- só as Edge Functions (service role) gravam e geram URLs assinadas
-- curtas, com auditoria. seguros-materiais é acessível apenas aos
-- papéis recuperacao/admin. As policies abaixo valem somente para
-- os buckets do sistema de seguros e não alteram nenhum outro bucket.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('seguros-cotacoes', 'seguros-cotacoes', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf']),
  ('seguros-materiais', 'seguros-materiais', false, 52428800,
   array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists seguros_materiais_sel on storage.objects;
create policy seguros_materiais_sel on storage.objects for select to authenticated
  using (bucket_id = 'seguros-materiais' and seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists seguros_materiais_ins on storage.objects;
create policy seguros_materiais_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'seguros-materiais' and (storage.foldername(name))[1] = 'materiais'
              and seguros.papel_ok('recuperacao', 'admin'));

drop policy if exists seguros_materiais_del on storage.objects;
create policy seguros_materiais_del on storage.objects for delete to authenticated
  using (bucket_id = 'seguros-materiais' and seguros.papel_ok('recuperacao', 'admin'));

-- ---------------------------------------------------------------------
-- Conteúdo inicial (modelos de texto; nenhum dado de cliente)
-- Variáveis: {primeiro_nome} {nome} {moto} {valor} {seguradora} {atendente}
-- ---------------------------------------------------------------------
insert into seguros.mensagens_modelo (categoria, titulo, texto, ordem)
select v.categoria, v.titulo, v.texto, v.ordem
from (values
  ('primeira_abordagem', 'Primeira abordagem',
   'Olá, {primeiro_nome}! Tudo bem? Aqui é {atendente}, da Star Motos. Na retirada da sua {moto} você chegou a fazer uma cotação de seguro e ficou sem contratar. Posso te ajudar a tirar alguma dúvida ou refazer a cotação com calma? Se preferir não receber mensagens sobre isso, é só me avisar.', 10),
  ('achou_caro', 'Cliente que achou caro',
   'Olá, {primeiro_nome}! Aqui é {atendente}, da Star Motos. Lembrei da cotação de seguro da sua {moto} e entendo que o valor pode ter pesado. Posso verificar outras opções de cobertura e de seguradora para ver se encontramos algo que caiba melhor no seu orçamento, sem compromisso. Quer que eu faça isso?', 20),
  ('vai_pensar', 'Cliente que disse que ia pensar',
   'Oi, {primeiro_nome}, tudo bem? Aqui é {atendente}, da Star Motos. Passando para saber se você já teve tempo de pensar sobre o seguro da sua {moto}. Se ficou alguma dúvida sobre as coberturas ou sobre o valor, me diga que eu explico. Sem pressa e sem compromisso.', 30),
  ('vai_fazer_depois', 'Cliente que ia fazer depois',
   'Olá, {primeiro_nome}! Aqui é {atendente}, da Star Motos. Você comentou que ia contratar o seguro da sua {moto} em outro momento. Se já for um bom momento, posso atualizar a cotação agora mesmo. Posso te ajudar?', 40),
  ('nao_quer', 'Cliente que não quis o seguro',
   'Olá, {primeiro_nome}! Aqui é {atendente}, da Star Motos. Sei que na retirada você decidiu não contratar o seguro e respeito sua decisão. Só quero deixar à disposição: se mudar de ideia, posso refazer a cotação a qualquer momento. Se preferir que eu não entre mais em contato, é só dizer.', 50),
  ('ja_possui', 'Cliente que já possui seguro',
   'Olá, {primeiro_nome}! Aqui é {atendente}, da Star Motos. Vi que você já possui seguro para a {moto}. Que bom que está protegido! Quando chegar a renovação, se quiser comparar valores e coberturas, estou à disposição para fazer uma cotação sem compromisso.', 60),
  ('sem_resposta', 'Cliente que não respondeu',
   'Oi, {primeiro_nome}! Aqui é {atendente}, da Star Motos. Tentei falar com você sobre o seguro da sua {moto} e não consegui retorno. Fico à disposição caso ainda tenha interesse ou dúvidas. Se preferir não receber mais mensagens, é só avisar.', 70),
  ('interesse', 'Cliente que demonstrou interesse',
   'Que ótimo, {primeiro_nome}! Vou preparar a proposta de seguro da sua {moto} com as opções disponíveis. Para finalizar, preciso confirmar alguns dados com você. Pode ser agora?', 80),
  ('coberturas', 'Cliente que quer entender as coberturas',
   'Claro, {primeiro_nome}! Vou te explicar de forma simples. O seguro da sua {moto} pode proteger contra eventos como roubo, furto, colisão e danos a terceiros, conforme as coberturas previstas na apólice. Cada seguradora tem condições próprias, então posso te mostrar o que cada plano cobre e o que fica de fora, para você escolher com segurança. Qual dúvida é a mais importante para você?', 90)
) as v(categoria, titulo, texto, ordem)
where not exists (select 1 from seguros.mensagens_modelo);

insert into seguros.materiais (tipo, titulo, texto, ordem)
select 'frase', 'Conquista e tranquilidade',
       'Sua motocicleta representa uma conquista. Você trabalhou para conseguir esse patrimônio e merece ter tranquilidade para aproveitar essa realização. O seguro pode ajudar a proteger sua conquista contra os imprevistos cobertos pela apólice.', 10
where not exists (select 1 from seguros.materiais);
