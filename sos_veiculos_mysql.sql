-- =========================================================
-- Banco de Dados — Sistema de SOS para Veículos Automotores
-- SGBD: MySQL 8.0+
-- TCC - ETEC - Desenvolvimento de Sistemas
-- (Convertido a partir do script original em T-SQL / SQL Server)
-- =========================================================
-- Este script cria (DDL) as 5 tabelas do sistema, os relacionamentos
-- entre elas (chaves estrangeiras), regras de validação (CHECK) e
-- alguns dados iniciais.
--
-- Entidades: categoria_servico, cliente, prestador, chamado, avaliacao
--
-- ATENÇÃO — este arquivo é o MODELO CONCEITUAL do TCC (tabelas no singular, ids
-- numéricos). O banco que o sistema REALMENTE usa é criado e atualizado
-- automaticamente por server/db.js (tabelas no plural, ids UUID: clientes,
-- prestadores, chamados...), incluindo as colunas mais novas — por exemplo
-- google_id (login com Google), raio_km e a tabela notificacoes. As alterações
-- de esquema ficam documentadas em migrations/ (a 004 cobre o login com Google).
--
-- Regra central do sistema: um chamado é aberto para TODOS os
-- prestadores da categoria certa ao mesmo tempo; o primeiro que aceitar
-- assume o "id_prestador" do chamado (por isso essa coluna começa NULA
-- e só é preenchida no momento do aceite).
--
-- Principais diferenças em relação ao script original de SQL Server:
--   - IDENTITY(1,1)     -> AUTO_INCREMENT
--   - GETDATE()         -> CURRENT_TIMESTAMP
--   - BIT                -> TINYINT(1) (MySQL não tem BOOLEAN nativo,
--                          TINYINT(1) é a convenção padrão; 0 = falso,
--                          1 = verdadeiro)
--   - VARCHAR(MAX)      -> TEXT (MySQL não tem VARCHAR sem limite)
--   - GO (separador de lote do SSMS) -> não existe no MySQL, cada
--     comando termina só com ";"
--   - CHECK só é de fato aplicado a partir do MySQL 8.0.16; em versões
--     anteriores ele é aceito na sintaxe mas ignorado silenciosamente
-- =========================================================

-- Cria (se não existir) e seleciona o banco de dados a ser usado.
-- No MySQL, diferente do SQL Server, as tabelas ficam dentro de um
-- "banco" (schema) que precisa ser explicitamente selecionado com USE.
CREATE DATABASE IF NOT EXISTS sos_car
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    -- utf8mb4 é importante para suportar acentos, emojis e caracteres
    -- especiais corretamente (o utf8 "puro" do MySQL é uma versão
    -- antiga e incompleta do padrão Unicode).

USE sos_car;

-- ---------------------------------------------------------
-- Apaga as tabelas se elas já existirem, para dar pra rodar este
-- script várias vezes sem dar erro. A ORDEM importa: apaga primeiro
-- quem "depende" das outras (quem tem chave estrangeira) e por
-- último quem é "base" (categoria_servico é referenciada por todo o
-- resto).
-- ---------------------------------------------------------
DROP TABLE IF EXISTS redefinicao_senha;
DROP TABLE IF EXISTS avaliacao;
DROP TABLE IF EXISTS chamado;
DROP TABLE IF EXISTS prestador;
DROP TABLE IF EXISTS cliente;
DROP TABLE IF EXISTS categoria_servico;

CREATE TABLE categoria_servico (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    nome    VARCHAR(50) NOT NULL UNIQUE
) ENGINE=InnoDB;
    
-- ---------------------------------------------------------
CREATE TABLE cliente (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nome            VARCHAR(120) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    senha           VARCHAR(255) NOT NULL,
    telefone        VARCHAR(20),
    cpf             VARCHAR(14) NOT NULL UNIQUE,
    data_cadastro   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- TABELA: prestador
-- Guarda o cadastro de quem PRESTA o socorro.
-- ---------------------------------------------------------
CREATE TABLE prestador (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nome            VARCHAR(120) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    senha           VARCHAR(255) NOT NULL,
    telefone        VARCHAR(20),
    cpf             VARCHAR(14) NOT NULL UNIQUE,
    id_categoria    INT NOT NULL,
    disponivel      TINYINT(1) NOT NULL DEFAULT 1,
    latitude        DECIMAL(9,6),
    longitude       DECIMAL(9,6),
    data_cadastro   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_prestador_categoria
        FOREIGN KEY (id_categoria) REFERENCES categoria_servico(id)
) ENGINE=InnoDB;
-- No MySQL é comum (e mais legível) nomear a constraint explicitamente
-- com CONSTRAINT ... FOREIGN KEY, em vez de usar REFERENCES direto na
-- coluna como no T-SQL. Funcionalmente é equivalente.

-- ---------------------------------------------------------
-- TABELA: chamado
-- É o "pedido de socorro" em si.
-- ---------------------------------------------------------
CREATE TABLE chamado (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    id_cliente      INT NOT NULL,
    id_categoria    INT NOT NULL,
    id_prestador    INT NULL,
    latitude        DECIMAL(9,6) NOT NULL,
    longitude       DECIMAL(9,6) NOT NULL,
    endereco        VARCHAR(255),
    descricao       TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'aberto',
    data_abertura   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_aceite     DATETIME NULL,
    data_conclusao  DATETIME NULL,
    CONSTRAINT fk_chamado_cliente
        FOREIGN KEY (id_cliente) REFERENCES cliente(id),
    CONSTRAINT fk_chamado_categoria
        FOREIGN KEY (id_categoria) REFERENCES categoria_servico(id),
    CONSTRAINT fk_chamado_prestador
        FOREIGN KEY (id_prestador) REFERENCES prestador(id),
    CONSTRAINT chk_chamado_status
        CHECK (status IN ('aberto','aceito','em_andamento','concluido','cancelado'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- TABELA: avaliacao
-- Nota e comentário que o cliente dá ao prestador. Relação 1 para 1
-- com "chamado" (garantida pelo UNIQUE em id_chamado).
-- ---------------------------------------------------------
CREATE TABLE avaliacao (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    id_chamado      INT NOT NULL UNIQUE,
    nota            SMALLINT NOT NULL,
    comentario      TEXT,
    data_avaliacao  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_avaliacao_chamado
        FOREIGN KEY (id_chamado) REFERENCES chamado(id),
    CONSTRAINT chk_avaliacao_nota
        CHECK (nota BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- TABELA: redefinicao_senha
-- Token temporário gerado no fluxo "Esqueci minha senha". Como o token
-- pode pertencer a um cliente OU a um prestador, "tipo_usuario" indica
-- qual tabela "id_usuario" referencia — não dá para usar uma única
-- FOREIGN KEY para as duas tabelas ao mesmo tempo, então essa checagem
-- fica por conta da aplicação.
-- ---------------------------------------------------------
CREATE TABLE redefinicao_senha (
    token           VARCHAR(64) PRIMARY KEY,
    tipo_usuario    VARCHAR(20) NOT NULL,
    id_usuario      INT NOT NULL,
    expira_em       DATETIME NOT NULL,
    CONSTRAINT chk_redefinicao_tipo
        CHECK (tipo_usuario IN ('cliente','prestador'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- ÍNDICES
-- Mesma lógica do script original: aceleram as consultas mais
-- frequentes do sistema.
-- ---------------------------------------------------------
CREATE INDEX idx_chamado_status ON chamado(status);
CREATE INDEX idx_chamado_categoria ON chamado(id_categoria);
CREATE INDEX idx_prestador_categoria_disponivel ON prestador(id_categoria, disponivel);

-- ---------------------------------------------------------
-- DADOS INICIAIS (seed)
-- ---------------------------------------------------------
INSERT INTO categoria_servico (nome) VALUES
    ('Mecânico'),
    ('Borracheiro'),
    ('Auto Elétrica'),
    ('Guincho');
