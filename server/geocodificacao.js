// =================================================================
// Geocodificação: converte endereço <-> coordenadas (latitude/longitude)
// usando o Nominatim, o serviço gratuito do OpenStreetMap.
//
//   - geocodificar("Rua X, 100, Tupã")  -> { latitude, longitude, enderecoFormatado }
//   - reverseGeocodificar(lat, lon)     -> { latitude, longitude, enderecoFormatado }
//
// Regras da política de uso do Nominatim que este arquivo respeita:
//   1. No MÁXIMO 1 consulta por segundo (ver aguardarLimite).
//   2. Identificar a aplicação com um User-Agent real (OSM_USER_AGENT no .env).
//   3. Guardar resultados em cache para não repetir a mesma consulta.
// =================================================================
const https = require('https');

const URL_NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Cache em memória: chave = texto da consulta, valor = resultado. Evita
// repetir consultas idênticas (e respeita a política de uso do serviço).
// Some quando o servidor reinicia — é só um acelerador, não um dado importante.
const cache = new Map();

// Instante (em ms) a partir do qual a próxima consulta pode sair.
let proximaConsulta = 0;

// Fila simples de espera: garante pelo menos 1,1 s entre consultas, MESMO que
// várias requisições cheguem ao mesmo tempo. Cada chamada "reserva" o próximo
// horário livre e espera até lá.
function aguardarLimite() {
  const espera = Math.max(0, proximaConsulta - Date.now());
  proximaConsulta = Date.now() + espera + 1100;
  return new Promise((resolve) => setTimeout(resolve, espera));
}

// Faz a chamada HTTP de busca (endereço -> coordenadas) e devolve a lista de
// resultados já convertida de JSON. Rejeita em erro HTTP, JSON inválido,
// timeout (10 s) ou falha de rede.
function consultarNominatim(endereco) {
  return new Promise((resolve, reject) => {
    const url = new URL(URL_NOMINATIM);
    url.searchParams.set('q', endereco); // texto livre digitado pelo usuário
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1'); // só o melhor resultado interessa
    url.searchParams.set('countrycodes', 'br'); // limita a busca ao Brasil

    const requisicao = https.get(
      url,
      {
        headers: {
          // O Nominatim exige identificação; um contato real evita bloqueio.
          'User-Agent': process.env.OSM_USER_AGENT || 'SOS-Car-TCC/1.0 (contato: admin@soscar.com)',
          Accept: 'application/json'
        }
      },
      (resposta) => {
        // A resposta chega em pedaços: juntamos tudo antes de interpretar.
        let corpo = '';
        resposta.setEncoding('utf8');
        resposta.on('data', (parte) => {
          corpo += parte;
        });
        resposta.on('end', () => {
          if (resposta.statusCode !== 200) {
            reject(new Error(`Nominatim respondeu com HTTP ${resposta.statusCode}.`));
            return;
          }
          try {
            resolve(JSON.parse(corpo));
          } catch {
            reject(new Error('A resposta do serviço de geocodificação não é válida.'));
          }
        });
      }
    );
    requisicao.setTimeout(10000, () => requisicao.destroy(new Error('Tempo limite ao consultar Nominatim.')));
    requisicao.on('error', reject);
  });
}

// Endereço (texto) -> coordenadas. Devolve null se o endereço não for
// encontrado; lança erro se o serviço falhar (a rota responde 502).
async function geocodificar(endereco) {
  // A chave do cache ignora maiúsculas/minúsculas e espaços nas pontas, para
  // "Rua A" e "rua a " contarem como a mesma consulta.
  const chave = endereco.trim().toLocaleLowerCase('pt-BR');
  if (!chave) throw new Error('Informe um endereço para localizar.');
  if (cache.has(chave)) return cache.get(chave);

  await aguardarLimite(); // respeita 1 consulta por segundo
  const resultados = await consultarNominatim(endereco.trim());
  const primeiro = resultados[0];
  if (!primeiro) return null; // nenhum resultado

  const localizacao = {
    latitude: Number(primeiro.lat), // o Nominatim devolve texto; convertemos para número
    longitude: Number(primeiro.lon),
    enderecoFormatado: primeiro.display_name
  };
  cache.set(chave, localizacao);
  return localizacao;
}

// Coordenadas -> endereço (o caminho inverso). Usado no botão "usar minha
// localização" do cliente. Devolve null se não houver endereço para o ponto.
async function reverseGeocodificar(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Coordenadas inválidas para obter o endereço.');
  }

  // 6 casas decimais ≈ 11 cm: coordenadas praticamente iguais compartilham cache.
  const chave = `rev:${lat.toFixed(6)}:${lon.toFixed(6)}`;
  if (cache.has(chave)) return cache.get(chave);

  await aguardarLimite();
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '18'); // nível de detalhe: rua/número
  url.searchParams.set('addressdetails', '1');

  // Mesma ideia de consultarNominatim, embrulhada numa Promise para podermos
  // usar "await" (o https.get original trabalha com callbacks).
  const resposta = await new Promise((resolve, reject) => {
    const requisicao = https.get(
      url,
      {
        headers: {
          'User-Agent': process.env.OSM_USER_AGENT || 'SOS-Car-TCC/1.0 (contato: admin@soscar.com)',
          Accept: 'application/json'
        }
      },
      (res) => {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (parte) => {
          corpo += parte;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Nominatim respondeu com HTTP ${res.statusCode}.`));
            return;
          }
          try {
            resolve(JSON.parse(corpo));
          } catch {
            reject(new Error('A resposta do serviço de reverse geocoding não é válida.'));
          }
        });
      }
    );
    requisicao.setTimeout(10000, () => requisicao.destroy(new Error('Tempo limite ao consultar endereço.')));
    requisicao.on('error', reject);
  });

  // Ponto sem endereço conhecido (ex.: no meio do mar ou de uma mata).
  if (!resposta || !resposta.display_name) return null;

  const endereco = {
    latitude: lat,
    longitude: lon,
    enderecoFormatado: resposta.display_name
  };
  cache.set(chave, endereco);
  return endereco;
}

module.exports = { geocodificar, reverseGeocodificar };
