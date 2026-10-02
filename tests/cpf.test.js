// // =================================================================
// // Testes da validação de CPF (server/utils/cpf.js).
// // Rodar com:  npm test
// // =================================================================
// const test = require('node:test');
// const assert = require('node:assert/strict');
// const { cpfValido } = require('../server/utils/cpf');

// test('aceita CPFs válidos, com e sem máscara', () => {
//   assert.equal(cpfValido('529.982.247-25'), true);
//   assert.equal(cpfValido('52998224725'), true);
// });

// test('recusa dígitos verificadores errados', () => {
//   assert.equal(cpfValido('529.982.247-26'), false); // último dígito trocado
//   assert.equal(cpfValido('123.456.789-00'), false);
// });

// test('recusa sequências repetidas (passam na conta, mas não existem)', () => {
//   for (let d = 0; d <= 9; d += 1) {
//     assert.equal(cpfValido(String(d).repeat(11)), false);
//   }
// });

// test('recusa tamanho errado e entradas que não são texto de CPF', () => {
//   assert.equal(cpfValido('1234567890'), false); // 10 dígitos
//   assert.equal(cpfValido('529982247251'), false); // 12 dígitos
//   assert.equal(cpfValido(''), false);
//   assert.equal(cpfValido(null), false);
//   assert.equal(cpfValido(undefined), false);
// });
