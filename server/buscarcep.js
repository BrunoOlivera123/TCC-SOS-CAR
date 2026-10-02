// =================================================================
// Consulta de CEP no serviço BuscarCEP (https://buscarcep.com.br).
//
// Dado um CEP, devolve os dados do endereço (rua, bairro, cidade...) para
// preencher o formulário automaticamente.
//
// STATUS: o módulo está pronto, mas AINDA NÃO é chamado por nenhuma rota do
// servidor (ver server/testar-buscarcep.js para um exemplo de uso). Para
// ligá-lo, crie uma rota em server.js que chame consultarCEP().
//
// Configuração: a chave de acesso vem da variável BUSCARCEP_CHAVE (.env).
// =================================================================
const https = require('https');

// Endereço base da API do serviço.
const BUSCARCEP_URL = 'https://buscarcep.com.br/';

// Consulta um CEP.
//   - Devolve o objeto com os dados do endereço quando o CEP existe.
//   - Devolve null quando o serviço responde que o CEP não foi encontrado.
//   - Rejeita (reject) em caso de chave ausente, resposta inválida, timeout
//     ou falha de rede — quem chama decide como avisar o usuário.
function consultarCEP(cep) {
  return new Promise((resolve, reject) => {
    // Sem chave o serviço recusaria a consulta; melhor avisar logo do que
    // enviar a palavra "undefined" como se fosse a chave.
    if (!process.env.BUSCARCEP_CHAVE) {
      reject(new Error('BUSCARCEP_CHAVE não está configurada no .env.'));
      return;
    }

    // Monta a URL com os parâmetros da consulta. O URLSearchParams cuida de
    // codificar caracteres especiais corretamente.
    const url = new URL(BUSCARCEP_URL);
    url.searchParams.set('cep', cep);
    url.searchParams.set('formato', 'json');
    url.searchParams.set('chave', process.env.BUSCARCEP_CHAVE);

    const requisicao = https.get(url, { headers: { Accept: 'application/json' } }, (resposta) => {
      // A resposta chega em pedaços: vamos juntando até o fim.
      let dadosRecebidos = '';
      resposta.setEncoding('utf8');
      resposta.on('data', (parte) => {
        dadosRecebidos += parte;
      });

      resposta.on('end', () => {
        try {
          const dados = JSON.parse(dadosRecebidos);

          // Só para depuração: mostra a resposta bruta no terminal. Fica
          // desligado por padrão para não poluir o log (nem registrar
          // endereços de usuários); ligue com BUSCARCEP_DEBUG=1.
          if (process.env.BUSCARCEP_DEBUG === '1') {
            console.log('\n===== RESPOSTA BRUTA DO BUSCARCEP =====');
            console.log(dados);
            console.log('========================================\n');
          }

          // O serviço usa "resultado" = '1' quando achou o CEP.
          if (dados.resultado !== '1') {
            resolve(null);
            return;
          }
          resolve(dados);
        } catch {
          reject(new Error('Resposta inválida recebida do BuscarCEP.'));
        }
      });
    });

    // Se o serviço demorar mais de 10 s, cancela (evita requisição pendurada).
    requisicao.setTimeout(10000, () => {
      requisicao.destroy(new Error('Tempo limite excedido ao consultar o BuscarCEP.'));
    });

    // Erros de rede (sem internet, DNS, conexão recusada...).
    requisicao.on('error', reject);
  });
}

module.exports = {
  consultarCEP
};
