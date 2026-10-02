// =================================================================
// Cálculo de distância entre duas coordenadas GPS (fórmula de Haversine).
//
// É o "cálculo simples de distância" citado no escopo do TCC: em vez de
// usar um serviço de roteirização (que calcularia a distância real por
// ruas, fora do escopo do MVP), calculamos a distância em linha reta
// entre o prestador e o chamado, em quilômetros, e usamos isso para
// filtrar/ordenar os chamados "próximos" de cada prestador.
// =================================================================
// Coordenada só é aceita se for um número finito dentro dos limites do globo.
// Texto, NaN, Infinity, null e valores fora de faixa (ex.: latitude 200) são
// tratados como "sem localização" — nunca viram uma distância inventada.
function latitudeValida(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}
function longitudeValida(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

function distanciaKm(lat1, lon1, lat2, lon2) {
  // Se alguma coordenada não existir ou for inválida (ex.: prestador ainda não
  // permitiu geolocalização), não dá para calcular distância — devolve null e
  // quem chamou essa função decide o que fazer (ver server.js: chamado sem
  // distância calculável NÃO é tratado como "dentro do raio").
  if (!latitudeValida(lat1) || !longitudeValida(lon1) || !latitudeValida(lat2) || !longitudeValida(lon2)) {
    return null;
  }

  const R = 6371; // raio médio da Terra, em quilômetros
  const paraRad = (graus) => (graus * Math.PI) / 180; // graus -> radianos

  const dLat = paraRad(lat2 - lat1);
  const dLon = paraRad(lon2 - lon1);

  // Fórmula de Haversine: calcula a distância "em linha reta" entre dois
  // pontos na superfície de uma esfera, a partir da latitude/longitude.
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(paraRad(lat1)) * Math.cos(paraRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // distância final, em km
}

module.exports = { distanciaKm, latitudeValida, longitudeValida };
