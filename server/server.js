// =================================================================
// API do SOS Car — servidor Express (Node.js).
//
// Este arquivo define todas as rotas HTTP da aplicação: cadastro/login,
// abertura de chamados, aceite por prestadores, andamento do
// atendimento e avaliação. As regras de negócio do TCC (o modelo de
// dados está documentado em sos_veiculos_mysql.sql, na raiz do projeto)
// são implementadas aqui, na camada da API — o db.js só cuida de
// carregar/gravar esses dados no MySQL.
// =================================================================
const express = require('express');
const path = require('path');
// O caminho é explícito para o .env ser encontrado mesmo que o servidor seja
// iniciado de outra pasta (o padrão do dotenv é a pasta atual do terminal).
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const os = require('os');
const fs = require('fs');
const https = require('https');
const selfsigned = require('selfsigned');

const { db, salvar, inicializarBanco, estadoPersistencia } = require('./db');
const { criarSessao, encerrarSessao, encerrarSessoesDoUsuario, autenticar } = require('./auth-middleware');
const { distanciaKm } = require('./utils/distancia');
const { enviarEmailRedefinicao } = require('./email');
const { geocodificar, reverseGeocodificar } = require('./geocodificacao');
// Verificação local do ID token do Google + nonce de uso único (ver google-auth.js).
const { verificarIdToken, gerarNonce, consumirNonce } = require('./google-auth');
// Validação de CPF pelos dígitos verificadores (ver utils/cpf.js).
const { cpfValido } = require('./utils/cpf');

const app = express();
const PORTA = process.env.PORT || 3000;

// ---------------------------------------------------------------
// Proxy reverso (TRUST_PROXY)
//
// Atrás de um proxy (Nginx, Cloudflare, painel da hospedagem), o IP que o
// Express enxerga é o do PROXY — o mesmo para todo mundo. Como o limitador de
// tentativas (limitarRequisicoes) conta por IP, todos os usuários passariam a
// dividir o mesmo limite e bastaria uma pessoa para bloquear o site inteiro.
// Com TRUST_PROXY o Express passa a ler o IP real em X-Forwarded-For.
//
//   TRUST_PROXY=1          -> confia em 1 proxy à frente (o caso mais comum)
//   TRUST_PROXY=2          -> confia em 2 proxies (ex.: Cloudflare + Nginx)
//   TRUST_PROXY=loopback   -> confia só em proxy na mesma máquina
//   (vazio)                -> sem proxy: usa o IP da conexão (padrão)
//
// NÃO ative sem proxy: qualquer cliente poderia forjar X-Forwarded-For e
// escapar do limite de tentativas.
// ---------------------------------------------------------------
if (process.env.TRUST_PROXY) {
  const valor = process.env.TRUST_PROXY.trim();
  // "1", "2"... viram número (quantos proxies); "true"/"false" viram booleano;
  // qualquer outro texto (ex.: "loopback") é repassado como está ao Express.
  app.set('trust proxy', /^\d+$/.test(valor) ? Number(valor) : valor === 'true' ? true : valor === 'false' ? false : valor);
}

// O Express 4 não captura erros de handlers "async": uma Promise rejeitada
// vira "unhandled rejection", que derruba o processo do Node (ou deixa a
// requisição pendurada). Este wrapper repassa o erro para o middleware de
// erro registrado no fim do arquivo, que responde 500 em JSON.
const assincrono = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Chamados que ainda não terminaram (ciclo de vida: aberto -> aceito ->
// em_andamento -> concluido/cancelado).
const STATUS_ATIVOS = ['aberto', 'aceito', 'em_andamento'];

// ---------------------------------------------------------------
// Fluxo de acompanhamento do atendimento
//
// Os status do banco continuam os mesmos (não há status novo):
//   aberto       -> "Chamado solicitado"
//   aceito       -> "Prestador aceitou / a caminho"  (aceitar já significa ir até o cliente)
//   em_andamento -> "Prestador chegou ao local / atendimento em andamento"
//   concluido / cancelado
// O que muda entre "chegou" e "em andamento", por exemplo, fica registrado na
// linha do tempo (chamadoEventos) e em data_chegada.
// ---------------------------------------------------------------

// Transições que o PRESTADOR pode fazer. A validação é sempre feita aqui, no
// servidor — o frontend só esconde botões, não é a barreira de segurança.
const ACOES_PRESTADOR = {
  chegar: { de: ['aceito'], para: 'em_andamento' },
  concluir: { de: ['em_andamento'], para: 'concluido' },
  cancelar: { de: ['aceito', 'em_andamento'], para: 'cancelado' }
};

// Motivos de cancelamento pelo prestador (não havia nenhuma estrutura de
// motivos no projeto). O código vai para o banco; o texto aparece na tela.
const MOTIVOS_CANCELAMENTO = {
  nao_consegui_chegar: 'Não consegui chegar ao local',
  problema_veiculo: 'Problema no veículo/equipamento',
  cliente_ausente: 'Cliente não estava no local',
  servico_impossivel: 'Serviço não pode ser realizado',
  outro: 'Outro'
};
const MOTIVO_DETALHE_MAX = 300;

// Texto da notificação que o CLIENTE recebe em cada mudança importante. A
// notificação é o campo "mensagem" do evento da linha do tempo, exibida pelo
// toast que o frontend já tinha — não existe um segundo sistema de avisos.
const NOTIFICACOES = {
  aceito: '✅ Um prestador aceitou seu chamado.',
  a_caminho: '🚗 O prestador está a caminho.',
  chegou: '📍 O prestador chegou ao local.',
  concluido: '✅ O atendimento foi concluído.',
  cancelado_prestador: '⚠️ O atendimento foi cancelado pelo prestador.',
  cancelado_admin: '⚠️ O atendimento foi cancelado pela administração.'
};

// Acrescenta um evento à linha do tempo do chamado. Não grava no banco: quem
// chama faz "await salvar()" logo depois, junto com a mudança de status, para
// os dois irem juntos no mesmo snapshot.
function registrarEvento(chamado, tipo, ator, { descricao, mensagem = null, detalhe = null, data = paraIso() }) {
  const evento = { id: crypto.randomUUID(), chamadoId: chamado.id, tipo, ator, descricao, mensagem, detalhe, data };
  db.chamadoEventos.push(evento);
  // Central de Notificações: todo evento que já tinha "mensagem" (o aviso que o
  // cliente via em toast) passa a ser também uma notificação persistida, com
  // estado de leitura. A "chave" é o id do evento: o mesmo evento nunca gera
  // duas notificações, e não existe um segundo caminho paralelo de avisos.
  if (mensagem) {
    criarNotificacao('cliente', chamado.clienteId, tipo, mensagem, chamado.id, `evento:${evento.id}`);
  }
  return evento;
}

// ---------------------------------------------------------------
// Central de Notificações
//
// Uma notificação pertence a UM usuário (tipo + id) e guarda se já foi lida.
// Fica em db.notificacoes e é gravada no mesmo snapshot do restante do estado.
// ---------------------------------------------------------------
const NOTIFICACOES_MAX_POR_USUARIO = 100;

// Cria a notificação, exceto se já existir uma com a mesma "chave" para o mesmo
// usuário (evita duplicar o aviso de um mesmo evento). Não grava no banco:
// quem chama faz "await salvar()" junto com a mudança que a originou.
function criarNotificacao(usuarioTipo, usuarioId, tipo, mensagem, chamadoId, chave) {
  if (!usuarioId) return null;
  const jaExiste = db.notificacoes.some(
    (n) => n.chave === chave && n.usuarioId === usuarioId && n.usuarioTipo === usuarioTipo
  );
  if (jaExiste) return null;

  const notificacao = {
    id: crypto.randomUUID(),
    usuarioTipo,
    usuarioId,
    tipo,
    mensagem: String(mensagem).slice(0, 255),
    chamadoId: chamadoId || null,
    chave,
    lida: false,
    dataCriacao: paraIso(),
    dataLeitura: null
  };
  db.notificacoes.push(notificacao);

  // Limite por usuário: a gravação regrava o estado inteiro, então a lista não
  // pode crescer sem fim. Descarta primeiro as mais antigas JÁ LIDAS.
  const minhas = db.notificacoes.filter((n) => n.usuarioTipo === usuarioTipo && n.usuarioId === usuarioId);
  if (minhas.length > NOTIFICACOES_MAX_POR_USUARIO) {
    const descartar = new Set(
      [...minhas]
        .sort((a, b) => (a.lida === b.lida ? new Date(a.dataCriacao) - new Date(b.dataCriacao) : a.lida ? -1 : 1))
        .slice(0, minhas.length - NOTIFICACOES_MAX_POR_USUARIO)
        .map((n) => n.id)
    );
    db.notificacoes = db.notificacoes.filter((n) => !descartar.has(n.id));
  }
  return notificacao;
}

// Formato enviado ao navegador: sem usuarioId/chave (detalhes internos).
function notificacaoPublica(n) {
  return { id: n.id, tipo: n.tipo, mensagem: n.mensagem, chamadoId: n.chamadoId, lida: !!n.lida, dataCriacao: n.dataCriacao };
}

// Notificações do usuário logado (a sessão informa o tipo e o id dele).
function notificacoesDoUsuario(req) {
  return db.notificacoes.filter((n) => n.usuarioTipo === req.sessao.tipo && n.usuarioId === req.sessao.id);
}

// Formata km para o texto das notificações (2,8 km).
function textoKm(km) {
  return `${(Math.round(km * 10) / 10).toFixed(1).replace('.', ',')} km`;
}

// Avisa os prestadores para os quais o chamado recém-aberto é realmente
// compatível: aprovados, disponíveis, da categoria certa, sem atendimento em
// curso e com distância CALCULÁVEL dentro do raio configurado por eles. Sem
// localização conhecida, o prestador não é avisado (nunca se presume "dentro").
function notificarPrestadoresDoNovoChamado(chamado) {
  for (const prestador of db.prestadores) {
    if (prestador.aprovado !== true || !prestador.disponivel) continue;
    if (Number(prestador.categoriaId) !== Number(chamado.categoriaId)) continue;
    if (db.chamados.some((c) => c.prestadorId === prestador.id && STATUS_ATIVOS.includes(c.status))) continue;
    const km = distanciaKm(prestador.latitude, prestador.longitude, chamado.latitude, chamado.longitude);
    if (km === null || km > raioDoPrestador(prestador)) continue;
    criarNotificacao(
      'prestador',
      prestador.id,
      'novo_chamado',
      `🚗 Novo chamado disponível a ${textoKm(km)}.`,
      chamado.id,
      `novo_chamado:${chamado.id}:${prestador.id}`
    );
  }
}

// Mensagem de erro (409) específica para cada situação em que a ação do
// prestador não cabe no status atual do chamado.
function mensagemAcaoInvalida(chamado, acao) {
  if (chamado.status === 'concluido') {
    return acao === 'concluir'
      ? 'Este atendimento já foi concluído.'
      : 'Este atendimento já foi concluído e não pode mais ser alterado.';
  }
  if (chamado.status === 'cancelado') {
    return 'Este atendimento foi cancelado e não pode mais ser alterado.';
  }
  if (acao === 'chegar' && chamado.status === 'em_andamento') {
    return 'Você já marcou que chegou ao local.';
  }
  if (acao === 'concluir' && chamado.status === 'aceito') {
    return 'Marque "Cheguei ao local" antes de concluir o atendimento.';
  }
  return 'Esta ação não está disponível para o status atual do chamado.';
}

// Confere, para uma ação do prestador: (1) o chamado existe e é DELE, (2) o
// status atual permite a ação. Se algo falhar, já responde o erro e devolve
// null; senão devolve o chamado. Não há "await" aqui: checar e alterar o status
// acontecem no mesmo trecho síncrono do handler, então dois cliques quase
// simultâneos nunca passam juntos pela validação (o segundo já vê o status novo).
function validarAcaoPrestador(req, res, acao) {
  const chamado = pegarChamadoDoPrestador(req);
  if (!chamado) {
    res.status(404).json({ erro: 'Chamado não encontrado ou não vinculado a você.' });
    return null;
  }
  if (!ACOES_PRESTADOR[acao].de.includes(chamado.status)) {
    res.status(409).json({ erro: mensagemAcaoInvalida(chamado, acao) });
    return null;
  }
  return chamado;
}

const limites = new Map();
// Limitador de tentativas, em memória: no máximo "maximo" requisições por
// "janelaMs" para cada combinação IP + rota. Passou disso, responde 429. É o que
// protege login, cadastro e redefinição de senha contra tentativas em massa.
// Atrás de proxy, o IP só é o do usuário se TRUST_PROXY estiver configurado.
function limitarRequisicoes(janelaMs, maximo) {
  return (req, res, next) => {
    const chave = `${req.ip}:${req.path}`;
    const agora = Date.now();
    const atual = limites.get(chave);
    if (!atual || agora - atual.inicio >= janelaMs) {
      limites.set(chave, { inicio: agora, total: 1, janelaMs });
      return next();
    }
    if (atual.total >= maximo) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde e tente novamente.' });
    }
    atual.total += 1;
    next();
  };
}
// Descarta contadores vencidos; sem isso o Map cresceria para sempre (um
// item por IP + rota já usados).
setInterval(() => {
  const agora = Date.now();
  for (const [chave, atual] of limites) {
    if (agora - atual.inicio >= atual.janelaMs) limites.delete(chave);
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------
// Auditoria de autenticação
//
// Uma linha JSON por evento importante (login Google, vínculo de conta,
// falhas). Facilita investigar abuso. Nunca registra token, senha nem e-mail
// completo: só o tipo de conta, o id interno do usuário, o IP e o motivo.
// ---------------------------------------------------------------
function auditar(evento, { req, tipo, usuarioId, motivo } = {}) {
  console.log(
    `[auth] ${JSON.stringify({ quando: new Date().toISOString(), evento, tipo, usuarioId, ip: req && req.ip, motivo })}`
  );
}

// Conta única de administrador, sem tela pública de cadastro — só existe
// via estas duas variáveis de ambiente. Os valores abaixo são apenas um
// fallback para não travar quem sobe o projeto sem configurar nada (igual
// ao espírito do fallback de banco em server/db.js): troque-os em
// produção definindo ADMIN_EMAIL/ADMIN_SENHA antes de rodar `npm start`.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@soscar.com';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'admin123';
const ADMIN_SENHA_HASH = process.env.ADMIN_SENHA_HASH || bcrypt.hashSync(ADMIN_SENHA, 10);
if (!process.env.ADMIN_EMAIL || (!process.env.ADMIN_SENHA && !process.env.ADMIN_SENHA_HASH)) {
  console.warn(
    `Usando credenciais padrão de administrador (${ADMIN_EMAIL} / ${ADMIN_SENHA}). Defina ADMIN_EMAIL e ADMIN_SENHA antes de usar em produção.`
  );
}

// Datas ficam em memória — e vão para o navegador — como ISO 8601 em UTC
// ("2026-09-18T18:01:52.000Z"), que identifica um instante sem ambiguidade.
// O formato "AAAA-MM-DD HH:MM:SS" do MySQL não tem fuso: o navegador o
// interpretaria no horário DELE, errando horas quando servidor e cliente
// estão em fusos diferentes (e o Safari nem consegue ler esse formato). A
// conversão para o formato do MySQL é feita só ao gravar (ver server/db.js).
function paraIso(valor = new Date()) {
  return new Date(valor).toISOString();
}

// Validações de entrada do cadastro e da troca de senha.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENHA_MINIMA = 4;
const SENHA_MAXIMA = 72; // o bcrypt só considera os 72 primeiros bytes da senha

// Remove tudo que não for dígito ("529.982.247-25" -> "52998224725").
function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

// Devolve a mensagem de erro (ou null se a senha é aceitável).
function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < SENHA_MINIMA) {
    return `A senha deve ter pelo menos ${SENHA_MINIMA} caracteres.`;
  }
  if (senha.length > SENHA_MAXIMA) {
    return `A senha deve ter no máximo ${SENHA_MAXIMA} caracteres.`;
  }
  return null;
}

// ---------------------------------------------------------------
// Raio de atendimento do prestador (km). Antes existia só como um padrão fixo de
// 15 km na listagem de chamados; agora cada prestador tem o seu, guardado no
// banco (prestadores.raio_km). O padrão continua 15 km.
// ---------------------------------------------------------------
const RAIO_PADRAO_KM = 15;
const RAIO_MIN_KM = 1;
const RAIO_MAX_KM = 100;

// Só aceita número de verdade (texto, NaN, Infinity, null, negativo, zero e
// valores fora de 1–100 km são recusados) e arredonda para 1 casa decimal.
function validarRaioKm(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    return { ok: false, erro: 'Informe o raio de atendimento como um número (em km).' };
  }
  if (valor < RAIO_MIN_KM || valor > RAIO_MAX_KM) {
    return { ok: false, erro: `O raio de atendimento deve ficar entre ${RAIO_MIN_KM} e ${RAIO_MAX_KM} km.` };
  }
  return { ok: true, valor: Math.round(valor * 10) / 10 };
}

// Raio efetivo do prestador: o configurado, ou o padrão se o dado estiver
// ausente/inválido (registros antigos). Nunca devolve valor fora dos limites.
function raioDoPrestador(prestador) {
  const r = validarRaioKm(prestador?.raioKm);
  return r.ok ? r.valor : RAIO_PADRAO_KM;
}

// ---------------------------------------------------------------
// Redefinição de senha: o token enviado por e-mail é aleatório (256 bits) e só
// o seu HASH (SHA-256) é guardado — no banco ou na memória nunca existe um
// token utilizável. Vale 1 hora e é de uso único.
// ---------------------------------------------------------------
const TOKEN_REDEFINICAO_TTL_MS = 60 * 60 * 1000;
const INTERVALO_MIN_NOVO_TOKEN_MS = 60 * 1000; // no máximo 1 e-mail por conta por minuto
const MENSAGEM_ESQUECI_SENHA = 'Se o email estiver cadastrado, você receberá um link para redefinição.';
const ERRO_LINK_INVALIDO = 'Link de redefinição inválido ou expirado. Peça um novo.';

// Calcula o SHA-256 do token de redefinição. Só esse hash é guardado: quem lê o
// banco ou o log não consegue usar o token para trocar a senha de ninguém.
function hashTokenRedefinicao(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Formato esperado do token (hex de 64 caracteres).
// Evita calcular hash de entradas gigantes/estranhas.
function tokenRedefinicaoComFormatoValido(token) {
  return typeof token === 'string' && token.length >= 20 && token.length <= 128 && /^[A-Za-z0-9-]+$/.test(token);
}

// ---------------------------------------------------------------
// Login com Google (Google Identity Services)
//
// O navegador recebe do Google um "ID token" (credential) e o envia para cá. A
// confiança está TODA no servidor: a assinatura do token é conferida
// localmente com as chaves públicas do Google (ver google-auth.js) e ele só é
// aceito se foi emitido para o NOSSO Client ID, por um emissor do Google, ainda
// dentro da validade, com e-mail verificado e com um nonce nosso, de uso único.
// Sem GOOGLE_CLIENT_ID configurado, o recurso fica desligado.
//
// Variáveis de ambiente:
//   GOOGLE_CLIENT_ID          (obrigatória para ligar o recurso)
//   GOOGLE_DOMINIO_PERMITIDO  (opcional: aceita só contas deste domínio Workspace)
// ---------------------------------------------------------------
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_DOMINIO_PERMITIDO = (process.env.GOOGLE_DOMINIO_PERMITIDO || '').trim() || undefined;
const ERRO_GOOGLE_INVALIDO = 'Não foi possível entrar com o Google. Tente novamente.';

// Verifica o token e devolve { sub, email, nome, nonce } ou null. O motivo
// detalhado da recusa só vai para o log do servidor (o usuário sempre recebe a
// mesma mensagem genérica).
async function verificarTokenGoogle(credential, req) {
  const resultado = await verificarIdToken(credential, {
    clientId: GOOGLE_CLIENT_ID,
    dominioPermitido: GOOGLE_DOMINIO_PERMITIDO
  });
  if (!resultado.ok) {
    auditar('google_token_recusado', { req, motivo: resultado.motivo });
    return null;
  }
  return resultado.dados;
}

// Perfil mínimo para operar: CPF e telefone (contas Google nascem sem eles).
function pendenciasDePerfil(usuario) {
  const faltam = [];
  if (!somenteDigitos(usuario.cpf)) faltam.push('cpf');
  if (somenteDigitos(usuario.telefone).length < 10) faltam.push('telefone');
  return faltam;
}

// Responde 403 + código PERFIL_INCOMPLETO e devolve true se faltar algo. É a
// regra de verdade (o popup do navegador é só a interface dela).
function bloquearSePerfilIncompleto(usuario, res) {
  const faltam = pendenciasDePerfil(usuario);
  if (faltam.length === 0) return false;
  res.status(403).json({
    erro: 'Complete seu cadastro (CPF e telefone) para continuar.',
    codigo: 'PERFIL_INCOMPLETO',
    faltam
  });
  return true;
}

// Formata 11 dígitos como CPF (000.000.000-00), o formato em que é guardado.
function formatarCpf(d) {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// O telefone é opcional; se vier, precisa ser texto de até 20 caracteres.
function telefoneValido(telefone) {
  return telefone === undefined || telefone === null || (typeof telefone === 'string' && telefone.length <= 20);
}

// true só para latitude e longitude que sejam números finitos dentro dos limites
// do globo (-90 a 90 e -180 a 180).
function coordenadasValidas(latitude, longitude) {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

// true se o id informado corresponde a uma categoria existente.
function categoriaValida(categoriaId) {
  const id = Number(categoriaId);
  return Number.isInteger(id) && db.categorias.some((categoria) => Number(categoria.id) === id);
}

// express.json() lê o corpo das requisições (ex.: os dados de um
// formulário enviados em JSON) e disponibiliza em req.body.
app.use(express.json());

// Cabeçalhos de segurança básicos. "strict-origin" faz o navegador mandar só a
// origem (nunca o caminho ou a query) quando a página carrega fontes, Leaflet
// ou tiles de mapa de outros domínios — e o OpenStreetMap continua recebendo o
// Referer de origem que a política de uso dele pede.
// ---------------------------------------------------------------
// Content-Security-Policy (CSP)
//
// A CSP diz ao navegador de quais origens a página pode carregar scripts,
// estilos, imagens e conexões. Se alguém conseguir injetar um <script> na
// página (XSS), o navegador se recusa a executá-lo — isso protege o token de
// sessão guardado no localStorage. A lista abaixo é exatamente o que o app usa:
//   - Leaflet (cdnjs) para o mapa e tiles do OpenStreetMap;
//   - Google Fonts (CSS + arquivos de fonte);
//   - Google Identity Services (script, iframe do botão, estilo e chamadas);
//   - OSRM (rota no mapa).
//
// MODO: por padrão a política é enviada como "Report-Only": o navegador NÃO
// bloqueia nada, só avisa no console (F12) o que bloquearia. Assim dá para
// testar com segurança. Quando o console estiver limpo, defina CSP_ENFORCAR=1
// no .env para passar a bloquear de verdade.
// ---------------------------------------------------------------
const CSP_POLITICA = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://accounts.google.com/gsi/style",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://cdnjs.cloudflare.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "connect-src 'self' https://router.project-osrm.org https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const CSP_CABECALHO =
  process.env.CSP_ENFORCAR === '1' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';

app.use((req, res, next) => {
  res.set('Referrer-Policy', 'strict-origin');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set(CSP_CABECALHO, CSP_POLITICA);
  next();
});

// As respostas da API representam estado atual dos chamados e usuários.
// Impede que navegador, proxy ou service worker devolva uma lista antiga
// quando o prestador clicar em "Atualizar".
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Verificação de saúde (usada por monitoramento/hospedagem). Mostra onde os
// dados estão sendo guardados e se a última gravação no MySQL falhou.
app.get('/health', (req, res) => {
  const { armazenamento, ultimaFalha } = estadoPersistencia();
  res.json({ status: ultimaFalha ? 'degradado' : 'ok', armazenamento, persistenciaComFalha: Boolean(ultimaFalha) });
});

// express.static serve os arquivos da pasta "public" diretamente (HTML,
// CSS, JS do frontend). Como o frontend e a API rodam no mesmo servidor
// e na mesma porta, não é preciso configurar CORS.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------
// Categorias (equivalente à tabela categoria_servico do banco relacional)
// ---------------------------------------------------------------

// Lista as categorias fixas do sistema. Usada pelo frontend para
// montar os <select> de categoria no cadastro de prestador e na
// abertura de chamado.
app.get('/api/categorias', (req, res) => {
  res.json(db.categorias);
});

// Exige login de cliente: a rota repassa consultas ao Nominatim público
// (limite de ~1 por segundo para todo o servidor), então não pode ficar
// aberta a qualquer visitante — bastaria um script para travar a fila e
// impedir os clientes de localizar o próprio endereço.
app.get('/api/localizacao/geocodificar', autenticar(['cliente']), limitarRequisicoes(60 * 1000, 30), assincrono(async (req, res) => {
  const endereco = typeof req.query.endereco === 'string' ? req.query.endereco : '';
  if (endereco.trim().length < 5) {
    return res.status(400).json({ erro: 'Informe um endereço válido para localizar.' });
  }

  try {
    const localizacao = await geocodificar(endereco);
    if (!localizacao) {
      return res.status(404).json({ erro: 'Endereço não encontrado. Confira os dados informados.' });
    }
    res.json(localizacao);
  } catch (erro) {
    console.error('Falha na geocodificação:', erro.message);
    res.status(502).json({ erro: 'Não foi possível localizar o endereço agora. Tente novamente.' });
  }
}));

// Coordenadas -> endereço (geocodificação reversa), usada no botão "usar minha
// localização". Mesmas proteções da rota acima: exige cliente logado e tem limite.
app.get('/api/localizacao/reverse', autenticar(['cliente']), limitarRequisicoes(60 * 1000, 30), assincrono(async (req, res) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ erro: 'Coordenadas inválidas para localizar o endereço.' });
  }

  try {
    const localizacao = await reverseGeocodificar(latitude, longitude);
    if (!localizacao) {
      return res.status(404).json({ erro: 'Não foi possível obter o endereço para estas coordenadas.' });
    }
    res.json(localizacao);
  } catch (erro) {
    console.error('Falha no reverse geocoding:', erro.message);
    res.status(502).json({ erro: 'Não foi possível obter o endereço agora. Tente novamente.' });
  }
}));

// ---------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------

// Cria uma nova conta de cliente OU de prestador (o campo "tipo" no
// corpo da requisição decide qual). Depois de cadastrar, já efetua o
// login automaticamente (devolve um token), para o usuário não precisar
// preencher o formulário de login logo em seguida.
app.post('/api/auth/registrar', limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  const { tipo, nome, email, senha, telefone, cpf, categoriaId } = req.body;

  // --- validações básicas de entrada ---
  if (!['cliente', 'prestador'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de usuário inválido.' });
  }
  if (
    typeof nome !== 'string' ||
    !nome.trim() ||
    typeof email !== 'string' ||
    !email.trim() ||
    typeof senha !== 'string' ||
    !senha ||
    typeof cpf !== 'string' ||
    !cpf.trim()
  ) {
    return res.status(400).json({ erro: 'Preencha nome, email, senha e CPF.' });
  }
  const emailNormalizado = email.trim().toLowerCase();
  const cpfDigitos = somenteDigitos(cpf);
  if (nome.trim().length > 120) {
    return res.status(400).json({ erro: 'O nome deve ter no máximo 120 caracteres.' });
  }
  if (!EMAIL_REGEX.test(emailNormalizado) || emailNormalizado.length > 150) {
    return res.status(400).json({ erro: 'Informe um email válido.' });
  }
  // Além dos 11 dígitos, confere os dígitos verificadores (rejeita "111.111.111-11" etc.).
  if (!cpfValido(cpfDigitos)) {
    return res.status(400).json({ erro: 'Informe um CPF válido.' });
  }
  const erroSenha = validarSenha(senha);
  if (erroSenha) {
    return res.status(400).json({ erro: erroSenha });
  }
  if (!telefoneValido(telefone)) {
    return res.status(400).json({ erro: 'Informe um telefone válido (até 20 caracteres).' });
  }
  if (tipo === 'prestador' && !categoriaValida(categoriaId)) {
    return res.status(400).json({ erro: 'Selecione uma categoria de atendimento válida.' });
  }

  // "colecao" aponta para o array certo (clientes ou prestadores),
  // evitando duplicar o código de cadastro para os dois casos.
  const colecao = tipo === 'cliente' ? db.clientes : db.prestadores;

  // Equivalente às restrições UNIQUE (email, cpf) do banco relacional:
  // aqui quem garante que não existam duplicados é o próprio código. O CPF é
  // comparado só pelos dígitos, para "529.982.247-25" e "52998224725" serem
  // reconhecidos como o mesmo.
  const jaExiste = () =>
    colecao.some((u) => u.email.toLowerCase() === emailNormalizado || somenteDigitos(u.cpf) === cpfDigitos);
  const respostaDuplicado = { erro: 'Já existe um cadastro com este email ou CPF.' };
  if (jaExiste()) {
    return res.status(409).json(respostaDuplicado);
  }

  // Nunca guardamos a senha em texto puro: bcrypt gera um hash (texto
  // embaralhado e irreversível) a partir da senha. No login, comparamos
  // a senha digitada com esse hash (ver bcrypt.compare mais abaixo),
  // sem nunca precisar "descriptografar" nada.
  const senhaHash = await bcrypt.hash(senha, 10);

  // O bcrypt acima é assíncrono: enquanto ele roda, outra requisição com o
  // mesmo email/CPF pode ter terminado o cadastro. Conferimos de novo aqui —
  // daqui até o "push" não há mais nenhum await, então nada se intromete.
  if (jaExiste()) {
    return res.status(409).json(respostaDuplicado);
  }

  const usuario = {
    id: crypto.randomUUID(), // identificador único (equivalente ao SERIAL/IDENTITY do SQL)
    nome: nome.trim(),
    email: emailNormalizado,
    senhaHash,
    telefone: typeof telefone === 'string' && telefone.trim() ? telefone.trim() : null,
    // Guardado sempre no formato 000.000.000-00, igual à máscara da tela.
    cpf: `${cpfDigitos.slice(0, 3)}.${cpfDigitos.slice(3, 6)}.${cpfDigitos.slice(6, 9)}-${cpfDigitos.slice(9)}`,
    dataCadastro: paraIso()
  };

  // Prestador tem campos extras que cliente não tem (ver tabela
  // "prestador" em sos_veiculos_mysql.sql): categoria, disponibilidade e
  // localização atual.
  if (tipo === 'prestador') {
    usuario.categoriaId = Number(categoriaId);
    usuario.aprovado = false;
    usuario.disponivel = false;
    usuario.latitude = null;
    usuario.longitude = null;
    usuario.raioKm = RAIO_PADRAO_KM; // pode ser ajustado em Configurações
  }

  colecao.push(usuario); // "INSERT" na tabela em memória
  await salvar();

  if (tipo === 'prestador') {
    return res.status(201).json({
      mensagem: 'Cadastro enviado para aprovação do administrador. Você só conseguirá fazer login após a aprovação.'
    });
  }

  const token = criarSessao(tipo, usuario.id);
  // "paraPublico" remove a senhaHash antes de devolver o usuário — o
  // frontend nunca deve receber esse dado, nem por engano.
  res.status(201).json({ token, usuario: paraPublico(tipo, usuario) });
}));

// ---------------------------------------------------------------
// Login / cadastro com Google
// ---------------------------------------------------------------

// O frontend só mostra o botão do Google se o servidor estiver configurado.
// (O Client ID do Google é público por natureza — não é segredo.)
app.get('/api/auth/google/config', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID || null });
});

// Entrega um NONCE de uso único. O navegador o passa ao Google ao inicializar o
// botão; o Google o grava dentro do ID token assinado; no login conferimos e
// gastamos esse nonce. Resultado: um token interceptado ou copiado não pode ser
// reapresentado (replay) — o nonce dele já foi consumido.
app.get('/api/auth/google/nonce', limitarRequisicoes(60 * 1000, 30), (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ erro: 'Login com Google não está disponível no momento.' });
  }
  res.json({ nonce: gerarNonce() });
});

// Entra (ou cria a conta) com um ID token do Google.
//  - já vinculada a este Google → login;
//  - e-mail já cadastrado com senha → pede CONFIRMAÇÃO (409 CONFIRMAR_VINCULO);
//    confirmada, VINCULA e remove a senha antiga (veja abaixo);
//  - não existe → cria a conta SEM CPF/telefone (pedidos no 1º chamado/aceite).
app.post('/api/auth/google', limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ erro: 'Login com Google não está disponível no momento.' });
  }
  const { credential, tipo, categoriaId, confirmarVinculo } = req.body || {};
  if (!['cliente', 'prestador'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de usuário inválido.' });
  }

  // Valida assinatura, emissor, destinatário, validade, e-mail verificado e se
  // o nonce é um dos nossos. Este "await" é o ÚLTIMO antes de alterar dados:
  // daqui até o "push"/vínculo abaixo tudo é síncrono, então duas requisições
  // simultâneas com o mesmo token não conseguem passar juntas.
  const google = await verificarTokenGoogle(credential, req);
  if (!google) return res.status(401).json({ erro: ERRO_GOOGLE_INVALIDO });

  const colecao = tipo === 'cliente' ? db.clientes : db.prestadores;
  let usuario = colecao.find((u) => u.googleId === google.sub);
  let novaConta = false;
  let vinculada = false;

  // --- Fase 1: decidir o que fazer SEM gastar o nonce ---
  // Os retornos desta fase (confirmação, conflito, categoria faltando) deixam o
  // token e o nonce intactos, para o navegador poder reenviar o MESMO token
  // depois que o usuário confirmar ou escolher a categoria.
  const porEmail = usuario ? null : colecao.find((u) => u.email.toLowerCase() === google.email);
  if (!usuario) {
    if (porEmail) {
      if (porEmail.googleId && porEmail.googleId !== google.sub) {
        auditar('google_conflito_vinculo', { req, tipo, usuarioId: porEmail.id });
        return res.status(409).json({ erro: 'Este e-mail já está vinculado a outra conta Google.' });
      }
      // Já existe uma conta com senha neste e-mail: vincular ao Google REMOVE a
      // senha (veja a explicação na fase 2). Isso é uma mudança importante, então
      // o usuário precisa confirmar antes — nada é alterado sem o "sim" dele.
      if (porEmail.senhaHash && confirmarVinculo !== true) {
        return res.status(409).json({
          erro: 'Já existe uma conta com este e-mail. Ao continuar com o Google, ela passará a entrar pelo Google e a senha atual será removida.',
          codigo: 'CONFIRMAR_VINCULO'
        });
      }
    } else if (tipo === 'prestador' && !categoriaValida(categoriaId)) {
      return res.status(400).json({
        erro: 'Selecione a categoria de atendimento para criar a conta de prestador.',
        codigo: 'CATEGORIA_OBRIGATORIA'
      });
    }
  }

  // --- Fase 2: o login vai prosseguir — gasta o nonce (uso único) ---
  // Se alguém reapresentar um token já usado, o nonce não existe mais e a
  // tentativa é recusada como replay.
  if (!consumirNonce(google.nonce)) {
    auditar('google_replay_bloqueado', { req, tipo });
    return res.status(401).json({ erro: ERRO_GOOGLE_INVALIDO });
  }

  if (!usuario) {
    if (porEmail) {
      // O sistema não confirma o e-mail no cadastro por senha. Se alguém tivesse
      // cadastrado o e-mail de outra pessoa com uma senha que só ele conhece,
      // vincular o Google sem remover essa senha deixaria a conta acessível a
      // ele. Por isso, ao vincular, a senha antiga é descartada e as sessões e
      // links de redefinição pendentes são encerrados. Para voltar a usar senha:
      // "Esqueci minha senha" (prova o controle do e-mail).
      porEmail.googleId = google.sub;
      vinculada = !!porEmail.senhaHash;
      porEmail.senhaHash = null;
      db.redefinicoesSenha = db.redefinicoesSenha.filter((r) => !(r.usuarioId === porEmail.id && r.tipo === tipo));
      encerrarSessoesDoUsuario(tipo, porEmail.id);
      usuario = porEmail;
      auditar('google_conta_vinculada', { req, tipo, usuarioId: usuario.id });
    } else {
      usuario = {
        id: crypto.randomUUID(),
        nome: google.nome,
        email: google.email,
        senhaHash: null,
        googleId: google.sub,
        telefone: null,
        cpf: null,
        dataCadastro: paraIso()
      };
      if (tipo === 'prestador') {
        usuario.categoriaId = Number(categoriaId);
        usuario.aprovado = false;
        usuario.disponivel = false;
        usuario.latitude = null;
        usuario.longitude = null;
        usuario.raioKm = RAIO_PADRAO_KM;
      }
      colecao.push(usuario);
      novaConta = true;
      auditar('google_conta_criada', { req, tipo, usuarioId: usuario.id });
    }
  }
  await salvar();

  // Mesma regra do login por senha: prestador só entra depois de aprovado.
  if (tipo === 'prestador' && usuario.aprovado !== true) {
    return res.status(novaConta ? 201 : 403).json({
      erro: novaConta ? undefined : 'Seu cadastro está pendente de aprovação do administrador.',
      mensagem: novaConta ? 'Cadastro enviado para aprovação do administrador. Você só conseguirá entrar após a aprovação.' : undefined,
      pendente: true
    });
  }

  auditar('google_login', { req, tipo, usuarioId: usuario.id });
  const token = criarSessao(tipo, usuario.id);
  res.status(novaConta ? 201 : 200).json({ token, usuario: paraPublico(tipo, usuario), novaConta, vinculada });
}));

// Completa CPF e telefone (popup do 1º pedido/aceite). Age sempre sobre o
// usuário da sessão. O CPF, uma vez informado, não é alterado por aqui.
app.post('/api/auth/completar-perfil', autenticar(['cliente', 'prestador']), limitarRequisicoes(60 * 1000, 20), assincrono(async (req, res) => {
  const tipo = req.sessao.tipo;
  const usuario = buscarUsuario(tipo, req.sessao.id);
  const { cpf, telefone } = req.body || {};
  const faltam = pendenciasDePerfil(usuario);

  if (faltam.includes('cpf')) {
    const digitos = somenteDigitos(cpf);
    if (typeof cpf !== 'string' || !cpfValido(digitos)) {
      return res.status(400).json({ erro: 'Informe um CPF válido.' });
    }
    const colecao = tipo === 'cliente' ? db.clientes : db.prestadores;
    if (colecao.some((u) => u.id !== usuario.id && somenteDigitos(u.cpf) === digitos)) {
      return res.status(409).json({ erro: 'Já existe um cadastro com este CPF.' });
    }
    usuario.cpf = formatarCpf(digitos);
  }
  if (faltam.includes('telefone')) {
    const digitos = somenteDigitos(telefone);
    if (typeof telefone !== 'string' || telefone.length > 20 || digitos.length < 10 || digitos.length > 13) {
      return res.status(400).json({ erro: 'Informe um telefone válido, com DDD.' });
    }
    usuario.telefone = telefone.trim();
  }
  await salvar();
  res.json({ usuario: paraPublico(tipo, usuario) });
}));

// Login: recebe tipo + email + senha, confere a senha contra o hash
// salvo e, se bater, devolve um novo token de sessão.
app.post('/api/auth/login', limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  const { tipo, email, senha } = req.body;
  const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const colecao = tipo === 'cliente' ? db.clientes : tipo === 'prestador' ? db.prestadores : null;
  const usuario = colecao && colecao.find((u) => u.email.toLowerCase() === emailNormalizado);

  // bcrypt.compare faz o hash da senha digitada com o mesmo algoritmo e
  // compara com o hash salvo — sem nunca reverter o hash original.
  const senhaValida =
    usuario && usuario.senhaHash && typeof senha === 'string' && (await bcrypt.compare(senha, usuario.senhaHash));

  if (!senhaValida) {
    // Mensagem genérica de propósito: não dizemos se foi o email ou a
    // senha que errou, para não ajudar quem estiver tentando adivinhar
    // credenciais de outra pessoa.
    // Dica útil sem revelar nada: a mensagem é a MESMA exista ou não o e-mail,
    // e sempre lembra do Google — assim quem criou a conta pelo Google (e por
    // isso não tem senha) entende o que fazer, sem sabermos dizer se o e-mail existe.
    return res.status(401).json({
      erro: 'Email ou senha incorretos. Se você criou a conta com o Google, use o botão "Continuar com o Google" ou "Esqueceu sua senha?".'
    });
  }

  if (tipo === 'prestador' && usuario.aprovado !== true) {
    return res.status(403).json({ erro: 'Seu cadastro está pendente de aprovação do administrador.' });
  }

  const token = criarSessao(tipo, usuario.id);
  res.json({ token, usuario: paraPublico(tipo, usuario) });
}));

// Logout: invalida o token atual (ver auth-middleware.js). Prestador que sai
// também deixa de estar "disponível" — senão continuaria marcado assim no
// banco sem ninguém logado para atender.
app.post('/api/auth/logout', autenticar(), assincrono(async (req, res) => {
  if (req.sessao.tipo === 'prestador') {
    const prestador = buscarUsuario('prestador', req.sessao.id);
    if (prestador?.disponivel) {
      prestador.disponivel = false;
      await salvar();
    }
  }
  encerrarSessao(req.token);
  res.status(204).end(); // 204 = "sucesso, sem conteúdo para devolver"
}));

// Usada pelo frontend ao carregar a página: se já existir um token
// salvo no navegador (localStorage), essa rota confirma se ele ainda é
// válido e devolve os dados do usuário logado, evitando pedir login de
// novo a cada vez que a página é recarregada.
app.get('/api/auth/me', autenticar(), (req, res) => {
  const usuario = buscarUsuario(req.sessao.tipo, req.sessao.id);
  res.json({ tipo: req.sessao.tipo, usuario: paraPublico(req.sessao.tipo, usuario) });
});

// Atualiza dados do usuário logado (nome, telefone e/ou senha).
app.patch('/api/auth/atualizar', autenticar(['cliente', 'prestador']), limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  const usuario = buscarUsuario(req.sessao.tipo, req.sessao.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  // Valida tudo ANTES de alterar qualquer campo, para uma requisição
  // recusada não deixar o usuário meio atualizado em memória.
  const { nome, telefone, senha, senhaAtual, categoriaId, raioKm } = req.body;
  if (nome !== undefined && (typeof nome !== 'string' || !nome.trim() || nome.trim().length > 120)) {
    return res.status(400).json({ erro: 'Informe um nome válido (até 120 caracteres).' });
  }
  if (!telefoneValido(telefone)) {
    return res.status(400).json({ erro: 'Informe um telefone válido (até 20 caracteres).' });
  }
  const trocaSenha = senha !== undefined && senha !== '';
  if (trocaSenha) {
    const erroSenha = validarSenha(senha);
    if (erroSenha) return res.status(400).json({ erro: erroSenha });

    // Trocar a senha exige PROVAR que quem pede conhece a senha atual. Sem isso,
    // quem pegasse um token de sessão (aparelho emprestado, XSS, token vazado)
    // fixaria uma senha nova e tomaria a conta de vez.
    if (!usuario.senhaHash) {
      // Conta criada pelo Google: não há senha atual para provar. Criar uma
      // senha só pelo caminho que prova o controle do e-mail.
      return res.status(400).json({
        erro: 'Esta conta entra pelo Google e não tem senha. Para criar uma, saia e use "Esqueceu sua senha?".',
        codigo: 'CONTA_SEM_SENHA'
      });
    }
    // Quem erra a senha atual aqui não é "não autenticado" (a sessão é válida):
    // por isso 403 e não 401 — o 401 faria o front encerrar a sessão inteira.
    const atualConfere = typeof senhaAtual === 'string' && (await bcrypt.compare(senhaAtual, usuario.senhaHash));
    if (!atualConfere) {
      auditar('troca_senha_recusada', { req, tipo: req.sessao.tipo, usuarioId: usuario.id, motivo: 'senha_atual_incorreta' });
      return res.status(403).json({ erro: 'A senha atual está incorreta.', codigo: 'SENHA_ATUAL_INCORRETA' });
    }
  }
  if (categoriaId !== undefined) {
    if (req.sessao.tipo !== 'prestador' || !categoriaValida(categoriaId)) {
      return res.status(400).json({ erro: 'Informe uma categoria de atendimento válida.' });
    }
  }

  // Raio de atendimento: só o PRÓPRIO prestador logado (a rota age sempre em
  // req.sessao.id, nunca em um id vindo do corpo) e só com valor válido.
  let raioValidado = null;
  if (raioKm !== undefined) {
    if (req.sessao.tipo !== 'prestador') {
      return res.status(400).json({ erro: 'Somente prestadores têm raio de atendimento.' });
    }
    raioValidado = validarRaioKm(raioKm);
    if (!raioValidado.ok) return res.status(400).json({ erro: raioValidado.erro });
  }

  if (typeof nome === 'string') usuario.nome = nome.trim();
  if (typeof telefone === 'string') usuario.telefone = telefone.trim() || null;
  if (categoriaId !== undefined) usuario.categoriaId = Number(categoriaId);
  if (raioValidado) usuario.raioKm = raioValidado.valor;
  if (trocaSenha) {
    usuario.senhaHash = await bcrypt.hash(senha, 10);
    // Um link de redefinição pedido antes desta troca de senha não deve
    // continuar valendo.
    db.redefinicoesSenha = db.redefinicoesSenha.filter(
      (r) => !(r.usuarioId === usuario.id && r.tipo === req.sessao.tipo)
    );
    // Quem estivesse logado em outro aparelho (ou com a senha antiga
    // vazada) perde o acesso; a sessão atual continua valendo.
    encerrarSessoesDoUsuario(req.sessao.tipo, req.sessao.id, req.token);
  }

  await salvar();
  res.json(paraPublico(req.sessao.tipo, usuario));
}));

// Pede a redefinição de senha. A resposta é SEMPRE a mesma, imediata e sem
// nenhum dado além da mensagem — exista ou não o e-mail (não revela quais
// e-mails estão cadastrados) e NUNCA contém o link nem o token. O trabalho
// (gerar token, gravar, enviar e-mail) acontece depois de responder, para que
// nem o tempo de resposta diferencie e-mails cadastrados de não cadastrados.
app.post('/api/auth/esqueci-senha', limitarRequisicoes(60 * 1000, 3), (req, res) => {
  const { tipo, email } = req.body || {};
  const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';

  res.json({ mensagem: MENSAGEM_ESQUECI_SENHA });

  if (!emailNormalizado || emailNormalizado.length > 150) return;
  setImmediate(() => {
    processarPedidoRedefinicao(tipo, emailNormalizado, `${req.protocol}://${req.get('host')}`).catch((erro) => {
      // Só a mensagem do erro: nada de e-mail, token ou link no log.
      console.warn('[redefinicao] Falha ao processar o pedido:', erro.message);
    });
  });
});

// Faz o trabalho pesado do "esqueci minha senha" DEPOIS de a resposta já ter sido
// enviada: acha o usuário, aplica o freio de 1 e-mail por minuto, gera o token
// (guardando só o hash) e envia o e-mail. Qualquer falha aqui só vai para o log.
async function processarPedidoRedefinicao(tipo, emailNormalizado, urlDaRequisicao) {
  const colecao =
    tipo === 'cliente'
      ? db.clientes
      : tipo === 'prestador'
        ? db.prestadores
        : [...db.clientes, ...db.prestadores];

  const usuario = colecao.find((u) => u.email.toLowerCase() === emailNormalizado);
  if (!usuario) return;
  const tipoUsuario = db.clientes.some((u) => u.id === usuario.id) ? 'cliente' : 'prestador';

  const agora = Date.now();
  // Só tokens ainda válidos interessam; os vencidos são descartados junto.
  const vigentes = db.redefinicoesSenha.filter((r) => new Date(r.expiraEm).getTime() > agora);
  const doUsuario = vigentes.filter((r) => r.usuarioId === usuario.id && r.tipo === tipoUsuario);

  // Freio contra spam de e-mails: se acabou de ser emitido um token para esta
  // conta, não emite outro agora (não muda nada para quem pede uma vez só).
  const recente = doUsuario.some(
    (r) => agora - (new Date(r.expiraEm).getTime() - TOKEN_REDEFINICAO_TTL_MS) < INTERVALO_MIN_NOVO_TOKEN_MS
  );
  if (recente) return;

  // Um token novo invalida os anteriores da mesma conta.
  const token = crypto.randomBytes(32).toString('hex');
  db.redefinicoesSenha = vigentes.filter((r) => !(r.usuarioId === usuario.id && r.tipo === tipoUsuario));
  db.redefinicoesSenha.push({
    token: hashTokenRedefinicao(token), // só o hash fica guardado
    tipo: tipoUsuario,
    usuarioId: usuario.id,
    expiraEm: paraIso(new Date(agora + TOKEN_REDEFINICAO_TTL_MS))
  });
  await salvar();

  // O link do e-mail NUNCA é montado com o cabeçalho Host da requisição em
  // produção: um atacante poderia pedir a redefinição da conta de outra pessoa
  // com "Host: site-do-atacante.com" e o e-mail legítimo traria um link para o
  // site dele (envenenamento do link). Em produção exigimos APP_URL; só em
  // desenvolvimento o endereço da requisição serve de apoio.
  const appUrl = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? null : urlDaRequisicao);
  if (!appUrl) {
    console.warn('[redefinicao] APP_URL não está definido: e-mail de redefinição NÃO enviado (defina APP_URL em produção).');
    return;
  }
  await enviarEmailRedefinicao({ paraEmail: usuario.email, nome: usuario.nome, tipo: tipoUsuario, token, appUrl });
}

// Conclui a redefinição. Toda a validação é feita aqui no servidor: um token
// inexistente, inválido, expirado ou já usado recebe exatamente a mesma
// resposta (400 genérico), sem indicar qual foi o motivo.
app.post('/api/auth/redefinir-senha', limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  const { token, novaSenha } = req.body || {};

  if (!tokenRedefinicaoComFormatoValido(token)) {
    return res.status(400).json({ erro: ERRO_LINK_INVALIDO });
  }
  const hash = hashTokenRedefinicao(token);
  const redefinicao = db.redefinicoesSenha.find((r) => r.token === hash);

  if (!redefinicao || new Date(redefinicao.expiraEm).getTime() <= Date.now()) {
    // Token vencido não serve para mais nada: sai do estado.
    if (redefinicao) db.redefinicoesSenha = db.redefinicoesSenha.filter((r) => r.token !== hash);
    return res.status(400).json({ erro: ERRO_LINK_INVALIDO });
  }

  // Senha fraca/longa demais não gasta o token: a pessoa pode tentar de novo.
  const erroSenha = validarSenha(novaSenha);
  if (erroSenha) {
    return res.status(400).json({ erro: erroSenha });
  }

  // USO ÚNICO: o token (e qualquer outro pendente desta conta) é descartado
  // AGORA, de forma síncrona, antes do primeiro "await". Duas requisições
  // simultâneas com o mesmo token não passam juntas: a segunda já não o encontra.
  db.redefinicoesSenha = db.redefinicoesSenha.filter(
    (r) => !(r.usuarioId === redefinicao.usuarioId && r.tipo === redefinicao.tipo)
  );

  const usuario = buscarUsuario(redefinicao.tipo, redefinicao.usuarioId);
  if (!usuario) {
    await salvar();
    return res.status(400).json({ erro: ERRO_LINK_INVALIDO });
  }

  usuario.senhaHash = await bcrypt.hash(novaSenha, 10);
  // Redefinir a senha costuma significar "perdi o controle da conta": todas
  // as sessões abertas com a senha antiga deixam de valer.
  encerrarSessoesDoUsuario(redefinicao.tipo, redefinicao.usuarioId);
  await salvar();

  res.json({ mensagem: 'Senha redefinida com sucesso.' });
}));

// Login exclusivo do administrador — não existe cadastro público para
// este tipo de usuário, só as credenciais fixas definidas por variável
// de ambiente (ver ADMIN_EMAIL/ADMIN_SENHA acima).
app.post('/api/auth/login-admin', limitarRequisicoes(60 * 1000, 10), assincrono(async (req, res) => {
  const { email, senha } = req.body;
  const senhaValida = typeof senha === 'string' && (await bcrypt.compare(senha, ADMIN_SENHA_HASH));
  const emailValido = typeof email === 'string' && email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
  if (!emailValido || !senhaValida) {
    return res.status(401).json({ erro: 'Email ou senha incorretos.' });
  }
  const token = criarSessao('admin', 'admin');
  res.json({ token, usuario: { id: 'admin', nome: 'Administrador' } });
}));

// ---------------------------------------------------------------
// Prestador: disponibilidade e localização
// ---------------------------------------------------------------

// O prestador chama essa rota sempre que liga/desliga o interruptor de
// disponibilidade, e também em segundo plano quando o navegador consegue
// uma nova localização GPS. Só atualiza os campos que vierem preenchidos
// no corpo da requisição (permite atualizar só a localização, ou só a
// disponibilidade, sem precisar mandar tudo de novo).
app.patch('/api/prestador/disponibilidade', autenticar(['prestador']), assincrono(async (req, res) => {
  const prestador = buscarUsuario('prestador', req.sessao.id);
  const { disponivel, latitude, longitude } = req.body;

  // Valida tudo antes de alterar qualquer campo: uma requisição recusada com
  // 400 não pode deixar o prestador com a disponibilidade já trocada.
  const temLocalizacao = latitude !== undefined || longitude !== undefined;
  if (temLocalizacao && !coordenadasValidas(latitude, longitude)) {
    return res.status(400).json({ erro: 'Informe latitude e longitude válidas.' });
  }

  if (typeof disponivel === 'boolean') prestador.disponivel = disponivel;
  if (temLocalizacao) {
    prestador.latitude = latitude;
    prestador.longitude = longitude;
  }

  await salvar();
  res.json(paraPublico('prestador', prestador));
}));

// Cliente atualiza a própria posição durante um chamado ativo. O prestador
// vinculado recebe essas coordenadas pela rota /chamados/atual.
app.patch('/api/chamados/:id/localizacao', autenticar(['cliente']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id && c.clienteId === req.sessao.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });
  if (!STATUS_ATIVOS.includes(chamado.status)) {
    return res.status(409).json({ erro: 'Este chamado não está ativo.' });
  }

  const { latitude, longitude } = req.body;
  if (!coordenadasValidas(latitude, longitude)) {
    return res.status(400).json({ erro: 'Informe latitude e longitude válidas.' });
  }

  chamado.latitude = latitude;
  chamado.longitude = longitude;
  await salvar();
  res.json(montarChamado(chamado));
}));

// Perfil de avaliações do próprio prestador: nota média, total de
// avaliações e a lista de comentários recebidos (mais recente primeiro)
// — usada na tela "Minhas avaliações" do painel do prestador.
app.get('/api/prestador/me/avaliacoes', autenticar(['prestador']), (req, res) => {
  const { media, total } = calcularNotaPrestador(req.sessao.id);

  const avaliacoes = db.avaliacoes
    .map((a) => ({ avaliacao: a, chamado: db.chamados.find((c) => c.id === a.chamadoId) }))
    .filter(({ chamado }) => chamado && chamado.prestadorId === req.sessao.id)
    .map(({ avaliacao, chamado }) => ({
      nota: avaliacao.nota,
      comentario: avaliacao.comentario,
      data: avaliacao.dataAvaliacao,
      clienteNome: buscarUsuario('cliente', chamado.clienteId)?.nome
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  res.json({ media, total, avaliacoes });
});

// ---------------------------------------------------------------
// Chamados
// ---------------------------------------------------------------

// Cliente abre um novo chamado de socorro. Nasce sempre com
// status "aberto" e prestadorId nulo — ninguém foi vinculado ainda.
app.post('/api/chamados', autenticar(['cliente']), assincrono(async (req, res) => {
  const { categoriaId, latitude, longitude, endereco, descricao } = req.body;

  // Conta criada pelo Google navega livremente, mas só pede socorro depois de
  // informar CPF e telefone (o prestador precisa conseguir falar com o cliente).
  if (bloquearSePerfilIncompleto(buscarUsuario('cliente', req.sessao.id), res)) return;

  if (!categoriaValida(categoriaId)) {
    return res.status(400).json({ erro: 'Categoria inválida.' });
  }
  if (!coordenadasValidas(latitude, longitude)) {
    return res.status(400).json({ erro: 'Informe a localização (latitude/longitude).' });
  }
  // Tipo e tamanho são checados aqui porque um valor inválido que entrasse em
  // "db" faria TODAS as gravações seguintes falharem no MySQL (o salvar()
  // regrava o estado inteiro, inclusive este chamado).
  if (endereco != null && (typeof endereco !== 'string' || endereco.length > 255)) {
    return res.status(400).json({ erro: 'O endereço deve ter no máximo 255 caracteres.' });
  }
  if (descricao != null && (typeof descricao !== 'string' || descricao.length > 1000)) {
    return res.status(400).json({ erro: 'A descrição deve ter no máximo 1000 caracteres.' });
  }

  // Regra simples de bom uso: um cliente não pode abrir um segundo
  // chamado enquanto já tiver um em andamento (aberto, aceito ou a
  // caminho). Evita pedidos duplicados por engano.
  const jaTemChamadoAberto = db.chamados.some(
    (c) => c.clienteId === req.sessao.id && STATUS_ATIVOS.includes(c.status)
  );
  if (jaTemChamadoAberto) {
    return res.status(409).json({ erro: 'Você já tem um chamado em andamento.' });
  }

  const chamado = {
    id: crypto.randomUUID(),
    clienteId: req.sessao.id,
    categoriaId: Number(categoriaId),
    prestadorId: null, // preenchido só quando um prestador aceitar (ver rota /aceitar)
    latitude,
    longitude,
    endereco: endereco?.trim() || null,
    descricao: descricao?.trim() || null,
    status: 'aberto', // ciclo de vida: aberto -> aceito -> em_andamento -> concluido (ou cancelado)
    dataAbertura: paraIso(),
    dataAceite: null,
    dataChegada: null,
    dataConclusao: null,
    dataCancelamento: null,
    canceladoPor: null, // 'cliente' | 'prestador' | 'admin'
    motivoCancelamento: null,
    motivoDetalhe: null,
    cancelamentoVisto: false // o cliente já viu a tela de "cancelado pelo prestador/admin"?
  };
  db.chamados.push(chamado);
  registrarEvento(chamado, 'solicitado', 'cliente', {
    descricao: 'Chamado solicitado',
    data: chamado.dataAbertura
  });
  // Prestadores compatíveis (categoria, disponíveis e com o chamado dentro do
  // SEU raio) ganham uma notificação; é gravada junto com o chamado.
  notificarPrestadoresDoNovoChamado(chamado);
  await salvar();

  res.status(201).json(montarChamado(chamado));
}));

// Lista, para o prestador logado, os chamados abertos da categoria dele que
// estejam dentro do RAIO DE ATENDIMENTO que ele mesmo configurou (busca simples
// por proximidade, sem roteirização — ver utils/distancia.js).
//
// Regras do raio:
//  - o raio vem do cadastro do prestador no servidor; "?raio=" só pode
//    ESTREITAR a busca, nunca ampliá-la além do que o prestador configurou;
//  - a distância é calculada com as coordenadas do prestador e do chamado. Se
//    não for possível calculá-la (prestador ainda sem localização), o chamado
//    NÃO é listado: nunca se presume que está "dentro do raio".
//
// Ordenação ("?ordenar="): proximos (padrão) | recentes | antigos. Não existe
// prioridade/urgência no banco, então "antigos" (aguardando há mais tempo) é o
// único critério de urgência possível com os dados reais.
//
// Importante: aqui usamos "montarResumoChamado" (não "montarChamado"),
// que NÃO inclui nome/telefone do cliente. Igual em apps de corrida
// reais, o prestador só vê os dados de contato do cliente depois de
// aceitar o chamado — antes disso, veria só endereço/descrição/distância.
const ORDENACOES_CHAMADOS = {
  // mais perto primeiro; empate: o mais recente
  proximos: (a, b) => a.distanciaKm - b.distanciaKm || tempoAbertura(b) - tempoAbertura(a),
  // mais recente primeiro; empate: o mais perto
  recentes: (a, b) => tempoAbertura(b) - tempoAbertura(a) || a.distanciaKm - b.distanciaKm,
  // aguardando há mais tempo primeiro; empate: o mais perto
  antigos: (a, b) => tempoAbertura(a) - tempoAbertura(b) || a.distanciaKm - b.distanciaKm
};
// Instante de abertura do chamado em milissegundos (0 se faltar). Usado ao
// ordenar os chamados por "mais recentes" / "mais antigos".
function tempoAbertura(chamado) {
  return new Date(chamado.dataAbertura || 0).getTime() || 0;
}

// Lista os chamados abertos compatíveis com o prestador logado (categoria e raio).
// Aceita ?ordenar=proximos|recentes|antigos e ?raio=N para REDUZIR o raio (nunca
// aumentar além do configurado). Prestador indisponível recebe lista vazia.
app.get('/api/chamados/disponiveis', autenticar(['prestador']), (req, res) => {
  const prestador = buscarUsuario('prestador', req.sessao.id);
  const raioConfigurado = raioDoPrestador(prestador);
  let raioKm = raioConfigurado;
  const raioPedido = Number(req.query.raio);
  if (Number.isFinite(raioPedido) && raioPedido > 0 && raioPedido < raioConfigurado) raioKm = raioPedido;
  const ordem = Object.prototype.hasOwnProperty.call(ORDENACOES_CHAMADOS, req.query.ordenar) ? req.query.ordenar : 'proximos';

  // O interruptor "Disponível" do painel vale de verdade: quem está
  // indisponível não recebe chamados na lista.
  if (!prestador.disponivel) return res.json([]);

  // IDs vindos do MySQL e de instalações antigas podem ter tipos diferentes;
  // a comparação numérica evita perder pedidos válidos após trocar a categoria.
  const disponiveis = db.chamados
    .filter(
      (c) =>
        c.status === 'aberto' &&
        Number(c.categoriaId) === Number(prestador.categoriaId)
    )
    .map((c) => ({
      ...montarResumoChamado(c),
      distanciaKm: distanciaKm(prestador.latitude, prestador.longitude, c.latitude, c.longitude)
    }))
    // Sem distância calculável OU além do raio: fora da lista.
    .filter((c) => c.distanciaKm !== null && c.distanciaKm <= raioKm)
    .sort(ORDENACOES_CHAMADOS[ordem]);

  res.json(disponiveis);
});

// Aceitar chamado: a regra de negócio central do TCC ("o primeiro
// prestador que aceitar fica com o chamado").
//
// Por que isso é seguro mesmo com vários prestadores tentando aceitar ao
// mesmo tempo: o Node.js executa apenas um "pedaço" de código JavaScript
// por vez (é single-threaded). Como esta função não tem nenhum "await"
// entre a linha que CONFERE se o chamado ainda está livre e a linha que
// GRAVA o prestador vencedor, o Node não consegue "pausar" no meio dela
// para atender outra requisição. Ou seja: mesmo que duas requisições de
// "aceitar" cheguem quase no mesmo instante, elas são processadas uma
// de cada vez, nunca ao mesmo tempo — a segunda sempre vai encontrar
// chamado.prestadorId já preenchido e recebe o erro 409.
app.post('/api/chamados/:id/aceitar', autenticar(['prestador']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });

  const prestador = buscarUsuario('prestador', req.sessao.id);
  if (bloquearSePerfilIncompleto(prestador, res)) return;
  if (Number(chamado.categoriaId) !== Number(prestador.categoriaId)) {
    return res.status(403).json({ erro: 'Este chamado não é da sua categoria de atendimento.' });
  }
  // Checagem que implementa a regra central: só aceita se NINGUÉM
  // ainda tiver aceitado (status ainda "aberto" e prestadorId nulo).
  if (chamado.status !== 'aberto' || chamado.prestadorId !== null) {
    return res.status(409).json({ erro: 'Este chamado já foi aceito por outro prestador.' });
  }
  if (!prestador.disponivel) {
    return res.status(403).json({ erro: 'Ative a opção "Disponível" para aceitar chamados.' });
  }
  // O raio também vale aqui, no servidor: chamar a API direto com o id de um
  // chamado que a lista não mostra não contorna o raio do prestador.
  const distanciaAteChamado = distanciaKm(prestador.latitude, prestador.longitude, chamado.latitude, chamado.longitude);
  if (distanciaAteChamado === null) {
    return res.status(403).json({ erro: 'Não foi possível confirmar sua localização. Permita a localização do aparelho para aceitar chamados.' });
  }
  if (distanciaAteChamado > raioDoPrestador(prestador)) {
    return res.status(403).json({ erro: 'Este chamado está fora do seu raio de atendimento.' });
  }
  // Um atendimento por vez: o painel do prestador só mostra UM chamado em
  // andamento (ver /chamados/atual), então um segundo aceite ficaria preso,
  // invisível para ele e sem resposta para o cliente.
  const jaAtendendo = db.chamados.some((c) => c.prestadorId === prestador.id && STATUS_ATIVOS.includes(c.status));
  if (jaAtendendo) {
    return res.status(409).json({ erro: 'Conclua ou cancele o atendimento atual antes de aceitar outro chamado.' });
  }

  const agora = paraIso();
  chamado.prestadorId = prestador.id; // "trava" o chamado para este prestador
  chamado.status = 'aceito';
  chamado.dataAceite = agora;
  // Aceitar já é sair em direção ao cliente (não há um botão separado de
  // "iniciar deslocamento"), então o cliente recebe os dois avisos.
  registrarEvento(chamado, 'aceito', 'prestador', {
    descricao: 'Prestador aceitou o chamado',
    mensagem: NOTIFICACOES.aceito,
    data: agora
  });
  registrarEvento(chamado, 'a_caminho', 'prestador', {
    descricao: 'Prestador a caminho do local',
    mensagem: NOTIFICACOES.a_caminho,
    data: agora
  });
  await salvar();

  res.json(montarChamado(chamado));
}));

// Devolve o chamado "ativo" do usuário logado (cliente ou prestador),
// ou seja, o que ainda não terminou (aberto, aceito ou a caminho). Usada
// pelo frontend para decidir se mostra o formulário de "pedir socorro" /
// lista de chamados disponíveis, ou a tela de acompanhamento.
app.get('/api/chamados/atual', autenticar(), (req, res) => {
  const emAndamento = STATUS_ATIVOS;
  const cancelamentoPendenteDeCiencia = (c) =>
    c.status === 'cancelado' && ['prestador', 'admin'].includes(c.canceladoPor) && !c.cancelamentoVisto;

  // Para o cliente, dois estados finais também contam como "atual", para a
  // tela de acompanhamento não sumir na cara dele:
  //  - concluído e ainda sem avaliação (trilha + formulário de avaliação);
  //  - cancelado pelo prestador/administração e ainda não "visto" (ele precisa
  //    saber que o atendimento caiu; o botão "Fazer novo pedido" marca como visto).
  // Um chamado ativo sempre tem prioridade sobre esses estados finais.
  let chamado;
  if (req.sessao.tipo === 'cliente') {
    const doCliente = db.chamados.filter((c) => c.clienteId === req.sessao.id);
    chamado =
      doCliente.find((c) => emAndamento.includes(c.status)) ||
      doCliente.find(
        (c) =>
          (c.status === 'concluido' && !db.avaliacoes.some((a) => a.chamadoId === c.id)) ||
          cancelamentoPendenteDeCiencia(c)
      );
  } else {
    chamado = db.chamados.find((c) => c.prestadorId === req.sessao.id && emAndamento.includes(c.status));
  }

  res.json(chamado ? montarChamado(chamado) : null);
});

// Prestador avisa que chegou ao local ("Cheguei ao local"). A rota mantém o
// nome antigo (/iniciar) para não quebrar o frontend: aceito -> em_andamento.
// Registra a hora da chegada e avisa o cliente.
app.post('/api/chamados/:id/iniciar', autenticar(['prestador']), assincrono(async (req, res) => {
  const chamado = validarAcaoPrestador(req, res, 'chegar');
  if (!chamado) return;

  const agora = paraIso();
  chamado.status = ACOES_PRESTADOR.chegar.para;
  chamado.dataChegada = agora;
  registrarEvento(chamado, 'chegou', 'prestador', {
    descricao: 'Prestador chegou ao local',
    mensagem: NOTIFICACOES.chegou,
    data: agora
  });
  await salvar();
  res.json(montarChamado(chamado));
}));

// Prestador conclui o atendimento (em_andamento -> concluido). Só depois de
// "Cheguei ao local": o atendimento precisa ter acontecido no local. Concluído
// é um estado final — uma segunda chamada recebe 409 e não gera outro evento.
app.post('/api/chamados/:id/concluir', autenticar(['prestador']), assincrono(async (req, res) => {
  const chamado = validarAcaoPrestador(req, res, 'concluir');
  if (!chamado) return;

  const agora = paraIso();
  chamado.status = ACOES_PRESTADOR.concluir.para;
  chamado.dataConclusao = agora;
  registrarEvento(chamado, 'concluido', 'prestador', {
    descricao: 'Atendimento concluído',
    mensagem: NOTIFICACOES.concluido,
    data: agora
  });
  await salvar();
  res.json(montarChamado(chamado));
}));

// Cliente cancela o próprio chamado — permitido enquanto ninguém aceitou
// (status "aberto") ou até 1 minuto após o aceite pelo prestador.
app.post('/api/chamados/:id/cancelar', autenticar(['cliente']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id && c.clienteId === req.sessao.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });

  // Se ainda não foi aceito, pode cancelar normalmente.
  if (chamado.status === 'aberto') {
    const agora = paraIso();
    chamado.status = 'cancelado';
    chamado.canceladoPor = 'cliente';
    chamado.dataCancelamento = agora;
    registrarEvento(chamado, 'cancelado', 'cliente', { descricao: 'Chamado cancelado pelo cliente', data: agora });
    await salvar();
    return res.json(montarChamado(chamado));
  }

  // Se foi aceito, permite cancelamento apenas dentro de 1 minuto desde o
  // dataAceite. Depois disso, o cliente não pode mais cancelar.
  if (chamado.status === 'aceito') {
    if (!chamado.dataAceite) {
      return res.status(409).json({ erro: 'Não foi possível verificar o tempo desde o aceite.' });
    }
    const dataAceite = new Date(chamado.dataAceite);
    const agora = new Date();
    const diffMs = agora - dataAceite;
    if (Number.isNaN(dataAceite.getTime()) || diffMs > 60 * 1000) {
      return res.status(409).json({ erro: 'Só é possível cancelar até 1 minuto após o aceite.' });
    }

    // Cancelamento dentro do prazo: o chamado é encerrado (não volta para a
    // fila — quem cancelou foi o próprio cliente) e o prestador vinculado
    // fica livre para aceitar outro.
    const prestadorQueTinhaOChamado = chamado.prestadorId;
    chamado.status = 'cancelado';
    chamado.canceladoPor = 'cliente';
    chamado.dataCancelamento = paraIso();
    chamado.prestadorId = null;
    chamado.dataAceite = null;
    registrarEvento(chamado, 'cancelado', 'cliente', {
      descricao: 'Chamado cancelado pelo cliente',
      data: chamado.dataCancelamento
    });
    // O prestador que já tinha aceitado precisa saber que o cliente desistiu.
    criarNotificacao(
      'prestador',
      prestadorQueTinhaOChamado,
      'cancelado_cliente',
      '⚠️ O cliente cancelou o chamado.',
      chamado.id,
      `cancelado_cliente:${chamado.id}:${prestadorQueTinhaOChamado}`
    );
    await salvar();
    return res.json(montarChamado(chamado));
  }

  return res.status(409).json({ erro: 'Só é possível cancelar enquanto não aceito ou dentro de 1 minuto após o aceite.' });
}));

// Prestador cancela o atendimento (aceito ou em_andamento -> cancelado).
// Diferente do comportamento antigo, o chamado NÃO volta para a fila: ele
// termina como "cancelado", fica no histórico (com quem cancelou, quando e o
// motivo) e o cliente é avisado. O prestador fica livre para aceitar outro.
// Corpo: { motivo: <código de MOTIVOS_CANCELAMENTO>, detalhe?: texto (obrigatório em "outro") }
app.post('/api/chamados/:id/cancelar-prestador', autenticar(['prestador']), assincrono(async (req, res) => {
  const chamado = validarAcaoPrestador(req, res, 'cancelar');
  if (!chamado) return;

  const { motivo, detalhe } = req.body || {};
  if (typeof motivo !== 'string' || !Object.prototype.hasOwnProperty.call(MOTIVOS_CANCELAMENTO, motivo)) {
    return res.status(400).json({ erro: 'Informe o motivo do cancelamento.' });
  }
  let detalheLimpo = null;
  if (motivo === 'outro') {
    detalheLimpo = typeof detalhe === 'string' ? detalhe.trim() : '';
    if (detalheLimpo.length < 3) {
      return res.status(400).json({ erro: 'Descreva o motivo do cancelamento.' });
    }
    if (detalheLimpo.length > MOTIVO_DETALHE_MAX) {
      return res.status(400).json({ erro: `A descrição do motivo deve ter no máximo ${MOTIVO_DETALHE_MAX} caracteres.` });
    }
  }

  const agora = paraIso();
  chamado.status = ACOES_PRESTADOR.cancelar.para;
  chamado.canceladoPor = 'prestador';
  chamado.dataCancelamento = agora;
  chamado.motivoCancelamento = motivo;
  chamado.motivoDetalhe = detalheLimpo;
  chamado.cancelamentoVisto = false; // o cliente ainda vai ver a tela de "cancelado"
  registrarEvento(chamado, 'cancelado', 'prestador', {
    descricao: 'Atendimento cancelado pelo prestador',
    mensagem: NOTIFICACOES.cancelado_prestador,
    detalhe: textoMotivoCancelamento(chamado),
    data: agora
  });
  await salvar();
  res.json(montarChamado(chamado));
}));

// O cliente viu que o atendimento foi cancelado pelo prestador/administração:
// a tela de acompanhamento pode voltar ao formulário de novo pedido. O chamado
// continua no histórico.
app.post('/api/chamados/:id/cancelamento-visto', autenticar(['cliente']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id && c.clienteId === req.sessao.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });
  if (chamado.status !== 'cancelado') {
    return res.status(409).json({ erro: 'Este chamado não foi cancelado.' });
  }
  if (!chamado.cancelamentoVisto) {
    chamado.cancelamentoVisto = true;
    await salvar();
  }
  res.json(montarChamado(chamado));
}));

// Histórico de chamados já finalizados (concluídos ou cancelados) do
// usuário logado — cliente vê os que ele abriu, prestador vê os que ele
// atendeu. Ordenado do mais recente para o mais antigo.
app.get('/api/chamados/historico', autenticar(), (req, res) => {
  const finalizados = ['concluido', 'cancelado'];
  const lista =
    req.sessao.tipo === 'cliente'
      ? db.chamados.filter((c) => c.clienteId === req.sessao.id && finalizados.includes(c.status))
      : db.chamados.filter((c) => c.prestadorId === req.sessao.id && finalizados.includes(c.status));

  res.json(
    lista
      .map(montarChamado)
      .sort((a, b) => new Date(b.dataAbertura) - new Date(a.dataAbertura))
  );
});

// Cliente avalia um chamado já concluído (nota de 1 a 5 + comentário
// opcional). A checagem "já foi avaliado?" é o que garante, no código,
// o mesmo efeito da restrição UNIQUE(id_chamado) do banco relacional:
// no máximo uma avaliação por chamado.
app.post('/api/chamados/:id/avaliacao', autenticar(['cliente']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id && c.clienteId === req.sessao.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });
  if (chamado.status !== 'concluido') {
    return res.status(409).json({ erro: 'Só é possível avaliar um chamado concluído.' });
  }
  if (db.avaliacoes.some((a) => a.chamadoId === chamado.id)) {
    return res.status(409).json({ erro: 'Este chamado já foi avaliado.' });
  }

  const notaNum = Number(req.body.nota);
  if (!Number.isInteger(notaNum) || notaNum < 1 || notaNum > 5) {
    return res.status(400).json({ erro: 'A nota deve ser um número inteiro de 1 a 5.' });
  }
  if (req.body.comentario !== undefined && (typeof req.body.comentario !== 'string' || req.body.comentario.length > 500)) {
    return res.status(400).json({ erro: 'O comentário deve ter no máximo 500 caracteres.' });
  }

  const avaliacao = {
    id: crypto.randomUUID(),
    chamadoId: chamado.id,
    nota: notaNum,
    comentario: req.body.comentario?.trim() || null,
    dataAvaliacao: paraIso()
  };
  db.avaliacoes.push(avaliacao);
  // O prestador que atendeu é avisado da nova avaliação.
  criarNotificacao(
    'prestador',
    chamado.prestadorId,
    'nova_avaliacao',
    `⭐ Você recebeu uma nova avaliação (nota ${notaNum}).`,
    chamado.id,
    `avaliacao:${avaliacao.id}`
  );
  await salvar();

  res.status(201).json(avaliacao);
}));

// ---------------------------------------------------------------
// Central de Notificações (cliente e prestador)
//
// Todas as rotas agem SEMPRE sobre o usuário da sessão: o id do dono nunca vem
// do navegador, e uma notificação de outro usuário responde 404 como se não
// existisse (não confirma que ela existe).
// ---------------------------------------------------------------

// Lista as notificações mais recentes e o total de NÃO LIDAS (contado sobre
// todas as do usuário, não só sobre as devolvidas).
app.get('/api/notificacoes', autenticar(['cliente', 'prestador']), (req, res) => {
  const minhas = notificacoesDoUsuario(req);
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), NOTIFICACOES_MAX_POR_USUARIO);
  res.json({
    naoLidas: minhas.filter((n) => !n.lida).length,
    notificacoes: [...minhas]
      .sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao))
      .slice(0, limite)
      .map(notificacaoPublica)
  });
});

// Marca todas as notificações do usuário como lidas.
app.post('/api/notificacoes/lidas', autenticar(['cliente', 'prestador']), assincrono(async (req, res) => {
  const agora = paraIso();
  let marcadas = 0;
  for (const n of notificacoesDoUsuario(req)) {
    if (!n.lida) {
      n.lida = true;
      n.dataLeitura = agora;
      marcadas += 1;
    }
  }
  if (marcadas > 0) await salvar();
  res.json({ naoLidas: 0, marcadas });
}));

// Marca UMA notificação como lida (idempotente: marcar de novo não muda nada).
app.post('/api/notificacoes/:id/lida', autenticar(['cliente', 'prestador']), assincrono(async (req, res) => {
  const minhas = notificacoesDoUsuario(req);
  const notificacao = minhas.find((n) => n.id === req.params.id);
  if (!notificacao) return res.status(404).json({ erro: 'Notificação não encontrada.' });
  if (!notificacao.lida) {
    notificacao.lida = true;
    notificacao.dataLeitura = paraIso();
    await salvar();
  }
  res.json({ naoLidas: minhas.filter((n) => !n.lida).length });
}));

// ---------------------------------------------------------------
// Administração (painel restrito, só acessível pela conta fixa de
// admin — ver ADMIN_EMAIL/ADMIN_SENHA e /api/auth/login-admin acima)
// ---------------------------------------------------------------

// Números gerais do sistema, para os cards do topo do painel admin.
app.get('/api/admin/estatisticas', autenticar(['admin']), (req, res) => {
  const porStatus = {};
  for (const chamado of db.chamados) {
    porStatus[chamado.status] = (porStatus[chamado.status] || 0) + 1;
  }
  res.json({
    totalClientes: db.clientes.length,
    totalPrestadores: db.prestadores.length,
    totalChamados: db.chamados.length,
    chamadosPorStatus: porStatus
  });
});

// Lista todos os clientes e prestadores cadastrados (sem senhaHash),
// para a tabela de usuários do painel admin.
app.get('/api/admin/usuarios', autenticar(['admin']), (req, res) => {
  res.json({
    clientes: db.clientes.map((c) => paraPublico('cliente', c)),
    prestadores: db.prestadores.map((p) => paraPublico('prestador', p))
  });
});

// Aprova um prestador pendente (só administrador). Se o prestador ainda não tem
// CPF/telefone (conta criada pelo Google), exige confirmação explícita do admin.
app.post('/api/admin/prestadores/:id/aprovar', autenticar(['admin']), assincrono(async (req, res) => {
  const prestador = db.prestadores.find((p) => p.id === req.params.id);
  if (!prestador) return res.status(404).json({ erro: 'Prestador não encontrado.' });
  if (prestador.aprovado === true) {
    return res.status(409).json({ erro: 'Este prestador já está aprovado.' });
  }
  // Prestador que entrou pelo Google nasce sem CPF e telefone (só são pedidos ao
  // aceitar o 1º chamado). Como ele só consegue logar DEPOIS de aprovado, não
  // dá para exigir que complete o perfil antes — bloquear a aprovação criaria
  // um impasse. Então o servidor exige uma CONFIRMAÇÃO EXPLÍCITA do admin
  // (confirmarSemPerfil: true): o admin é avisado de que está aprovando alguém
  // sem identificação, e decide. O painel mostra o aviso e reenvia com a flag.
  const faltam = pendenciasDePerfil(prestador);
  if (faltam.length > 0 && !(req.body && req.body.confirmarSemPerfil === true)) {
    return res.status(409).json({
      erro: 'Este prestador ainda não informou CPF e/ou telefone (conta criada pelo Google).',
      codigo: 'PERFIL_INCOMPLETO',
      faltam
    });
  }

  prestador.aprovado = true;
  await salvar();
  res.json(paraPublico('prestador', prestador));
}));

// Lista todos os chamados do sistema (qualquer status), com filtro
// opcional por status via query string — usada na tabela de chamados do
// painel admin.
app.get('/api/admin/chamados', autenticar(['admin']), (req, res) => {
  const { status } = req.query;
  const lista = db.chamados.filter((c) => !status || c.status === status);
  res.json(lista.map(montarChamado).sort((a, b) => new Date(b.dataAbertura) - new Date(a.dataAbertura)));
});

// Cancelamento por moderação: o admin pode encerrar qualquer chamado que
// ainda esteja em andamento, independente de prazos (diferente do
// cancelamento pelo próprio cliente, que tem a regra do 1 minuto).
app.post('/api/admin/chamados/:id/cancelar', autenticar(['admin']), assincrono(async (req, res) => {
  const chamado = db.chamados.find((c) => c.id === req.params.id);
  if (!chamado) return res.status(404).json({ erro: 'Chamado não encontrado.' });
  if (!STATUS_ATIVOS.includes(chamado.status)) {
    return res.status(409).json({ erro: 'Este chamado já está finalizado.' });
  }
  const agora = paraIso();
  chamado.status = 'cancelado';
  chamado.canceladoPor = 'admin';
  chamado.dataCancelamento = agora;
  chamado.cancelamentoVisto = false;
  registrarEvento(chamado, 'cancelado', 'admin', {
    descricao: 'Atendimento cancelado pela administração',
    mensagem: NOTIFICACOES.cancelado_admin,
    data: agora
  });
  // Atendimento atualizado: o prestador vinculado (se houver) também é avisado.
  criarNotificacao(
    'prestador',
    chamado.prestadorId,
    'atendimento_atualizado',
    NOTIFICACOES.cancelado_admin,
    chamado.id,
    `admin_cancelou:${chamado.id}:${chamado.prestadorId}`
  );
  await salvar();
  res.json(montarChamado(chamado));
}));

// Categorias: o admin pode ver e renomear (id continua fixo, 1/2/3/4).
app.get('/api/admin/categorias', autenticar(['admin']), (req, res) => {
  res.json(db.categorias);
});
// Renomeia uma categoria (só administrador). O id é fixo; só o nome muda.
app.patch('/api/admin/categorias/:id', autenticar(['admin']), assincrono(async (req, res) => {
  const categoria = db.categorias.find((c) => c.id === Number(req.params.id));
  if (!categoria) return res.status(404).json({ erro: 'Categoria não encontrada.' });
  if (typeof req.body.nome !== 'string' || !req.body.nome.trim() || req.body.nome.trim().length > 50) {
    return res.status(400).json({ erro: 'Informe um nome válido (até 50 caracteres).' });
  }
  categoria.nome = req.body.nome.trim();
  await salvar();
  res.json(categoria);
}));

// ---------------------------------------------------------------
// Funções auxiliares
//
// Ficam depois das rotas só por organização — em JavaScript, funções
// declaradas com "function" são "hoisted" (o interpretador já conhece
// todas elas antes de rodar o arquivo), então a ordem de declaração não
// importa para poder usá-las lá em cima.
// ---------------------------------------------------------------

// Busca um cliente ou prestador pelo id, dentro da coleção certa. O
// admin não fica em nenhuma coleção (é uma conta fixa, ver ADMIN_EMAIL
// acima) — devolvemos um objeto mínimo só para as rotas genéricas
// (como /api/auth/me) funcionarem sem caso especial.
function buscarUsuario(tipo, id) {
  if (tipo === 'admin') return { id: 'admin', nome: 'Administrador' };
  const colecao = tipo === 'cliente' ? db.clientes : db.prestadores;
  return colecao.find((u) => u.id === id);
}

// Prepara um usuário para ser enviado ao frontend: tira o campo
// "senhaHash" (nunca deve sair do servidor) e, se for prestador,
// acrescenta o nome da categoria (mais prático para exibir na tela do
// que só o id numérico).
function paraPublico(tipo, usuario) {
  const { senhaHash, googleId, ...resto } = usuario; // "..." copia tudo, menos o que foi desestruturado antes
  resto.pendencias = pendenciasDePerfil(usuario); // ex.: ['cpf','telefone'] em contas Google novas
  resto.contaGoogle = !!googleId;
  // O front precisa saber se a conta TEM senha (contas só-Google não têm) para
  // decidir se mostra os campos de troca de senha. O hash em si nunca sai daqui.
  resto.temSenha = !!senhaHash;
  resto.temSenha = !!senhaHash;
  if (tipo === 'prestador') {
    resto.categoriaNome = db.categorias.find((c) => c.id === usuario.categoriaId)?.nome;
    resto.aprovado = usuario.aprovado !== undefined ? Boolean(usuario.aprovado) : true;
  }
  return resto;
}

// Busca um chamado pelo id, mas só se ele pertencer ao prestador logado
// (evita que um prestador manipule o chamado de outro trocando o id na URL).
function pegarChamadoDoPrestador(req) {
  return db.chamados.find((c) => c.id === req.params.id && c.prestadorId === req.sessao.id);
}

// Versão "pública" de um chamado, sem nenhum dado pessoal do cliente —
// é o que qualquer prestador da categoria certa pode ver antes de aceitar.
function montarResumoChamado(chamado) {
  const categoria = db.categorias.find((c) => c.id === chamado.categoriaId);
  return {
    id: chamado.id,
    categoriaNome: categoria?.nome,
    endereco: chamado.endereco,
    descricao: chamado.descricao,
    status: chamado.status,
    dataAbertura: chamado.dataAbertura
  };
}

// Nota média (arredondada a 1 casa) e total de avaliações recebidas por
// um prestador, cruzando avaliacoes -> chamados pelo prestadorId. Usada
// tanto para mostrar a nota ao cliente (assim que o chamado é aceito)
// quanto na tela de perfil do próprio prestador.
function calcularNotaPrestador(prestadorId) {
  const notas = db.avaliacoes
    .filter((a) => db.chamados.some((c) => c.id === a.chamadoId && c.prestadorId === prestadorId))
    .map((a) => a.nota);

  if (notas.length === 0) return { media: null, total: 0 };
  const media = notas.reduce((soma, n) => soma + n, 0) / notas.length;
  return { media: Math.round(media * 10) / 10, total: notas.length };
}

// Versão completa do chamado, com os dados de cliente e (se já tiver
// sido aceito) do prestador — usada quando o chamado já "pertence" a
// quem está consultando: o próprio cliente que abriu, ou o prestador
// que aceitou.
function montarChamado(chamado) {
  const cliente = buscarUsuario('cliente', chamado.clienteId);
  const prestador = chamado.prestadorId ? buscarUsuario('prestador', chamado.prestadorId) : null;
  const categoria = db.categorias.find((c) => c.id === chamado.categoriaId);
  const avaliacao = db.avaliacoes.find((a) => a.chamadoId === chamado.id) || null;
  const notaPrestador = prestador ? calcularNotaPrestador(prestador.id) : null;

  return {
    ...chamado, // todos os campos originais do chamado (id, status, datas, etc.)
    categoriaNome: categoria?.nome,
    clienteNome: cliente?.nome,
    clienteTelefone: cliente?.telefone,
    prestadorNome: prestador?.nome || null,
    prestadorTelefone: prestador?.telefone || null,
    prestadorLatitude: prestador?.latitude ?? null,
    prestadorLongitude: prestador?.longitude ?? null,
    prestadorNotaMedia: notaPrestador?.media ?? null,
    prestadorTotalAvaliacoes: notaPrestador?.total ?? 0,
    avaliacao,
    motivoCancelamentoTexto: textoMotivoCancelamento(chamado),
    // Linha do tempo em ordem cronológica (a ordem do array já é a real).
    eventos: db.chamadoEventos
      .filter((e) => e.chamadoId === chamado.id)
      .map(({ chamadoId, ...evento }) => evento)
  };
}

// Texto do motivo de cancelamento para exibir ("Outro: <descrição>" quando o
// prestador escreveu o motivo). Null se o chamado não tem motivo.
function textoMotivoCancelamento(chamado) {
  if (!chamado.motivoCancelamento) return null;
  const rotulo = MOTIVOS_CANCELAMENTO[chamado.motivoCancelamento] || chamado.motivoCancelamento;
  return chamado.motivoDetalhe ? `${rotulo}: ${chamado.motivoDetalhe}` : rotulo;
}

// Rotas /api/* que não existem respondem JSON (em vez da página HTML de erro
// padrão do Express), que é o que o frontend sabe ler.
app.use('/api', (req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

// Último middleware: recebe qualquer erro das rotas (inclusive os das rotas
// async, via "assincrono") e do próprio Express, como JSON malformado. O
// tratamento padrão do Express devolveria uma página HTML com o stack trace
// — informação interna que não deve chegar ao usuário.
app.use((erro, req, res, next) => {
  if (res.headersSent) return next(erro);
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'Corpo da requisição inválido.' });
  }
  if (erro.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Requisição grande demais.' });
  }
  console.error(`Erro em ${req.method} ${req.path}:`, erro);
  res.status(500).json({ erro: 'Erro interno. Tente novamente em instantes.' });
});

// Rede de segurança: uma Promise rejeitada que ninguém tratou é registrada em
// vez de derrubar o servidor para todos os usuários.
process.on('unhandledRejection', (motivo) => {
  console.error('Promise rejeitada sem tratamento:', motivo);
});

const HOST = process.env.HOST || '0.0.0.0';
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;

// Cria o servidor HTTPS. Usa o certificado de TLS_CERT_FILE/TLS_KEY_FILE se
// configurados; senão gera (uma vez) e reutiliza um certificado autoassinado em
// .certs/ — bom para desenvolvimento, mas o navegador mostra um aviso de
// segurança. Em produção, use um certificado de verdade (ou um proxy com HTTPS).
async function criarServidor() {
  if (Boolean(TLS_CERT_FILE) !== Boolean(TLS_KEY_FILE)) {
    throw new Error('Configure TLS_CERT_FILE e TLS_KEY_FILE juntos para ativar HTTPS.');
  }
  if (TLS_CERT_FILE && TLS_KEY_FILE) {
    return https.createServer({
      cert: fs.readFileSync(TLS_CERT_FILE),
      key: fs.readFileSync(TLS_KEY_FILE)
    }, app);
  }

  const diretorioCertificados = path.resolve(__dirname, '..', '.certs');
  const arquivoCertificado = path.join(diretorioCertificados, 'localhost-cert.pem');
  const arquivoChave = path.join(diretorioCertificados, 'localhost-key.pem');
  if (!fs.existsSync(arquivoCertificado) || !fs.existsSync(arquivoChave)) {
    fs.mkdirSync(diretorioCertificados, { recursive: true });
    const ipLocal = obterIpLocal() || '127.0.0.1';
    const atributos = [{ name: 'commonName', value: 'localhost' }];
    const extensoes = [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', keyEncipherment: true, digitalSignature: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: ipLocal }
      ] }
    ];
    const certificado = await selfsigned.generate(atributos, {
      keySize: 2048,
      days: 365,
      extensions: extensoes
    });
    fs.writeFileSync(arquivoCertificado, certificado.cert);
    fs.writeFileSync(arquivoChave, certificado.private);
  }
  return https.createServer({
    cert: fs.readFileSync(arquivoCertificado),
    key: fs.readFileSync(arquivoChave)
  }, app);
}

// Primeiro endereço IPv4 da máquina que não seja interno (loopback). Usado só para
// mostrar no console o endereço de acesso pela rede local.
function obterIpLocal() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // procuramos por IPv4 não-interna (não loopback)
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

// As sessões só existem em memória: ao (re)iniciar o servidor ninguém está
// logado. Prestadores que ficaram gravados como "disponíveis" (por terem
// fechado a aba ou pelo servidor ter caído, sem "Sair") estariam aparecendo
// como disponíveis sem poder atender. Cada um volta a ativar o interruptor
// quando entrar de novo.
async function zerarDisponibilidadeDosPrestadores() {
  const disponiveis = db.prestadores.filter((p) => p.disponivel);
  if (disponiveis.length === 0) return;
  disponiveis.forEach((p) => {
    p.disponivel = false;
  });
  await salvar();
  console.log(`${disponiveis.length} prestador(es) estavam marcados como disponíveis sem sessão ativa; agora constam como indisponíveis.`);
}

inicializarBanco()
  .catch((erro) => {
    console.warn('Inicialização do banco falhou; iniciando servidor em modo fallback.', erro.message);
  })
  .then(zerarDisponibilidadeDosPrestadores)
  .then(criarServidor)
  .then((servidor) => {
    servidor.on('error', (erro) => {
      console.error(
        erro.code === 'EADDRINUSE'
          ? `A porta ${PORTA} já está em uso. Feche o outro processo ou defina outra porta em PORT.`
          : `Erro no servidor: ${erro.message}`
      );
      process.exit(1);
    });
    servidor.listen(PORTA, HOST, () => {
      const ipLocal = obterIpLocal();
      const protocolo = 'https';
      if (ipLocal) {
        console.log(`SOS Car rodando em:
  - ${protocolo}://localhost:${PORTA}
  - ${protocolo}://${ipLocal}:${PORTA} (rede local)`);
      } else {
        console.log(`SOS Car rodando em ${protocolo}://localhost:${PORTA} (host ${HOST})`);
      }
    });
  })
  .catch((erro) => {
    // Ex.: só uma das variáveis TLS_* definida, ou arquivo de certificado ausente.
    console.error('Não foi possível iniciar o servidor:', erro.message);
    process.exit(1);
  });
