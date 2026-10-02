// =================================================================
// Verificação do ID token do "Entrar com o Google".
//
// O que mudou em relação à versão anterior
// ----------------------------------------
// Antes o servidor mandava o token para o endpoint /tokeninfo do Google, que
// a própria documentação do Google descreve como ferramenta de depuração:
// uma chamada de rede a cada login (com timeout) e dependência da
// disponibilidade desse endpoint.
//
// Agora a assinatura é conferida AQUI, localmente, como recomendado pelo
// Google: o ID token é um JWT assinado com RS256, e as chaves públicas que
// o validam (JWKS) ficam em cache. Só usa módulos nativos do Node (crypto e
// fetch), sem dependências novas.
//
// O que é verificado em cada token
//   1. Formato: três partes (cabeçalho.corpo.assinatura) em base64url.
//   2. Algoritmo: SOMENTE RS256. Recusar "none"/HS256 impede o ataque de
//      "confusão de algoritmo", em que o invasor assina com uma chave que ele
//      mesmo escolhe.
//   3. Assinatura: confere com a chave pública do Google indicada em "kid".
//   4. iss (emissor): tem de ser o Google.
//   5. aud (destinatário): tem de ser o NOSSO Client ID — um token emitido
//      para o app de outra pessoa não vale aqui.
//   6. azp (parte autorizada), quando presente, também tem de ser o nosso.
//   7. exp / iat (validade), com 60 s de tolerância para relógios diferentes.
//   8. email_verified: o Google precisa ter confirmado o e-mail.
//   9. nonce: valor aleatório emitido pelo NOSSO servidor, de uso único.
//      Impede o "replay": um token roubado/copiado não serve uma 2ª vez.
//  10. (opcional) hd: restringe a um domínio Google Workspace.
// =================================================================
const crypto = require('crypto');

// Endereço das chaves públicas do Google. Pode ser trocado por variável de
// ambiente (usado nos testes automatizados, que simulam o Google).
const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';

// Valores aceitos no campo "iss" (o Google usa as duas grafias).
const EMISSORES_GOOGLE = ['accounts.google.com', 'https://accounts.google.com'];

const TOLERANCIA_RELOGIO_S = 60; // diferença de relógio aceita entre nós e o Google
const JWKS_TTL_PADRAO_MS = 60 * 60 * 1000; // se o Google não informar o prazo do cache
const JWKS_INTERVALO_MIN_MS = 60 * 1000; // no máximo 1 download das chaves por minuto
const TIMEOUT_REDE_MS = 6000;

// ---------------------------------------------------------------
// Cache das chaves públicas do Google (JWKS)
// ---------------------------------------------------------------
let chaves = new Map(); // kid -> chave pública (KeyObject do Node)
let chavesExpiramEm = 0; // quando o cache deixa de valer
let ultimaBusca = 0; // quando baixamos as chaves pela última vez
let buscaEmCurso = null; // Promise da busca em andamento (evita downloads duplicados)

// Lê o "max-age" do cabeçalho Cache-Control para saber por quanto tempo o
// Google permite guardar as chaves.
function ttlDoCabecalho(cabecalho) {
  const m = /max-age=(\d+)/i.exec(cabecalho || '');
  return m ? Number(m[1]) * 1000 : JWKS_TTL_PADRAO_MS;
}

// Baixa o conjunto de chaves e converte cada uma em objeto de chave do Node.
async function baixarChaves() {
  const resposta = await fetch(JWKS_URL, { signal: AbortSignal.timeout(TIMEOUT_REDE_MS) });
  if (!resposta.ok) throw new Error(`JWKS HTTP ${resposta.status}`);
  const corpo = await resposta.json();
  if (!corpo || !Array.isArray(corpo.keys)) throw new Error('JWKS em formato inesperado');

  const novas = new Map();
  for (const jwk of corpo.keys) {
    if (jwk && jwk.kty === 'RSA' && typeof jwk.kid === 'string') {
      novas.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
  }
  if (novas.size === 0) throw new Error('JWKS sem chaves RSA');

  chaves = novas;
  chavesExpiramEm = Date.now() + ttlDoCabecalho(resposta.headers.get('cache-control'));
  ultimaBusca = Date.now();
}

// Devolve a chave pública do "kid" pedido, atualizando o cache quando preciso.
// - Cache vencido, ou "kid" desconhecido (o Google gira as chaves de tempos
//   em tempos): tenta baixar de novo, no máximo 1x por minuto — assim um
//   invasor que envia tokens com "kid" inventado não nos faz baixar o JWKS
//   a cada requisição.
// - Se o download falhar, usa o que já está em cache (se tiver o "kid"):
//   uma queda breve do Google não derruba o login de quem já tem chave.
async function obterChave(kid) {
  const agora = Date.now();
  const vencido = agora >= chavesExpiramEm;
  const kidDesconhecido = !chaves.has(kid);

  if ((vencido || kidDesconhecido) && agora - ultimaBusca >= JWKS_INTERVALO_MIN_MS) {
    if (!buscaEmCurso) {
      buscaEmCurso = baixarChaves()
        .catch((erro) => console.warn('[google] Falha ao baixar as chaves do Google:', erro.message))
        .finally(() => {
          buscaEmCurso = null;
        });
    }
    await buscaEmCurso;
    // Registra a tentativa mesmo se falhou, para respeitar o intervalo mínimo.
    ultimaBusca = Math.max(ultimaBusca, agora);
  }
  return chaves.get(kid) || null;
}

// ---------------------------------------------------------------
// Nonce de uso único (proteção contra replay)
//
// Fluxo: o navegador pede um nonce (GET /api/auth/google/nonce), entrega ao
// Google ao inicializar o botão, e o Google o embute DENTRO do token
// assinado. Na hora do login conferimos que o nonce do token é um dos que
// NÓS emitimos, que não venceu e que ainda não foi usado — e o consumimos.
// ---------------------------------------------------------------
const NONCE_TTL_MS = 15 * 60 * 1000; // quanto tempo o usuário tem para clicar
const NONCE_MAX_PENDENTES = 5000; // teto de memória (alguém pedindo nonces sem parar)
const nonces = new Map(); // nonce -> instante de expiração (Map mantém a ordem de inserção)

function limparNoncesVencidos() {
  const agora = Date.now();
  for (const [nonce, expiraEm] of nonces) {
    if (expiraEm <= agora) nonces.delete(nonce);
  }
}
setInterval(limparNoncesVencidos, 60 * 1000).unref();

// Cria e guarda um nonce novo (256 bits de aleatoriedade não adivinhável).
function gerarNonce() {
  if (nonces.size >= NONCE_MAX_PENDENTES) {
    limparNoncesVencidos();
    // Ainda cheio: descarta o mais antigo (o primeiro da ordem de inserção).
    if (nonces.size >= NONCE_MAX_PENDENTES) nonces.delete(nonces.keys().next().value);
  }
  const nonce = crypto.randomBytes(32).toString('base64url');
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

// Só consulta (não gasta): serve para validar o token ANTES de decidir se o
// login vai mesmo prosseguir (ex.: pedir confirmação de vínculo ao usuário).
function nonceValido(nonce) {
  return typeof nonce === 'string' && (nonces.get(nonce) || 0) > Date.now();
}

// Gasta o nonce. Devolve true UMA única vez por nonce; chamadas seguintes
// (replay) devolvem false. É síncrona de propósito: duas requisições
// simultâneas com o mesmo token nunca passam juntas.
function consumirNonce(nonce) {
  const valido = nonceValido(nonce);
  nonces.delete(nonce);
  return valido;
}

// ---------------------------------------------------------------
// Verificação do token
// ---------------------------------------------------------------

// Decodifica uma parte do JWT (base64url -> objeto JSON). Lança erro se inválida.
function decodificarParte(parte) {
  return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8'));
}

const falha = (motivo) => ({ ok: false, motivo });

// Verifica o ID token. NUNCA lança: devolve { ok: false, motivo } ou
// { ok: true, dados: { sub, email, nome, nonce } }.
// O "motivo" é só para o log do servidor — para o usuário a resposta é
// sempre a mesma mensagem genérica (não ajudamos quem está testando tokens).
//
// opcoes: { clientId (obrigatório), dominioPermitido (opcional, valida "hd") }
async function verificarIdToken(credential, { clientId, dominioPermitido } = {}) {
  if (!clientId) return falha('client_id_ausente');
  if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096) {
    return falha('formato');
  }
  const partes = credential.split('.');
  if (partes.length !== 3) return falha('formato');

  let cabecalho;
  let corpo;
  try {
    cabecalho = decodificarParte(partes[0]);
    corpo = decodificarParte(partes[1]);
  } catch {
    return falha('formato');
  }
  if (!cabecalho || !corpo || typeof cabecalho !== 'object' || typeof corpo !== 'object') {
    return falha('formato');
  }

  // 2) Só RS256. Qualquer outro algoritmo (inclusive "none") é recusado.
  if (cabecalho.alg !== 'RS256' || typeof cabecalho.kid !== 'string') return falha('algoritmo');

  // 3) Assinatura.
  const chave = await obterChave(cabecalho.kid);
  if (!chave) return falha('chave_desconhecida');
  let assinaturaOk = false;
  try {
    assinaturaOk = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${partes[0]}.${partes[1]}`),
      chave,
      Buffer.from(partes[2], 'base64url')
    );
  } catch {
    assinaturaOk = false;
  }
  if (!assinaturaOk) return falha('assinatura');

  // 4–6) Emissor, destinatário e parte autorizada.
  if (!EMISSORES_GOOGLE.includes(corpo.iss)) return falha('emissor');
  if (corpo.aud !== clientId) return falha('audiencia');
  if (corpo.azp !== undefined && corpo.azp !== clientId) return falha('azp');

  // 7) Validade (com tolerância de relógio).
  const agoraS = Math.floor(Date.now() / 1000);
  if (typeof corpo.exp !== 'number' || corpo.exp + TOLERANCIA_RELOGIO_S < agoraS) return falha('expirado');
  if (typeof corpo.iat === 'number' && corpo.iat - TOLERANCIA_RELOGIO_S > agoraS) return falha('emitido_no_futuro');

  // 8) E-mail confirmado pelo Google.
  if (corpo.email_verified !== true && corpo.email_verified !== 'true') return falha('email_nao_verificado');
  if (typeof corpo.sub !== 'string' || !corpo.sub || typeof corpo.email !== 'string') return falha('campos');

  // 9) Nonce emitido por nós, ainda válido (o consumo é feito por quem chama).
  if (!nonceValido(corpo.nonce)) return falha('nonce');

  // 10) Restrição opcional a um domínio do Google Workspace.
  if (dominioPermitido && corpo.hd !== dominioPermitido) return falha('dominio');

  const email = corpo.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) return falha('email_invalido');
  const nome = (typeof corpo.name === 'string' && corpo.name.trim()) || email.split('@')[0];

  return {
    ok: true,
    dados: {
      sub: corpo.sub.slice(0, 64),
      email,
      nome: nome.trim().slice(0, 120),
      nonce: corpo.nonce
    }
  };
}

// Só para os testes automatizados: zera o cache de chaves e os nonces.
function _reiniciarParaTestes() {
  chaves = new Map();
  chavesExpiramEm = 0;
  ultimaBusca = 0;
  buscaEmCurso = null;
  nonces.clear();
}

module.exports = { verificarIdToken, gerarNonce, consumirNonce, nonceValido, _reiniciarParaTestes };
