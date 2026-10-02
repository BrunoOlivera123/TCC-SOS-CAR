// =================================================================
// Mini-mapa de localização (card "Seu chamado" do cliente e
// "Atendimento em andamento" do prestador), usando Leaflet + tiles do
// OpenStreetMap — gratuito, sem chave de API (ver <link>/<script> do
// Leaflet carregados via CDN em index.html, antes deste arquivo).
//
// Guardamos uma instância de mapa por elemento (em vez de recriar a
// cada atualização do painel) porque o Leaflet não gosta de ser
// inicializado duas vezes sobre o mesmo <div> — é mais barato só mover
// o marcador existente quando a localização não muda.
// =================================================================
//
// API pública (objeto global "Mapa", usado pelo app.js):
//   criarOuAtualizar(id, lat, lng, titulo, categoria)           - marcador do local do chamado
//   criarOuAtualizarPrestador(id, lat, lng, titulo, categoria)  - marcador do prestador
//   removerPrestador(id)                                        - tira prestador e rota
//   criarOuAtualizarRota(id, origem, destino)                   - linha da rota entre os dois
//
// SEGURANÇA: os "titulo" dos marcadores entram no popup como HTML. Por isso
// quem chama (app.js) SEMPRE passa nomes de pessoas por escaparHtml() antes.
const Mapa = (function () {
  // Uma entrada por mapa da tela. Chave = id do <div> do mapa.
  // Cada instância guarda:
  //   mapa           - o objeto L.map do Leaflet
  //   marcadores     - { chamado, prestador } (marcadores atuais)
  //   rota           - a linha (polyline) da rota, ou null
  //   rotaChave      - texto com os pontos da última rota (evita refazê-la à toa)
  //   rotaSequencia  - contador para descartar respostas de rota atrasadas
  //   usuarioMoveu   - true se a pessoa arrastou/deu zoom (aí não mexemos mais na visão)
  const instancias = {};

  // Adiciona ao mapa o botão "Tela inteira" (uma única vez por mapa). Ele
  // alterna uma classe CSS que estica o mapa por cima da página e avisa o
  // Leaflet (invalidateSize) de que o tamanho do contêiner mudou — sem isso
  // o mapa ficaria com faixas cinzas/tiles faltando.
  function prepararBotaoTelaCheia(elementoId) {
    const elemento = document.getElementById(elementoId);
    if (!elemento || elemento.querySelector('.mapa-botao-fullscreen')) return;

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'mapa-botao-fullscreen';
    botao.textContent = 'Tela inteira';
    botao.addEventListener('click', () => {
      const instancia = instancias[elementoId];
      if (!instancia) return;
      const ativo = elemento.classList.toggle('mapa-fullscreen');
      document.body.classList.toggle('mapa-fullscreen', ativo);
      document.documentElement.classList.toggle('mapa-fullscreen', ativo);
      botao.textContent = ativo ? 'Sair da tela inteira' : 'Tela inteira';

      // Recalcula o tamanho no próximo quadro (depois do CSS aplicado)...
      requestAnimationFrame(() => {
        instancia.mapa.invalidateSize();
        window.dispatchEvent(new Event('resize'));
      });

      // ...e de novo após a transição de layout, mantendo centro e zoom.
      setTimeout(() => {
        instancia.mapa.invalidateSize();
        instancia.mapa.flyTo(instancia.mapa.getCenter(), instancia.mapa.getZoom(), { animate: false });
      }, 120);
    });
    elemento.appendChild(botao);
  }

  // Converte o nome da categoria ("Mecânico", "Auto Elétrica"...) numa chave
  // simples ('mecanico', 'auto-eletrica'...) para escolher o ícone certo.
  function normalizarCategoria(chave) {
    if (!chave) return 'padrao';
    // Remove os acentos antes de comparar: "Mecânico" em minúsculas é
    // "mecânico", que NÃO contém "mecan" — sem isto o ícone do mecânico
    // nunca aparecia (caía no marcador padrão).
    const texto = String(chave)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    if (texto.includes('mecan')) return 'mecanico';
    if (texto.includes('borrache')) return 'borracheiro';
    if (texto.includes('eletrica')) return 'auto-eletrica';
    if (texto.includes('guin')) return 'guincho';
    return 'padrao';
  }

  // Cria o ícone (emoji dentro de um círculo colorido) de uma categoria. Os
  // estilos de cada "icon-*" ficam em css/style.css.
  function getIconeCategoria(categoriaNome) {
    const categoria = normalizarCategoria(categoriaNome);
    const mapaIcones = {
      mecanico: { emoji: '🔧', classe: 'icon-mecanico' },
      borracheiro: { emoji: '🛞', classe: 'icon-borracheiro' },
      'auto-eletrica': { emoji: '⚡', classe: 'icon-auto-eletrica' },
      guincho: { emoji: '🚚', classe: 'icon-guincho' },
      padrao: { emoji: '📍', classe: 'icon-cliente' }
    };

    const icone = mapaIcones[categoria] || mapaIcones.padrao;
    return L.divIcon({
      className: '',
      html: `<div class="mapa-icone ${icone.classe}" aria-label="${icone.emoji}">${icone.emoji}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -18]
    });
  }

  // Distância em linha reta entre dois pontos [lat, lng], em km (fórmula de
  // Haversine, igual à de server/utils/distancia.js). Só é usada como plano B,
  // quando o serviço de rotas (OSRM) não responde.
  function calcularDistanciaKm(origem, destino) {
    const toRad = (valor) => (valor * Math.PI) / 180;
    const lat1 = toRad(origem[0]);
    const lat2 = toRad(destino[0]);
    const dLat = toRad(destino[0] - origem[0]);
    const dLng = toRad(destino[1] - origem[1]);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371 * c;
  }

  // Formata minutos para leitura humana: 45 -> "45 min", 135 -> "2h 15min".
  function formatarTempoEstimado(minutos) {
    const totalMinutos = Math.max(1, Math.round(minutos));
    if (totalMinutos < 60) return `${totalMinutos} min`;
    const horas = Math.floor(totalMinutos / 60);
    const minutosRestantes = totalMinutos % 60;
    return minutosRestantes ? `${horas}h ${minutosRestantes}min` : `${horas}h`;
  }

  // Reenquadra o mapa para mostrar todos os marcadores, MAS só se algum
  // deles saiu da área visível e a pessoa ainda não mexeu no mapa. Respeitar
  // o que a pessoa fez evita o mapa "brigar" com ela a cada atualização.
  function atualizarViewportSeNecessario(elementoId) {
    const instancia = instancias[elementoId];
    if (!instancia || instancia.usuarioMoveu) return;

    const pontos = Object.values(instancia.marcadores)
      .filter(Boolean)
      .map((marcador) => marcador.getLatLng());

    if (pontos.length < 2) return;

    const bounds = L.latLngBounds(pontos);
    const visivel = instancia.mapa.getBounds();
    const saiuCampoVisao = pontos.some((ponto) => !visivel.contains(ponto));

    if (saiuCampoVisao) {
      instancia.mapa.fitBounds(bounds, {
        padding: [60, 60],
        maxZoom: 16,
        animate: true
      });
    }
  }

  // Tira a rota do mapa e invalida qualquer consulta de rota ainda em
  // andamento (a resposta atrasada não deve reaparecer depois).
  function removerRota(elementoId) {
    const instancia = instancias[elementoId];
    if (!instancia) return;
    instancia.rotaSequencia += 1;
    instancia.rotaChave = null;
    if (!instancia.rota) return;
    instancia.mapa.removeLayer(instancia.rota);
    instancia.rota = null;
  }

  // Desenha a rota de carro entre origem e destino ([lat, lng] cada).
  // Usa o OSRM (serviço público e gratuito de rotas). Se ele falhar, desenha
  // uma linha reta com a distância calculada aqui mesmo.
  function mostrarRota(elementoId, origem, destino) {
    const instancia = instancias[elementoId];
    if (!instancia || !origem || !destino) return;

    // Os painéis chamam esta função a cada atualização (3–6 s). A rota só é
    // refeita quando algum dos pontos se moveu mais de ~10 m (4 casas
    // decimais). Antes, cada tique consultava o servidor público de rotas
    // (OSRM, que limita o uso) e recriava a linha, fazendo o balão piscar.
    const chave = [...origem, ...destino].map((v) => v.toFixed(4)).join(',');
    if (instancia.rotaChave === chave) return;
    instancia.rotaChave = chave;
    // Se uma consulta antiga responder depois de uma mais nova, ela é
    // descartada — senão sobrava uma linha "fantasma" que nunca saía do mapa.
    const sequencia = (instancia.rotaSequencia += 1);

    // O OSRM espera [longitude, latitude] (o inverso do Leaflet, que usa [lat, lng]).
    const origemLngLat = [origem[1], origem[0]];
    const destinoLngLat = [destino[1], destino[0]];
    const distanciaKm = calcularDistanciaKm(origem, destino);
    // Tempo de reserva se a API não informar: velocidade média de 32 km/h na cidade.
    const tempoEstimado = Math.max(1, (distanciaKm / 32) * 60);

    // Desenha (ou troca) a linha da rota com o balão de distância/tempo.
    const montarLinha = (pontos, popupHtml) => {
      if (instancia.rotaSequencia !== sequencia) return;
      // A linha nova só entra quando está pronta (a antiga fica até lá), e o
      // balão abre na primeira rota ou se o usuário o mantinha aberto.
      const anterior = instancia.rota;
      const abrirBalao = !anterior || anterior.isPopupOpen();
      if (anterior) instancia.mapa.removeLayer(anterior);

      const linha = L.polyline(pontos, {
        color: '#4f46e5',
        weight: 5,
        opacity: 0.8,
        dashArray: '8 10'
      }).addTo(instancia.mapa);
      linha.bindPopup(popupHtml, { autoClose: false, closeButton: true });
      if (abrirBalao) linha.openPopup();
      instancia.rota = linha;
    };

    fetch(
      `https://router.project-osrm.org/route/v1/driving/${origemLngLat.join(',')};${destinoLngLat.join(',')}?overview=full&geometries=geojson`
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Rota indisponível'))))
      .then((dados) => {
        const coords = dados?.routes?.[0]?.geometry?.coordinates;
        const distanciaApi = dados?.routes?.[0]?.distance;
        const duracaoApi = dados?.routes?.[0]?.duration;
        const popupHtml =
          typeof distanciaApi === 'number'
            ? `Distância: ${(distanciaApi / 1000).toFixed(1)} km<br>Tempo estimado: ${formatarTempoEstimado(typeof duracaoApi === 'number' ? duracaoApi / 60 : tempoEstimado)}`
            : `Distância: ${distanciaKm.toFixed(1)} km<br>Tempo estimado: ${formatarTempoEstimado(tempoEstimado)}`;

        if (!coords || !coords.length) {
          montarLinha([origem, destino], popupHtml);
          return;
        }

        const pontos = coords.map(([lng, lat]) => [lat, lng]);
        montarLinha(pontos, popupHtml);
      })
      .catch(() => {
        const popupFallback = `Distância: ${distanciaKm.toFixed(1)} km<br>Tempo estimado: ${formatarTempoEstimado(tempoEstimado)}`;
        montarLinha([origem, destino], popupFallback);
      });
  }

  // Devolve o mapa do elemento, criando-o na primeira vez (centrado nas
  // coordenadas dadas). Devolve null se o <div> não existe, o Leaflet não
  // carregou (CDN fora do ar) ou as coordenadas não são números.
  function obterInstancia(elementoId, latitude, longitude) {
    const elemento = document.getElementById(elementoId);
    if (!elemento || typeof L === 'undefined' || typeof latitude !== 'number' || typeof longitude !== 'number') {
      return null;
    }

    if (instancias[elementoId]) return instancias[elementoId];

    const mapa = L.map(elemento, { zoomControl: false }).setView([latitude, longitude], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(mapa);

    instancias[elementoId] = {
      mapa,
      marcadores: {},
      rota: null,
      rotaChave: null, // pontos da última rota pedida (evita refazê-la sem necessidade)
      rotaSequencia: 0, // numera as consultas de rota para descartar respostas atrasadas
      usuarioMoveu: false
    };
    // Se a pessoa arrastar ou der zoom, paramos de reenquadrar sozinhos.
    mapa.on('dragstart', () => {
      instancias[elementoId].usuarioMoveu = true;
    });
    mapa.on('zoomstart', () => {
      instancias[elementoId].usuarioMoveu = true;
    });
    prepararBotaoTelaCheia(elementoId);
    // O <div> pode estar escondido quando o mapa nasce; recalcula o tamanho
    // assim que o navegador terminar de montar a tela.
    setTimeout(() => mapa.invalidateSize(), 0);
    return instancias[elementoId];
  }

  // Cria o marcador "chave" ('chamado' ou 'prestador') ou, se já existe, só
  // o move — mais barato do que recriar a cada atualização do painel.
  function atualizarMarcador(elementoId, chave, latitude, longitude, titulo, categoriaNome = null) {
    const instancia = obterInstancia(elementoId, latitude, longitude);
    if (!instancia) return;

    const coordenadas = [latitude, longitude];
    const marcador = instancia.marcadores[chave];
    if (marcador) {
      marcador.setLatLng(coordenadas);
      marcador.setIcon(getIconeCategoria(categoriaNome));
      if (titulo) marcador.bindPopup(titulo);
      return;
    }

    const novoMarcador = L.marker(coordenadas, {
      icon: getIconeCategoria(categoriaNome)
    }).addTo(instancia.mapa);
    if (titulo) novoMarcador.bindPopup(titulo);
    instancia.marcadores[chave] = novoMarcador;
  }

  // Marcador do local do chamado (ou da posição do cliente).
  function criarOuAtualizar(elementoId, latitude, longitude, titulo, categoriaNome = null) {
    const instancia = obterInstancia(elementoId, latitude, longitude);
    if (!instancia) return;
    atualizarMarcador(elementoId, 'chamado', latitude, longitude, titulo, categoriaNome || 'padrao');
    atualizarViewportSeNecessario(elementoId);
    setTimeout(() => instancia.mapa.invalidateSize(), 0);
  }

  // Marcador do prestador (o ícone depende da categoria dele).
  function criarOuAtualizarPrestador(elementoId, latitude, longitude, titulo, categoriaNome = null) {
    const instancia = obterInstancia(elementoId, latitude, longitude);
    if (!instancia) return;
    atualizarMarcador(elementoId, 'prestador', latitude, longitude, titulo, categoriaNome || 'mecanico');
    atualizarViewportSeNecessario(elementoId);
  }

  // Remove o marcador do prestador (e a rota, que não faz sentido sem ele).
  function removerPrestador(elementoId) {
    const instancia = instancias[elementoId];
    const marcador = instancia?.marcadores.prestador;
    if (!marcador) return;
    instancia.mapa.removeLayer(marcador);
    delete instancia.marcadores.prestador;
    // Sem prestador não há rota: antes a linha ficava no mapa depois de o
    // prestador cancelar ou de o chamado terminar.
    removerRota(elementoId);
    atualizarViewportSeNecessario(elementoId);
  }

  // Atualiza a rota entre dois pontos e reenquadra o mapa se preciso.
  function criarOuAtualizarRota(elementoId, origem, destino) {
    const instancia = instancias[elementoId];
    if (!instancia || !origem || !destino) return;
    mostrarRota(elementoId, origem, destino);
    atualizarViewportSeNecessario(elementoId);
  }

  return { criarOuAtualizar, criarOuAtualizarPrestador, removerPrestador, criarOuAtualizarRota };
})();
