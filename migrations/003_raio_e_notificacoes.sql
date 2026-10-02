-- Raio de atendimento próprio do prestador + Central de Notificações.
--
-- NÃO é obrigatório rodar: o servidor aplica tudo isto sozinho ao iniciar
-- (server/db.js, garantirEstrutura). Este arquivo existe só para quem prefere
-- aplicar à mão. Sintaxe MariaDB (ADD COLUMN IF NOT EXISTS); no MySQL puro,
-- remova o "IF NOT EXISTS" do ALTER e rode uma única vez. Faça backup antes.
--
-- O padrão de 15 km é o mesmo que a listagem de chamados já usava antes, então
-- nenhum prestador muda de comportamento até configurar o próprio raio.

ALTER TABLE prestadores ADD COLUMN IF NOT EXISTS raio_km DOUBLE NOT NULL DEFAULT 15;

CREATE TABLE IF NOT EXISTS notificacoes (
  id VARCHAR(36) PRIMARY KEY,
  usuario_tipo VARCHAR(20) NOT NULL,
  usuario_id VARCHAR(36) NOT NULL,
  tipo VARCHAR(40) NOT NULL,
  mensagem VARCHAR(255) NOT NULL,
  chamado_id VARCHAR(36) NULL,
  chave VARCHAR(120) NOT NULL,
  lida BOOLEAN NOT NULL DEFAULT FALSE,
  data_criacao DATETIME NOT NULL,
  data_leitura DATETIME NULL
);

-- Links de redefinição de senha passaram a guardar o HASH (SHA-256) do token.
-- Tokens antigos (guardados em texto) deixam de valer — é esperado: duram 1 hora.
DELETE FROM redefinicoes_senha;
