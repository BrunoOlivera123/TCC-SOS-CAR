-- =========================================================
-- Migração 001 — integridade referencial das tabelas do app
-- (categorias, clientes, prestadores, chamados, avaliacoes)
-- =========================================================
-- Bancos criados ANTES desta migração não tinham chaves estrangeiras nem
-- CHECK (só as tabelas antigas do sos_veiculos_mysql.sql tinham). Sem elas,
-- um erro de programação poderia deixar um chamado apontando para um
-- cliente/prestador que não existe, e o banco aceitaria em silêncio.
--
-- Bancos novos já nascem com estas regras (ver server/db.js).
--
-- Antes de aplicar: pare o servidor (ele regrava o banco inteiro a cada
-- alteração) e faça backup. Aplicar só funciona se os dados atuais já
-- respeitam as regras — por isso a análise prévia (0 registros órfãos).
--
-- A ordem de gravação do server/db.js (DELETE dos filhos primeiro, INSERT
-- dos pais primeiro) é compatível com estas chaves.
-- =========================================================

ALTER TABLE prestadores ADD CONSTRAINT fk_prestadores_categoria FOREIGN KEY (categoria_id) REFERENCES categorias(id);

ALTER TABLE chamados ADD CONSTRAINT fk_chamados_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id);
ALTER TABLE chamados ADD CONSTRAINT fk_chamados_prestador FOREIGN KEY (prestador_id) REFERENCES prestadores(id);
ALTER TABLE chamados ADD CONSTRAINT fk_chamados_categoria FOREIGN KEY (categoria_id) REFERENCES categorias(id);
ALTER TABLE chamados ADD CONSTRAINT chk_chamados_status CHECK (status IN ('aberto','aceito','em_andamento','concluido','cancelado'));

ALTER TABLE avaliacoes ADD CONSTRAINT fk_avaliacoes_chamado FOREIGN KEY (chamado_id) REFERENCES chamados(id);
ALTER TABLE avaliacoes ADD CONSTRAINT chk_avaliacoes_nota CHECK (nota BETWEEN 1 AND 5);
