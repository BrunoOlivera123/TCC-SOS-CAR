-- Recuperação de senha por código de 6 dígitos enviado por e-mail.
--
-- NÃO é obrigatório rodar: o servidor cria a tabela sozinho ao iniciar
-- (server/db.js, garantirEstrutura). Este arquivo só documenta o esquema.
--
--   - codigo_hash: HMAC-SHA256 do código (chave em CODIGO_REDEFINICAO_SEGREDO).
--     O código em texto puro nunca é gravado.
--   - tentativas: erros de digitação; ao chegar em 5 o código deixa de valer.
--   - usado: código consumido ou invalidado por um pedido mais novo.
--   - Depois de validado o código, o servidor emite um token temporário
--     (10 min) guardado, como HASH, na tabela já existente redefinicoes_senha.

CREATE TABLE IF NOT EXISTS codigos_redefinicao (
  id VARCHAR(36) PRIMARY KEY,
  tipo VARCHAR(20) NOT NULL,
  usuario_id VARCHAR(36) NOT NULL,
  codigo_hash VARCHAR(64) NOT NULL,
  expira_em DATETIME NOT NULL,
  tentativas INT NOT NULL DEFAULT 0,
  usado BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em DATETIME NOT NULL,
  INDEX idx_codigos_redefinicao_usuario (usuario_id),
  INDEX idx_codigos_redefinicao_expira (expira_em),
  INDEX idx_codigos_redefinicao_usado (usado)
);
