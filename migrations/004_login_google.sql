-- Login com Google: colunas necessárias nas tabelas de usuários.
--
-- NÃO é obrigatório rodar: o servidor aplica tudo isto sozinho ao iniciar
-- (server/db.js, garantirEstrutura). Este arquivo existe só para quem prefere
-- aplicar à mão e para documentar o esquema real do banco. Sintaxe MariaDB
-- (ADD COLUMN IF NOT EXISTS); no MySQL puro, remova o "IF NOT EXISTS" e rode
-- uma única vez (se a coluna já existir, o MySQL avisa e você pode ignorar).
-- Faça backup antes.
--
-- Como funciona:
--   - google_id guarda o "sub" do Google: o identificador ESTÁVEL da conta
--     (o e-mail pode mudar; o sub não). UNIQUE impede dois usuários ligados
--     à mesma conta Google. O MySQL aceita vários NULL em coluna UNIQUE, então
--     quem não usa Google não conflita com ninguém.
--   - Contas criadas pelo Google nascem SEM senha e SEM CPF/telefone (pedidos
--     só no 1º chamado/aceite), por isso senha_hash e cpf passam a aceitar NULL.
--     O índice UNIQUE do CPF é preservado pelo MODIFY.

ALTER TABLE clientes    ADD COLUMN IF NOT EXISTS google_id VARCHAR(64) NULL UNIQUE;
ALTER TABLE prestadores ADD COLUMN IF NOT EXISTS google_id VARCHAR(64) NULL UNIQUE;

ALTER TABLE clientes    MODIFY senha_hash TEXT NULL;
ALTER TABLE prestadores MODIFY senha_hash TEXT NULL;

ALTER TABLE clientes    MODIFY cpf VARCHAR(20) NULL;
ALTER TABLE prestadores MODIFY cpf VARCHAR(20) NULL;
