// =================================================================
// Camada de dados do SOS Car (MySQL).
//
// Como funciona (decisão de projeto do MVP):
//   - Ao iniciar, TODAS as tabelas são carregadas para a memória, no objeto
//     "db" abaixo. As rotas do server.js leem e alteram esse objeto direto.
//   - Depois de cada alteração, as rotas chamam "await salvar()", que grava o
//     estado inteiro no MySQL ("snapshot": apaga e reinsere as tabelas dentro
//     de uma transação). É simples e consistente para o volume de um TCC, mas
//     não escala para muitos usuários — num sistema grande, cada rota faria
//     INSERT/UPDATE só da linha alterada.
//   - Se o MySQL estiver fora do ar na inicialização, entra no MODO DE
//     EMERGÊNCIA: tudo fica só em memória (perde ao reiniciar). O endpoint
//     /health informa em qual modo o sistema está.
//
// Configuração: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (ver .env.example).
// =================================================================
const mysql = require('mysql2/promise');

// Credenciais vêm de variáveis de ambiente (DB_HOST, DB_PORT, DB_USER,
// DB_PASSWORD, DB_NAME). Os valores fixos abaixo são só um fallback para
// não quebrar quem já rodava o projeto sem configurar nada — em produção,
// defina as variáveis de ambiente e, principalmente, troque a senha do
// banco (ela não deveria nunca ter ficado hardcoded/versionada aqui).
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sos_car',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

const db = {
  categorias: [],
  clientes: [],
  prestadores: [],
  chamados: [],
  // Linha do tempo dos chamados (uma linha por mudança importante de status).
  // É dela que saem o histórico do atendimento e as notificações do cliente.
  chamadoEventos: [],
  avaliacoes: [],
  redefinicoesSenha: [],
  // Códigos de 6 dígitos da recuperação de senha (só o HMAC do código é guardado).
  codigosRedefinicao: [],
  // Central de Notificações (cliente e prestador). Cada linha pertence a UM
  // usuário e guarda o estado de leitura — é ele que mantém o contador de
  // "não lidas" correto depois de atualizar a página ou sair e entrar.
  notificacoes: []
};

let pool;
// true = MySQL indisponível na inicialização; tudo fica só em memória. Não
// volta a false sozinho de propósito: gravar o estado em memória (vazio) por
// cima de um banco que não conseguimos ler apagaria os dados reais.
let modoFallback = false;
// Mensagem do último erro ao gravar no MySQL (null = última gravação ok).
let ultimaFalhaPersistencia = null;

// Converte uma data (ISO, Date ou texto) para o formato "AAAA-MM-DD HH:MM:SS" do
// MySQL, usando o horário LOCAL do servidor. Valor vazio vira NULL; um valor que não
// é data válida é devolvido como veio (o MySQL decide se aceita).
function paraDataHoraMysql(valor) {
  if (!valor) return null;

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) {
    return valor;
  }

  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  const horas = String(data.getHours()).padStart(2, '0');
  const minutos = String(data.getMinutes()).padStart(2, '0');
  const segundos = String(data.getSeconds()).padStart(2, '0');

  return `${ano}-${mes}-${dia} ${horas}:${minutos}:${segundos}`;
}

// Estado inicial do MODO DE EMERGÊNCIA: sem MySQL o sistema começa vazio, só com as
// 4 categorias fixas, e guarda tudo em memória (perde ao reiniciar). Liga o
// modoFallback, que também desliga as gravações no banco (ver salvar).
function aplicarEstadoPadrao() {
  db.categorias = [
    { id: 1, nome: 'Mecânico' },
    { id: 2, nome: 'Borracheiro' },
    { id: 3, nome: 'Auto Elétrica' },
    { id: 4, nome: 'Guincho' }
  ];
  db.clientes = [];
  db.prestadores = [];
  db.chamados = [];
  db.chamadoEventos = [];
  db.avaliacoes = [];
  db.redefinicoesSenha = [];
  db.codigosRedefinicao = [];
  db.notificacoes = [];
  modoFallback = true;
}

// Cria o pool de conexões MySQL na primeira chamada e o reutiliza nas seguintes
// (abrir uma conexão nova a cada consulta seria lento).
async function obterPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

// Conecta ao servidor MySQL SEM escolher banco e cria o banco se ainda não existir.
async function criarBancoSeNecessario() {
  const conexaoBase = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    charset: 'utf8mb4'
  });

  try {
    await conexaoBase.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conexaoBase.end();
  }
}

// Adiciona a coluna à tabela só se ela ainda não existir (consulta o
// information_schema). Serve para atualizar bancos criados por versões antigas.
async function garantirColuna(conn, tabela, coluna, definicao) {
  const [linhas] = await conn.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tabela, coluna]
  );
  if (linhas.length === 0) {
    await conn.query(`ALTER TABLE \`${tabela}\` ADD COLUMN \`${coluna}\` ${definicao}`);
  }
}

// Melhor esforço: se a chave estrangeira não puder ser criada (ex.: collations
// diferentes em bancos antigos), avisa no console e segue sem ela — a
// integridade continua garantida pelo código, que só cria eventos de chamados
// que existem.
async function garantirChaveEstrangeira(conn, tabela, nome, coluna, tabelaRef, colunaRef) {
  try {
    const [linhas] = await conn.query(
      'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
      [tabela, nome]
    );
    if (linhas.length > 0) return;
    await conn.query(
      `ALTER TABLE \`${tabela}\` ADD CONSTRAINT \`${nome}\` FOREIGN KEY (\`${coluna}\`) REFERENCES \`${tabelaRef}\`(\`${colunaRef}\`)`
    );
  } catch (erro) {
    console.warn(`Não foi possível criar a chave estrangeira ${nome} (seguindo sem ela):`, erro.message);
  }
}

// Cria o banco, as tabelas e as colunas que faltam. Roda a cada inicialização e é
// IDEMPOTENTE: pode rodar quantas vezes for preciso sem estragar nada.
async function garantirEstrutura() {
  try {
    await criarBancoSeNecessario();
  } catch (erro) {
    // Em hospedagem compartilhada (ex.: Hostinger) o banco já vem criado pelo
    // painel e o usuário não tem permissão de CREATE DATABASE — o erro é
    // esperado e não impede o uso. Se o banco realmente não existir ou o
    // servidor estiver inacessível, a conexão logo abaixo falha com a
    // mensagem certa.
    console.warn(`Não foi possível criar/verificar o banco "${DB_CONFIG.database}" (seguindo com o banco existente):`, erro.message);
  }
  const conn = await obterPool();

  // A ordem importa: cada tabela só pode referenciar (FOREIGN KEY) uma que já
  // foi criada. Bancos que já existiam antes das chaves estrangeiras recebem
  // as mesmas regras por migrations/001_integridade.sql — o IF NOT EXISTS
  // abaixo não altera tabelas antigas.
  const consultas = [
    `CREATE TABLE IF NOT EXISTS categorias (
      id INT PRIMARY KEY,
      nome VARCHAR(100) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS clientes (
      id VARCHAR(36) PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      senha_hash TEXT NULL,
      telefone VARCHAR(50) NULL,
      cpf VARCHAR(20) NULL UNIQUE,
      google_id VARCHAR(64) NULL UNIQUE,
      data_cadastro DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS prestadores (
      id VARCHAR(36) PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      senha_hash TEXT NULL,
      telefone VARCHAR(50) NULL,
      cpf VARCHAR(20) NULL UNIQUE,
      google_id VARCHAR(64) NULL UNIQUE,
      categoria_id INT NOT NULL,
      aprovado BOOLEAN NOT NULL DEFAULT FALSE,
      disponivel BOOLEAN NOT NULL DEFAULT FALSE,
      latitude DOUBLE NULL,
      longitude DOUBLE NULL,
      raio_km DOUBLE NOT NULL DEFAULT 15,
      data_cadastro DATETIME NOT NULL,
      CONSTRAINT fk_prestadores_categoria FOREIGN KEY (categoria_id) REFERENCES categorias(id)
    )`,
    `ALTER TABLE prestadores ADD COLUMN IF NOT EXISTS aprovado BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE TABLE IF NOT EXISTS chamados (
      id VARCHAR(36) PRIMARY KEY,
      cliente_id VARCHAR(36) NOT NULL,
      categoria_id INT NOT NULL,
      prestador_id VARCHAR(36) NULL,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      endereco TEXT NULL,
      descricao TEXT NULL,
      status VARCHAR(50) NOT NULL,
      data_abertura DATETIME NOT NULL,
      data_aceite DATETIME NULL,
      data_chegada DATETIME NULL,
      data_conclusao DATETIME NULL,
      data_cancelamento DATETIME NULL,
      cancelado_por VARCHAR(20) NULL,
      motivo_cancelamento VARCHAR(40) NULL,
      motivo_detalhe VARCHAR(300) NULL,
      cancelamento_visto BOOLEAN NOT NULL DEFAULT FALSE,
      CONSTRAINT fk_chamados_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id),
      CONSTRAINT fk_chamados_prestador FOREIGN KEY (prestador_id) REFERENCES prestadores(id),
      CONSTRAINT fk_chamados_categoria FOREIGN KEY (categoria_id) REFERENCES categorias(id),
      CONSTRAINT chk_chamados_status CHECK (status IN ('aberto','aceito','em_andamento','concluido','cancelado'))
    )`,
    `CREATE TABLE IF NOT EXISTS avaliacoes (
      id VARCHAR(36) PRIMARY KEY,
      chamado_id VARCHAR(36) NOT NULL UNIQUE,
      nota INT NOT NULL,
      comentario TEXT NULL,
      data_avaliacao DATETIME NOT NULL,
      CONSTRAINT fk_avaliacoes_chamado FOREIGN KEY (chamado_id) REFERENCES chamados(id),
      CONSTRAINT chk_avaliacoes_nota CHECK (nota BETWEEN 1 AND 5)
    )`,
    // Sem FOREIGN KEY aqui de propósito: a chave é criada logo depois, em
    // "garantirChaveEstrangeira", de forma tolerante — se o banco antigo tiver
    // outra collation em chamados.id, a criação da chave falharia e derrubaria
    // TODA a inicialização para o modo memória.
    `CREATE TABLE IF NOT EXISTS chamado_eventos (
      id VARCHAR(36) PRIMARY KEY,
      chamado_id VARCHAR(36) NOT NULL,
      ordem INT NOT NULL,
      tipo VARCHAR(30) NOT NULL,
      ator VARCHAR(20) NOT NULL,
      descricao VARCHAR(255) NOT NULL,
      mensagem VARCHAR(255) NULL,
      detalhe VARCHAR(400) NULL,
      data_evento DATETIME NOT NULL
    )`,
    // "token" guarda o HASH (SHA-256, 64 caracteres hexadecimais) do token
    // enviado por e-mail — nunca o token em si. Quem copiar esta tabela não
    // consegue montar um link de redefinição válido.
    `CREATE TABLE IF NOT EXISTS redefinicoes_senha (
      token VARCHAR(64) PRIMARY KEY,
      tipo VARCHAR(20) NOT NULL,
      usuario_id VARCHAR(36) NOT NULL,
      expira_em DATETIME NOT NULL
    )`,
    // Códigos de 6 dígitos da recuperação de senha. "codigo_hash" é um HMAC
    // (nunca o código em si). "tentativas" conta os erros de digitação; "usado"
    // marca códigos já consumidos ou invalidados por um pedido mais novo.
    `CREATE TABLE IF NOT EXISTS codigos_redefinicao (
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
    )`,
    // Sem FOREIGN KEY de propósito (mesmo motivo de chamado_eventos): o estado
    // inteiro é regravado a cada salvar() e a central não pode derrubar a
    // inicialização em bancos antigos. "chave" impede notificação duplicada
    // para o mesmo evento (ex.: "evento:<id>", "novo_chamado:<chamado>:<prestador>").
    `CREATE TABLE IF NOT EXISTS notificacoes (
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
    )`
  ];

  for (const consulta of consultas) {
    await conn.query(consulta);
  }

  // Bancos criados antes do fluxo de acompanhamento não têm estas colunas (o
  // CREATE TABLE IF NOT EXISTS acima não altera tabelas antigas) e, como o
  // snapshot grava todas elas, SEM isto toda gravação falharia com "coluna
  // desconhecida". A checagem é feita no information_schema, e não com
  // "ADD COLUMN IF NOT EXISTS", porque essa sintaxe só existe no MariaDB —
  // assim funciona também no MySQL.
  await garantirColuna(conn, 'chamados', 'data_chegada', 'DATETIME NULL');
  await garantirColuna(conn, 'chamados', 'data_cancelamento', 'DATETIME NULL');
  await garantirColuna(conn, 'chamados', 'cancelado_por', 'VARCHAR(20) NULL');
  await garantirColuna(conn, 'chamados', 'motivo_cancelamento', 'VARCHAR(40) NULL');
  await garantirColuna(conn, 'chamados', 'motivo_detalhe', 'VARCHAR(300) NULL');
  await garantirColuna(conn, 'chamados', 'cancelamento_visto', 'BOOLEAN NOT NULL DEFAULT FALSE');
  // Bancos criados antes do raio de atendimento próprio do prestador. O padrão
  // (15 km) é o mesmo que a listagem de chamados já usava, então ninguém perde
  // nem ganha chamados até configurar o próprio raio.
  await garantirColuna(conn, 'prestadores', 'raio_km', 'DOUBLE NOT NULL DEFAULT 15');
  // Login com Google: a conta nasce sem senha e sem CPF/telefone (pedidos só no
  // momento de fazer/aceitar um chamado). UNIQUE aceita vários NULL no MySQL, e
  // o MODIFY abaixo preserva o índice UNIQUE do CPF já existente.
  for (const tabela of ['clientes', 'prestadores']) {
    await garantirColuna(conn, tabela, 'google_id', 'VARCHAR(64) NULL UNIQUE');
    await conn.query(`ALTER TABLE \`${tabela}\` MODIFY \`senha_hash\` TEXT NULL`);
    await conn.query(`ALTER TABLE \`${tabela}\` MODIFY \`cpf\` VARCHAR(20) NULL`);
  }
  await garantirChaveEstrangeira(conn, 'chamado_eventos', 'fk_eventos_chamado', 'chamado_id', 'chamados', 'id');

  // Sempre reafirma o nome oficial das categorias (id fixo), mesmo que
  // elas já existam — corrige automaticamente qualquer nome gravado antes
  // sem acento/capitalização errada (ex.: "Mecanico", "auto eletrica"),
  // sem duplicar linhas nem afetar chamados/prestadores já vinculados ao
  // mesmo id.
  await conn.query(
    'INSERT INTO categorias (id, nome) VALUES (1, ?), (2, ?), (3, ?), (4, ?) ON DUPLICATE KEY UPDATE nome = VALUES(nome)',
    ['Mecânico', 'Borracheiro', 'Auto Elétrica', 'Guincho']
  );
}

// As funções normalizar* abaixo convertem UMA linha do MySQL (nomes_com_underscore,
// ex.: senha_hash) para o formato usado no código (camelCase, ex.: senhaHash).
function normalizarCliente(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    senhaHash: row.senha_hash ?? null,
    googleId: row.google_id ?? null,
    telefone: row.telefone,
    cpf: row.cpf ?? null,
    dataCadastro: row.data_cadastro
  };
}

// Linha da tabela prestadores -> objeto prestador (inclui aprovação, disponibilidade,
// localização atual e raio de atendimento, com 15 km como padrão se faltar).
function normalizarPrestador(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    senhaHash: row.senha_hash ?? null,
    googleId: row.google_id ?? null,
    telefone: row.telefone,
    cpf: row.cpf ?? null,
    categoriaId: Number(row.categoria_id),
    aprovado: row.aprovado === undefined ? true : !!row.aprovado,
    disponivel: !!row.disponivel,
    latitude: row.latitude,
    longitude: row.longitude,
    raioKm: Number.isFinite(Number(row.raio_km)) && Number(row.raio_km) > 0 ? Number(row.raio_km) : 15,
    dataCadastro: row.data_cadastro
  };
}

// Linha da tabela chamados -> objeto chamado.
function normalizarChamado(row) {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    categoriaId: Number(row.categoria_id),
    prestadorId: row.prestador_id,
    latitude: row.latitude,
    longitude: row.longitude,
    endereco: row.endereco,
    descricao: row.descricao,
    status: row.status,
    dataAbertura: row.data_abertura,
    dataAceite: row.data_aceite,
    dataChegada: row.data_chegada ?? null,
    dataConclusao: row.data_conclusao,
    dataCancelamento: row.data_cancelamento ?? null,
    canceladoPor: row.cancelado_por ?? null,
    motivoCancelamento: row.motivo_cancelamento ?? null,
    motivoDetalhe: row.motivo_detalhe ?? null,
    cancelamentoVisto: !!row.cancelamento_visto
  };
}

// Linha da tabela chamado_eventos (linha do tempo do atendimento) -> objeto evento.
function normalizarEvento(row) {
  return {
    id: row.id,
    chamadoId: row.chamado_id,
    tipo: row.tipo,
    ator: row.ator,
    descricao: row.descricao,
    mensagem: row.mensagem ?? null,
    detalhe: row.detalhe ?? null,
    data: row.data_evento
  };
}

// Linha da tabela avaliacoes -> objeto avaliação (nota de 1 a 5 e comentário).
function normalizarAvaliacao(row) {
  return {
    id: row.id,
    chamadoId: row.chamado_id,
    nota: row.nota,
    comentario: row.comentario,
    dataAvaliacao: row.data_avaliacao
  };
}

// Linha da tabela redefinicoes_senha -> objeto. O campo "token" guarda só o HASH
// do token enviado por e-mail, nunca o token utilizável.
function normalizarRedefinicao(row) {
  return {
    token: row.token,
    tipo: row.tipo,
    usuarioId: row.usuario_id,
    expiraEm: row.expira_em
  };
}

// Linha da tabela codigos_redefinicao -> objeto. "codigoHash" é o HMAC do
// código, nunca o código utilizável.
function normalizarCodigoRedefinicao(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    usuarioId: row.usuario_id,
    codigoHash: row.codigo_hash,
    expiraEm: row.expira_em,
    tentativas: Number(row.tentativas) || 0,
    usado: !!row.usado,
    criadoEm: row.criado_em
  };
}

// Linha da tabela notificacoes (Central de Notificações) -> objeto notificação.
function normalizarNotificacao(row) {
  return {
    id: row.id,
    usuarioTipo: row.usuario_tipo,
    usuarioId: row.usuario_id,
    tipo: row.tipo,
    mensagem: row.mensagem,
    chamadoId: row.chamado_id ?? null,
    chave: row.chave,
    lida: !!row.lida,
    dataCriacao: row.data_criacao,
    dataLeitura: row.data_leitura ?? null
  };
}

// Carrega TODAS as tabelas do MySQL para a memória (o objeto "db") ao iniciar. Se o
// banco estiver inacessível, cai no modo de emergência (aplicarEstadoPadrao).
async function carregar() {
  try {
    await garantirEstrutura();
    const conn = await obterPool();

    const [categorias] = await conn.query('SELECT * FROM categorias ORDER BY id');
    const [clientes] = await conn.query('SELECT * FROM clientes ORDER BY data_cadastro');
    const [prestadores] = await conn.query('SELECT * FROM prestadores ORDER BY data_cadastro');
    const [chamados] = await conn.query('SELECT * FROM chamados ORDER BY data_abertura');
    const [eventos] = await conn.query('SELECT * FROM chamado_eventos ORDER BY ordem');
    const [avaliacoes] = await conn.query('SELECT * FROM avaliacoes ORDER BY data_avaliacao');
    const [redefinicoes] = await conn.query('SELECT * FROM redefinicoes_senha');
    const [codigosRedef] = await conn.query('SELECT * FROM codigos_redefinicao');
    const [notificacoes] = await conn.query('SELECT * FROM notificacoes ORDER BY data_criacao');

    modoFallback = false;
    const agora = new Date();
    Object.assign(db, {
      categorias: categorias.map((categoria) => ({
        ...categoria,
        id: Number(categoria.id)
      })),
      clientes: clientes.map(normalizarCliente),
      prestadores: prestadores.map(normalizarPrestador),
      chamados: chamados.map(normalizarChamado),
      chamadoEventos: eventos.map(normalizarEvento),
      avaliacoes: avaliacoes.map(normalizarAvaliacao),
      // Tokens vencidos são descartados aqui (e somem do banco na próxima
      // gravação). O filtro é feito em JS, não com NOW() no SQL, porque o
      // fuso horário do servidor MySQL pode ser diferente do fuso do Node,
      // que é quem grava as datas.
      redefinicoesSenha: redefinicoes.map(normalizarRedefinicao).filter((r) => new Date(r.expiraEm) > agora),
      // Códigos ficam até 1 h após o pedido (para contar os reenvios por hora).
      codigosRedefinicao: codigosRedef
        .map(normalizarCodigoRedefinicao)
        .filter((c) => agora - new Date(c.criadoEm).getTime() < 60 * 60 * 1000),
      notificacoes: notificacoes.map(normalizarNotificacao)
    });

    return db;
  } catch (erro) {
    console.warn('MySQL indisponível. Usando armazenamento em memória para manter a aplicação aberta.', erro.message);
    aplicarEstadoPadrao();
    return db;
  }
}

// Grava o estado inteiro de "db" no MySQL (DELETE + INSERT de tudo, dentro
// de uma transação). Não lança erro: se falhar, registra o motivo e os dados
// seguem em memória — como cada gravação é um retrato completo do estado, a
// próxima que der certo já recupera tudo o que ficou para trás.
async function gravarSnapshot() {
  let conn;
  try {
    // A transação precisa ficar presa a UMA conexão. Com pool.query(), cada
    // comando pode cair numa conexão diferente, e o START TRANSACTION /
    // COMMIT não valeria para os demais.
    conn = await (await obterPool()).getConnection();
    await conn.beginTransaction();

    try {
      await conn.query('DELETE FROM redefinicoes_senha');
      await conn.query('DELETE FROM codigos_redefinicao');
      await conn.query('DELETE FROM notificacoes');
      await conn.query('DELETE FROM avaliacoes');
      await conn.query('DELETE FROM chamado_eventos');
      await conn.query('DELETE FROM chamados');
      await conn.query('DELETE FROM prestadores');
      await conn.query('DELETE FROM clientes');
      await conn.query('DELETE FROM categorias');

      if (Array.isArray(db.categorias) && db.categorias.length > 0) {
        for (const categoria of db.categorias) {
          await conn.query('INSERT INTO categorias (id, nome) VALUES (?, ?)', [categoria.id, categoria.nome]);
        }
      }

      if (Array.isArray(db.clientes) && db.clientes.length > 0) {
        for (const cliente of db.clientes) {
          await conn.query(
            'INSERT INTO clientes (id, nome, email, senha_hash, google_id, telefone, cpf, data_cadastro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [cliente.id, cliente.nome, cliente.email, cliente.senhaHash ?? null, cliente.googleId ?? null, cliente.telefone ?? null, cliente.cpf ?? null, paraDataHoraMysql(cliente.dataCadastro)]
          );
        }
      }

      if (Array.isArray(db.prestadores) && db.prestadores.length > 0) {
        for (const prestador of db.prestadores) {
          await conn.query(
            'INSERT INTO prestadores (id, nome, email, senha_hash, google_id, telefone, cpf, categoria_id, aprovado, disponivel, latitude, longitude, raio_km, data_cadastro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [prestador.id, prestador.nome, prestador.email, prestador.senhaHash ?? null, prestador.googleId ?? null, prestador.telefone ?? null, prestador.cpf ?? null, prestador.categoriaId, prestador.aprovado !== undefined ? !!prestador.aprovado : true, !!prestador.disponivel, prestador.latitude ?? null, prestador.longitude ?? null, prestador.raioKm ?? 15, paraDataHoraMysql(prestador.dataCadastro)]
          );
        }
      }

      if (Array.isArray(db.chamados) && db.chamados.length > 0) {
        for (const chamado of db.chamados) {
          await conn.query(
            'INSERT INTO chamados (id, cliente_id, categoria_id, prestador_id, latitude, longitude, endereco, descricao, status, data_abertura, data_aceite, data_chegada, data_conclusao, data_cancelamento, cancelado_por, motivo_cancelamento, motivo_detalhe, cancelamento_visto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              chamado.id,
              chamado.clienteId,
              chamado.categoriaId,
              chamado.prestadorId,
              chamado.latitude,
              chamado.longitude,
              chamado.endereco ?? null,
              chamado.descricao ?? null,
              chamado.status,
              paraDataHoraMysql(chamado.dataAbertura),
              paraDataHoraMysql(chamado.dataAceite),
              paraDataHoraMysql(chamado.dataChegada),
              paraDataHoraMysql(chamado.dataConclusao),
              paraDataHoraMysql(chamado.dataCancelamento),
              chamado.canceladoPor ?? null,
              chamado.motivoCancelamento ?? null,
              chamado.motivoDetalhe ?? null,
              !!chamado.cancelamentoVisto
            ]
          );
        }
      }

      // Eventos vêm depois dos chamados (a chave estrangeira aponta para eles).
      // "ordem" preserva a sequência real mesmo quando dois eventos caem no
      // mesmo segundo (ex.: "aceitou" e "a caminho" no aceite).
      if (Array.isArray(db.chamadoEventos) && db.chamadoEventos.length > 0) {
        let ordem = 0;
        for (const evento of db.chamadoEventos) {
          await conn.query(
            'INSERT INTO chamado_eventos (id, chamado_id, ordem, tipo, ator, descricao, mensagem, detalhe, data_evento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [evento.id, evento.chamadoId, ordem++, evento.tipo, evento.ator, evento.descricao, evento.mensagem ?? null, evento.detalhe ?? null, paraDataHoraMysql(evento.data)]
          );
        }
      }

      if (Array.isArray(db.avaliacoes) && db.avaliacoes.length > 0) {
        for (const avaliacao of db.avaliacoes) {
          await conn.query(
            'INSERT INTO avaliacoes (id, chamado_id, nota, comentario, data_avaliacao) VALUES (?, ?, ?, ?, ?)',
            [avaliacao.id, avaliacao.chamadoId, avaliacao.nota, avaliacao.comentario ?? null, paraDataHoraMysql(avaliacao.dataAvaliacao)]
          );
        }
      }

      if (Array.isArray(db.redefinicoesSenha) && db.redefinicoesSenha.length > 0) {
        for (const redefinicao of db.redefinicoesSenha) {
          await conn.query(
            'INSERT INTO redefinicoes_senha (token, tipo, usuario_id, expira_em) VALUES (?, ?, ?, ?)',
            [redefinicao.token, redefinicao.tipo, redefinicao.usuarioId, paraDataHoraMysql(redefinicao.expiraEm)]
          );
        }
      }

      if (Array.isArray(db.codigosRedefinicao) && db.codigosRedefinicao.length > 0) {
        for (const c of db.codigosRedefinicao) {
          await conn.query(
            'INSERT INTO codigos_redefinicao (id, tipo, usuario_id, codigo_hash, expira_em, tentativas, usado, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [c.id, c.tipo, c.usuarioId, c.codigoHash, paraDataHoraMysql(c.expiraEm), c.tentativas || 0, !!c.usado, paraDataHoraMysql(c.criadoEm)]
          );
        }
      }

      if (Array.isArray(db.notificacoes) && db.notificacoes.length > 0) {
        for (const n of db.notificacoes) {
          await conn.query(
            'INSERT INTO notificacoes (id, usuario_tipo, usuario_id, tipo, mensagem, chamado_id, chave, lida, data_criacao, data_leitura) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [n.id, n.usuarioTipo, n.usuarioId, n.tipo, n.mensagem, n.chamadoId ?? null, n.chave, !!n.lida, paraDataHoraMysql(n.dataCriacao), paraDataHoraMysql(n.dataLeitura)]
          );
        }
      }

      await conn.commit();
    } catch (erro) {
      await conn.rollback().catch(() => {});
      throw erro;
    }
    ultimaFalhaPersistencia = null;
  } catch (erro) {
    ultimaFalhaPersistencia = erro.message;
    console.error(
      'Falha ao gravar no MySQL. Os dados seguem em memória e serão gravados de novo na próxima alteração:',
      erro.message
    );
  } finally {
    if (conn) conn.release();
  }
  return db;
}

let gravacaoEmAndamento = null;
let gravacaoPendente = null;

// Ponto de entrada das rotas ("await salvar()"). Duas gravações ao mesmo
// tempo — DELETE + INSERT de todas as tabelas em transações concorrentes —
// podem se bloquear (deadlock) no MySQL. Por isso: no máximo uma roda por
// vez, e todos os pedidos que chegam durante ela são agrupados numa única
// gravação seguinte (que já enxerga todas as alterações feitas até ali).
function salvar() {
  if (modoFallback) return Promise.resolve(db);

  if (!gravacaoEmAndamento) {
    gravacaoEmAndamento = gravarSnapshot().finally(() => {
      gravacaoEmAndamento = null;
    });
    return gravacaoEmAndamento;
  }

  if (!gravacaoPendente) {
    gravacaoPendente = gravacaoEmAndamento.then(() => {
      gravacaoPendente = null;
      return salvar();
    });
  }
  return gravacaoPendente;
}

// Estado do armazenamento, para o /health: "mysql" ou "memoria" (fallback),
// e a mensagem do último erro de gravação (null se está tudo certo).
function estadoPersistencia() {
  return {
    armazenamento: modoFallback ? 'memoria' : 'mysql',
    ultimaFalha: ultimaFalhaPersistencia
  };
}

// Ponto de entrada chamado pelo server.js ao iniciar o sistema.
async function inicializarBanco() {
  return carregar();
}

// Verifica se o banco responde (SELECT 1). Devolve true/false e nunca lança erro.
async function testarConexao() {
  try {
    const conn = await obterPool();
    const [resultado] = await conn.query('SELECT 1 AS ok');
    return resultado[0]?.ok === 1;
  } catch (erro) {
    return false;
  }
}

module.exports = { db, salvar, inicializarBanco, testarConexao, estadoPersistencia };
