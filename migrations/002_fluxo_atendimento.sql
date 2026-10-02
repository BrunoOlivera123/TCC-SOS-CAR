-- Fluxo de acompanhamento do atendimento (chegada, conclusão, cancelamento
-- pelo prestador com motivo, histórico de eventos).
--
-- NÃO é obrigatório rodar: o servidor aplica tudo isto sozinho ao iniciar
-- (server/db.js, funções garantirColuna/garantirChaveEstrangeira). Este arquivo
-- existe só para quem prefere aplicar à mão. Sintaxe MariaDB (ADD COLUMN IF NOT
-- EXISTS); no MySQL puro, remova o "IF NOT EXISTS" e rode uma única vez.
-- Faça backup antes. Os status (aberto, aceito, em_andamento, concluido,
-- cancelado) não mudam.

ALTER TABLE chamados ADD COLUMN IF NOT EXISTS data_chegada DATETIME NULL;
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS data_cancelamento DATETIME NULL;
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS cancelado_por VARCHAR(20) NULL;
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS motivo_cancelamento VARCHAR(40) NULL;
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS motivo_detalhe VARCHAR(300) NULL;
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS cancelamento_visto BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS chamado_eventos (
  id VARCHAR(36) PRIMARY KEY,
  chamado_id VARCHAR(36) NOT NULL,
  ordem INT NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  ator VARCHAR(20) NOT NULL,
  descricao VARCHAR(255) NOT NULL,
  mensagem VARCHAR(255) NULL,
  detalhe VARCHAR(400) NULL,
  data_evento DATETIME NOT NULL,
  CONSTRAINT fk_eventos_chamado FOREIGN KEY (chamado_id) REFERENCES chamados(id)
);
