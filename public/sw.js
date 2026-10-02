// =================================================================
// Service worker mínimo: só o necessário para o navegador considerar o
// SOS Car "instalável" (PWA) e funcionar de forma razoável offline para
// quem já visitou antes. Estratégia "network-first": tenta a rede
// primeiro (dados sempre atualizados) e só cai no cache se estiver
// offline — nunca serve uma versão desatualizada por engano enquanto
// há conexão.
//
// Instalação como app exige HTTPS (ou "localhost") — em http:// puro
// (ex.: acessando pelo IP da rede local) o navegador registra o service
// worker, mas não oferece a opção de instalar.
// =================================================================
// A versão sobe quando a estratégia de cache muda: o "activate" abaixo apaga
// os caches de versões antigas (a v1 acumulou tiles de mapa sem limite).
const CACHE = 'sos-car-v5';
const ARQUIVOS_ESSENCIAIS = [
  '/',
  '/css/style.css',
  '/js/theme.js',
  '/js/api.js',
  '/js/masks.js',
  '/js/mapa.js',
  '/js/animacoes.js',
  '/js/cartao-info.js',
  '/js/app.js',
  '/img/logo.svg',
  '/manifest.json'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_ESSENCIAIS)));
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((chaves) => Promise.all(chaves.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  const { request } = evento;
  const url = new URL(request.url);

  // Só os arquivos do próprio app (GET, mesma origem) passam pelo cache.
  // Ficam de fora:
  //  - a API e o /health: precisam ser sempre dados atuais (ou falhar de
  //    verdade, para o app tratar);
  //  - o que vem de outros domínios (tiles do OpenStreetMap, Leaflet, fontes,
  //    servidor de rotas): guardá-los enchia o cache do celular sem limite a
  //    cada trecho de mapa visto.
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  evento.respondWith(
    fetch(request)
      .then((resposta) => {
        // Erros (404/500) não vão para o cache, senão seriam servidos de
        // volta como se fossem a página de verdade quando estiver offline.
        if (resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copia));
        }
        return resposta;
      })
      .catch(() => caches.match(request))
  );
});
