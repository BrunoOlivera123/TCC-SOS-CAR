// // =================================================================
// // Testes da verificação do ID token do Google (server/google-auth.js).
// //
// // Não usa a internet: um servidor HTTP local faz o papel do endpoint de
// // chaves públicas do Google (JWKS) e os tokens são assinados aqui mesmo com
// // uma chave RSA gerada no início do teste.
// // Rodar com:  npm test
// // =================================================================
// const test = require('node:test');
// const assert = require('node:assert/strict');
// const crypto = require('node:crypto');
// const http = require('node:http');

// const CLIENT_ID = '123456-teste.apps.googleusercontent.com';
// const KID = 'chave-de-teste-1';

// // Chave "do Google" (a pública é servida no JWKS) e uma chave de invasor.
// const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// const invasor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

// let servidor;
// let modulo; // google-auth.js, carregado depois de apontar o JWKS para o servidor local

// test.before(async () => {
//   servidor = http.createServer((req, res) => {
//     const jwk = { ...google.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
//     res.setHeader('Content-Type', 'application/json');
//     res.setHeader('Cache-Control', 'public, max-age=3600');
//     res.end(JSON.stringify({ keys: [jwk] }));
//   });
//   await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
//   // O módulo lê GOOGLE_JWKS_URL ao ser carregado: define ANTES do require.
//   process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${servidor.address().port}/certs`;
//   modulo = require('../server/google-auth');
// });

// test.after(() => servidor.close());

// test.beforeEach(() => modulo._reiniciarParaTestes());

// // Monta um JWT assinado. "sobrescrever" altera campos do corpo; "opcoes" permite
// // trocar a chave de assinatura, o algoritmo declarado e o kid.
// function criarToken(sobrescrever = {}, { chave = google.privateKey, alg = 'RS256', kid = KID, assinar = true } = {}) {
//   const agora = Math.floor(Date.now() / 1000);
//   const corpo = {
//     iss: 'https://accounts.google.com',
//     aud: CLIENT_ID,
//     azp: CLIENT_ID,
//     sub: '1098765432100',
//     email: 'Pessoa@Exemplo.com',
//     email_verified: true,
//     name: 'Pessoa Teste',
//     iat: agora,
//     exp: agora + 3600,
//     nonce: modulo.gerarNonce(),
//     ...sobrescrever
//   };
//   const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
//   const cabecalho = b64({ alg, typ: 'JWT', kid });
//   const dados = `${cabecalho}.${b64(corpo)}`;
//   const assinatura = assinar ? crypto.sign('RSA-SHA256', Buffer.from(dados), chave).toString('base64url') : '';
//   return `${dados}.${assinatura}`;
// }

// const verificar = (token, extra = {}) => modulo.verificarIdToken(token, { clientId: CLIENT_ID, ...extra });

// test('aceita um token válido e normaliza o e-mail', async () => {
//   const r = await verificar(criarToken());
//   assert.equal(r.ok, true);
//   assert.equal(r.dados.email, 'pessoa@exemplo.com');
//   assert.equal(r.dados.sub, '1098765432100');
//   assert.equal(r.dados.nome, 'Pessoa Teste');
// });

// test('recusa token emitido para outro Client ID (aud)', async () => {
//   const r = await verificar(criarToken({ aud: 'outro-app.apps.googleusercontent.com' }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'audiencia']);
// });

// test('recusa azp diferente do nosso Client ID', async () => {
//   const r = await verificar(criarToken({ azp: 'outro-app' }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'azp']);
// });

// test('recusa emissor que não é o Google', async () => {
//   const r = await verificar(criarToken({ iss: 'https://site-falso.com' }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'emissor']);
// });

// test('recusa token expirado (além da tolerância de relógio)', async () => {
//   const r = await verificar(criarToken({ exp: Math.floor(Date.now() / 1000) - 600 }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'expirado']);
// });

// test('recusa e-mail não verificado', async () => {
//   const r = await verificar(criarToken({ email_verified: false }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'email_nao_verificado']);
// });

// test('recusa assinatura feita com outra chave (token forjado)', async () => {
//   const r = await verificar(criarToken({}, { chave: invasor.privateKey }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'assinatura']);
// });

// test('recusa corpo adulterado depois de assinado', async () => {
//   const token = criarToken();
//   const [h, , s] = token.split('.');
//   const corpoFalso = Buffer.from(JSON.stringify({
//     iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'outra-pessoa', email: 'vitima@exemplo.com',
//     email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, nonce: modulo.gerarNonce()
//   })).toString('base64url');
//   const r = await verificar(`${h}.${corpoFalso}.${s}`);
//   assert.deepEqual([r.ok, r.motivo], [false, 'assinatura']);
// });

// test('recusa algoritmo "none" e HS256 (confusão de algoritmo)', async () => {
//   const semAssinatura = await verificar(criarToken({}, { alg: 'none', assinar: false }));
//   assert.deepEqual([semAssinatura.ok, semAssinatura.motivo], [false, 'algoritmo']);
//   const hs = await verificar(criarToken({}, { alg: 'HS256' }));
//   assert.deepEqual([hs.ok, hs.motivo], [false, 'algoritmo']);
// });

// test('recusa kid desconhecido', async () => {
//   const r = await verificar(criarToken({}, { kid: 'kid-que-nao-existe' }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'chave_desconhecida']);
// });

// test('recusa nonce que o servidor nunca emitiu', async () => {
//   const r = await verificar(criarToken({ nonce: 'inventado-pelo-invasor' }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'nonce']);
// });

// test('recusa token sem nonce', async () => {
//   const r = await verificar(criarToken({ nonce: undefined }));
//   assert.deepEqual([r.ok, r.motivo], [false, 'nonce']);
// });

// test('nonce é de uso único (anti-replay)', async () => {
//   const r = await verificar(criarToken());
//   assert.equal(r.ok, true);
//   // A verificação só consulta o nonce; quem decide prosseguir é que o consome:
//   assert.equal(modulo.consumirNonce(r.dados.nonce), true); // 1ª vez: ok
//   assert.equal(modulo.consumirNonce(r.dados.nonce), false); // replay: recusado
//   const mesmoNonceDeNovo = await verificar(criarToken({ nonce: r.dados.nonce }));
//   assert.deepEqual([mesmoNonceDeNovo.ok, mesmoNonceDeNovo.motivo], [false, 'nonce']);
// });

// test('verificar não gasta o nonce (permite reenviar após confirmação do usuário)', async () => {
//   const token = criarToken();
//   assert.equal((await verificar(token)).ok, true);
//   assert.equal((await verificar(token)).ok, true); // ainda vale
// });

// test('restrição de domínio (hd) só aceita o domínio configurado', async () => {
//   const certo = await verificar(criarToken({ hd: 'empresa.com' }), { dominioPermitido: 'empresa.com' });
//   assert.equal(certo.ok, true);
//   const errado = await verificar(criarToken({ hd: 'outra.com' }), { dominioPermitido: 'empresa.com' });
//   assert.deepEqual([errado.ok, errado.motivo], [false, 'dominio']);
//   const semHd = await verificar(criarToken(), { dominioPermitido: 'empresa.com' });
//   assert.deepEqual([semHd.ok, semHd.motivo], [false, 'dominio']);
// });

// test('recusa entradas que não são JWT, sem lançar exceção', async () => {
//   for (const lixo of [undefined, null, 42, '', 'abc', 'a.b.c', 'x'.repeat(5000), '....................']) {
//     const r = await verificar(lixo);
//     assert.equal(r.ok, false);
//   }
// });

// test('sem Client ID configurado, nada é aceito', async () => {
//   const r = await modulo.verificarIdToken(criarToken(), { clientId: '' });
//   assert.deepEqual([r.ok, r.motivo], [false, 'client_id_ausente']);
// });
