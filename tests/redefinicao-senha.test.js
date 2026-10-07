// // =================================================================
// // Testes do fluxo de redefinição de senha por código de 6 dígitos.
// // Sobe o servidor de verdade (porta 3977, banco em memória, SEM SMTP) e
// // conversa com ele por HTTPS. O código é lido do terminal do servidor, o que
// // só é possível porque o teste liga MOSTRAR_CODIGO_REDEFINICAO_NO_CONSOLE.
// // Rodar com:  npm test
// // =================================================================
// const test = require('node:test');
// const assert = require('node:assert/strict');
// const { spawn } = require('node:child_process');
// const https = require('node:https');
// const path = require('node:path');

// const PORTA = 3977;
// let servidor;
// let saida = '';
// let ipSeq = 10;

// function esperar(ms) {
//   return new Promise((r) => setTimeout(r, ms));
// }

// function chamar(rota, corpo, ip) {
//   return new Promise((resolve, reject) => {
//     const dados = JSON.stringify(corpo || {});
//     const req = https.request(
//       {
//         host: '127.0.0.1',
//         port: PORTA,
//         path: rota,
//         method: 'POST',
//         rejectUnauthorized: false,
//         headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados), 'X-Forwarded-For': ip || `10.1.0.${++ipSeq}` }
//       },
//       (res) => {
//         let texto = '';
//         res.on('data', (c) => (texto += c));
//         res.on('end', () => resolve({ status: res.statusCode, corpo: texto ? JSON.parse(texto) : null }));
//       }
//     );
//     req.on('error', reject);
//     req.end(dados);
//   });
// }

// // Espera aparecer no log do servidor o código mais novo para este e-mail.
// async function lerCodigo(email, quantosJaLidos = 0) {
//   const mascara = `${email.slice(0, 2)}***@${email.split('@')[1]}`;
//   const re = new RegExp(`Código de redefinição para ${mascara.replace(/[*.]/g, '\\$&')}: (\\d{6})`, 'g');
//   for (let i = 0; i < 60; i += 1) {
//     const achados = [...saida.matchAll(re)].map((m) => m[1]);
//     if (achados.length > quantosJaLidos) return achados[achados.length - 1];
//     await esperar(100);
//   }
//   return null;
// }

// // CPF válido (com dígitos verificadores) diferente para cada conta de teste.
// function gerarCpf(n) {
//   const base = String(100000000 + n * 7919).slice(0, 9).split('').map(Number);
//   const dv = (nums) => {
//     const soma = nums.reduce((acc, d, i) => acc + d * (nums.length + 1 - i), 0);
//     const resto = (soma * 10) % 11;
//     return resto === 10 ? 0 : resto;
//   };
//   const d1 = dv(base);
//   const d2 = dv([...base, d1]);
//   return [...base, d1, d2].join('');
// }

// let contador = 0;
// async function criarConta(senha = 'senha-antiga') {
//   contador += 1;
//   // As duas primeiras letras do e-mail são únicas por conta: o log do servidor
//   // mascara o e-mail (ab***@...), e assim cada código é achado sem confusão.
//   const email = `${String.fromCharCode(97 + Math.floor(contador / 26))}${String.fromCharCode(97 + (contador % 26))}.teste@exemplo.com`;
//   const r = await chamar('/api/auth/registrar', {
//     tipo: 'cliente',
//     nome: `Teste ${contador}`,
//     email,
//     senha,
//     telefone: '11999999999',
//     cpf: gerarCpf(contador)
//   });
//   assert.equal(r.status, 201, JSON.stringify(r.corpo));
//   return email;
// }

// async function pedirCodigo(email, lidos = 0) {
//   const r = await chamar('/api/auth/esqueci-senha', { email });
//   assert.equal(r.status, 200);
//   return lerCodigo(email, lidos);
// }

// const login = (email, senha) => chamar('/api/auth/login', { email, senha });

// test.before(async () => {
//   servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
//     env: {
//       ...process.env,
//       PORT: String(PORTA),
//       HOST: '127.0.0.1',
//       NODE_ENV: 'test',
//       DB_HOST: '127.0.0.1',
//       DB_PORT: '1', // inexistente: força o modo em memória
//       SMTP_USER: '',
//       SMTP_PASS: '',
//       MOSTRAR_CODIGO_REDEFINICAO_NO_CONSOLE: '1',
//       TRUST_PROXY: '1',
//       TESTE_CODIGO_INTERVALO_MS: '50',
//       TESTE_CODIGO_TTL_MS: '4000'
//     }
//   });
//   servidor.stdout.on('data', (d) => (saida += d));
//   servidor.stderr.on('data', (d) => (saida += d));
//   for (let i = 0; i < 100; i += 1) {
//     if (/SOS Car rodando|https:\/\/localhost/.test(saida)) return;
//     await esperar(100);
//   }
//   throw new Error('Servidor não subiu:\n' + saida);
// });

// test.after(() => servidor && servidor.kill());

// test('1) fluxo completo: código certo -> nova senha -> login com a nova senha', async () => {
//   const email = await criarConta('senha-antiga');
//   const codigo = await pedirCodigo(email);
//   assert.match(codigo, /^\d{6}$/);

//   const v = await chamar('/api/auth/validar-codigo', { email, codigo });
//   assert.equal(v.status, 200);
//   assert.ok(v.corpo.resetToken && v.corpo.resetToken.length >= 40);
//   assert.ok(!JSON.stringify(v.corpo).includes(codigo), 'a API não pode devolver o código');

//   const r = await chamar('/api/auth/redefinir-senha', { token: v.corpo.resetToken, novaSenha: 'senha-nova-1' });
//   assert.equal(r.status, 200);

//   assert.equal((await login(email, 'senha-antiga')).status, 401);
//   assert.equal((await login(email, 'senha-nova-1')).status, 200);
// });

// test('2) código incorreto -> mensagem de erro', async () => {
//   const email = await criarConta();
//   const codigo = await pedirCodigo(email);
//   const errado = codigo === '000000' ? '000001' : '000000';
//   const v = await chamar('/api/auth/validar-codigo', { email, codigo: errado });
//   assert.equal(v.status, 400);
//   assert.equal(v.corpo.erro, 'Esse código não está correto.');
//   assert.equal(v.corpo.resetToken, undefined);
// });

// test('3) código expirado -> bloqueio', async () => {
//   const email = await criarConta();
//   const codigo = await pedirCodigo(email);
//   await esperar(4300); // TTL de teste = 4 s
//   const v = await chamar('/api/auth/validar-codigo', { email, codigo });
//   assert.equal(v.status, 400);
//   assert.equal(v.corpo.erro, 'Esse código expirou. Solicite um novo código.');
// });

// test('4) código usado de novo -> bloqueio; token também é de uso único', async () => {
//   const email = await criarConta();
//   const codigo = await pedirCodigo(email);
//   const v1 = await chamar('/api/auth/validar-codigo', { email, codigo });
//   assert.equal(v1.status, 200);
//   const v2 = await chamar('/api/auth/validar-codigo', { email, codigo });
//   assert.equal(v2.status, 400);
//   assert.equal(v2.corpo.resetToken, undefined);

//   assert.equal((await chamar('/api/auth/redefinir-senha', { token: v1.corpo.resetToken, novaSenha: 'outra-senha' })).status, 200);
//   const reuso = await chamar('/api/auth/redefinir-senha', { token: v1.corpo.resetToken, novaSenha: 'terceira-senha' });
//   assert.equal(reuso.status, 400);
//   assert.equal((await login(email, 'outra-senha')).status, 200);
//   assert.equal((await login(email, 'terceira-senha')).status, 401);
// });

// test('5) mais de 5 tentativas -> bloqueio, mesmo digitando o código certo depois', async () => {
//   const email = await criarConta();
//   const codigo = await pedirCodigo(email);
//   const errado = codigo === '000000' ? '000001' : '000000';
//   for (let i = 0; i < 4; i += 1) {
//     const r = await chamar('/api/auth/validar-codigo', { email, codigo: errado });
//     assert.equal(r.status, 400);
//   }
//   const quinta = await chamar('/api/auth/validar-codigo', { email, codigo: errado });
//   assert.equal(quinta.status, 429);
//   assert.equal(quinta.corpo.erro, 'Você excedeu o número de tentativas. Solicite um novo código.');
//   const certo = await chamar('/api/auth/validar-codigo', { email, codigo });
//   assert.equal(certo.status, 429);
//   assert.equal(certo.corpo.resetToken, undefined);
// });

// test('6) novo código invalida o antigo', async () => {
//   const email = await criarConta();
//   const antigo = await pedirCodigo(email);
//   await esperar(120); // passa o intervalo mínimo de teste
//   const novo = await pedirCodigo(email, 1);
//   assert.notEqual(novo, null);
//   if (novo === antigo) return; // 1 chance em 1 milhão de coincidir: nada a provar
//   const v1 = await chamar('/api/auth/validar-codigo', { email, codigo: antigo });
//   assert.equal(v1.status, 400);
//   const v2 = await chamar('/api/auth/validar-codigo', { email, codigo: novo });
//   assert.equal(v2.status, 200);
// });

// test('7) senhas diferentes / vazia / curta: o servidor recusa e o token não é gasto', async () => {
//   const email = await criarConta('senha-antiga');
//   const codigo = await pedirCodigo(email);
//   const v = await chamar('/api/auth/validar-codigo', { email, codigo });
//   const token = v.corpo.resetToken;
//   assert.equal((await chamar('/api/auth/redefinir-senha', { token, novaSenha: '' })).status, 400);
//   assert.equal((await chamar('/api/auth/redefinir-senha', { token, novaSenha: 'abc' })).status, 400);
//   // a confirmação ("As senhas não coincidem.") é validada na tela antes de enviar;
//   // aqui provamos que nada foi alterado e que o token continua utilizável:
//   assert.equal((await login(email, 'senha-antiga')).status, 200);
//   assert.equal((await chamar('/api/auth/redefinir-senha', { token, novaSenha: 'senha-valida' })).status, 200);
// });

// test('8) e-mail inexistente: mesma resposta, nada de código, mesmo bloqueio de tentativas', async () => {
//   const existente = await criarConta();
//   const a = await chamar('/api/auth/esqueci-senha', { email: existente });
//   const b = await chamar('/api/auth/esqueci-senha', { email: 'nao-existe@exemplo.com' });
//   assert.deepEqual(a, b);
//   await esperar(300);
//   assert.ok(!saida.includes('Código de redefinição para na***@exemplo.com'));

//   const ip = '10.9.9.9';
//   let ultimo;
//   for (let i = 0; i < 5; i += 1) ultimo = await chamar('/api/auth/validar-codigo', { email: 'nao-existe@exemplo.com', codigo: '123456' }, ip);
//   assert.equal(ultimo.status, 429);
//   assert.equal(ultimo.corpo.erro, 'Você excedeu o número de tentativas. Solicite um novo código.');
// });

// test('9) nova senha sem validar o código: token inventado ou ausente é recusado', async () => {
//   const email = await criarConta('senha-antiga');
//   await pedirCodigo(email);
//   for (const token of [undefined, '', 'abc', 'a'.repeat(64), '0'.repeat(64)]) {
//     const r = await chamar('/api/auth/redefinir-senha', { token, novaSenha: 'senha-invasor' });
//     assert.equal(r.status, 400);
//   }
//   assert.equal((await login(email, 'senha-antiga')).status, 200);
//   // o token de SESSÃO do login não serve como token de redefinição
//   const sessao = (await login(email, 'senha-antiga')).corpo.token;
//   assert.equal((await chamar('/api/auth/redefinir-senha', { token: sessao, novaSenha: 'senha-invasor' })).status, 400);
// });

// test('limite de pedidos por conta (5 por hora) e código nunca aparece na resposta', async () => {
//   const email = await criarConta();
//   let lidos = 0;
//   for (let i = 0; i < 5; i += 1) {
//     await esperar(120);
//     const c = await pedirCodigo(email, lidos);
//     assert.match(c, /^\d{6}$/);
//     lidos += 1;
//   }
//   await esperar(120);
//   const r = await chamar('/api/auth/esqueci-senha', { email });
//   assert.equal(r.status, 200); // resposta idêntica...
//   await esperar(500);
//   const achados = [...saida.matchAll(new RegExp(`Código de redefinição para ${email.slice(0, 2)}\\*\\*\\*@exemplo\\.com: \\d{6}`, 'g'))];
//   assert.equal(achados.length, 5); // ...mas o 6º código não foi gerado
// });
