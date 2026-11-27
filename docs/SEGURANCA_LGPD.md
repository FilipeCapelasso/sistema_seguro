# Segurança e LGPD

## Controles

- **Autenticação:** Supabase Auth (e-mail e senha). Conta desativada é bloqueada no login (`ban`) e no banco.
- **Autorização no servidor:** cada função `seguro_*` valida o papel; RLS habilitado em todas as tabelas; ninguém escreve direto em tabela.
- **Isolamento:** perfil obrigatório em `seguros.perfis`. Contas dos outros sistemas no mesmo Supabase não têm acesso e as
  funções de administração só mexem em contas que têm perfil aqui.
- **Arquivos:** bucket privado `seguros-cotacoes` sem nenhuma policy (só `service_role`); leitura por URL assinada de 60 s,
  cada visualização/download vai para a auditoria. Bucket `seguros-materiais` privado, restrito a recuperação/admin.
- **Upload seguro (`seg-upload`):** só JPG/PNG/PDF; confere assinatura real do arquivo (não confia na extensão nem no tipo
  informado), extensão compatível, ≤ 10 MB, bloqueia PDF com JavaScript/ações automáticas, calcula SHA-256, nome gerado no servidor,
  limite de 40 envios por 10 min por usuário. Rejeições ficam na auditoria.
- **Imutabilidade:** cotação original, histórico e auditoria não podem ser alterados nem apagados (gatilhos). A única exceção é a rotina
  de exclusão LGPD (admin), que fica registrada.
- **Segredos:** nenhuma chave secreta no front-end. Só a chave `anon` pública.
- **Navegador:** CSP restritiva (`script-src 'self'`), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`.
  Todo texto vindo do banco é escapado antes de ir para a tela.
- **Primeiro acesso:** código de uso único guardado só como hash; 5 erros em 15 min bloqueiam novas tentativas.

## Avisos do linter do Supabase (esperados)

- `authenticated_security_definer_function_executable` nas funções `seguro_*`: é o desenho do sistema — o navegador só fala com o
  banco por essas funções, e cada uma valida o papel antes de agir. Não há nenhuma executável por `anon`.
- Outros avisos listados no projeto pertencem aos sistemas Honda/maquiagem e não foram tocados. Recomendação (fora deste escopo):
  ativar "leaked password protection" em Auth → Policies, que vale para o projeto inteiro.

## LGPD

- **Finalidade:** recuperar a venda de seguro do cliente que fez a cotação na retirada da moto.
- **Dados tratados:** a cotação enviada (pode ter nome, telefone, dados do veículo), motivo da recusa, histórico de contato.
- **Acesso:** mínimo necessário (meninas não veem dados de clientes depois de enviar), tudo auditado.
- **Contato:** envio de mensagem é sempre manual e individual. A mensagem de primeira abordagem já avisa que o cliente pode pedir para não receber mais contato; quando pedir, registre no histórico e marque como "Recusou novamente".
- **Exclusão:** admin → abrir o cliente → "Excluir cliente definitivamente" apaga cliente, cotação, arquivo e histórico, com motivo registrado na auditoria.
- **Retenção:** defina o prazo da loja (ex.: apagar cotações encerradas após X meses) e use a exclusão acima. Este sistema não apaga nada sozinho.
