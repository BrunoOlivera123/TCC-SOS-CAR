// =================================================================
// Lógica das telas do SOS Car.
//
// É uma SPA (Single Page Application) bem simples: existe um único
// index.html com as três telas já escritas nele (auth, cliente,
// prestador), e este arquivo apenas mostra/esconde cada uma via CSS
// (classe "oculta") e preenche o conteúdo delas com dados vindos da
// API (api.js). Não há nenhum framework nem "roteador" de página —
// tudo é feito manipulando o DOM diretamente.
// =================================================================
(function () {
  // setInterval usado para atualizar a tela periodicamente (novos
  // chamados disponíveis, mudança de status etc.), sem precisar de
  // WebSockets — o navegador simplesmente pergunta de novo à API a
  // cada alguns segundos ("polling"). Guardamos aqui o id do interval
  // atual para poder cancelá-lo ao trocar de tela ou deslogar.
  let intervaloAtualizacao = null;

  // Guarda o chamado que está sendo mostrado no momento (do cliente ou
  // do prestador, dependendo de quem está logado), para os botões de
  // ação (cancelar, aceitar, concluir...) saberem qual id usar.
  let chamadoEmFoco = null;

  const telas = {
    carregamento: document.getElementById('tela-carregamento'),
    auth: document.getElementById('tela-auth'),
    esqueciSenha: document.getElementById('tela-esqueci-senha'),
    redefinirSenha: document.getElementById('tela-redefinir-senha'),
    cliente: document.getElementById('tela-cliente'),
    prestador: document.getElementById('tela-prestador'),
    config: document.getElementById('tela-config'),
    admin: document.getElementById('tela-admin'),
    sobre: document.getElementById('tela-sobre'),
    ajuda: document.getElementById('tela-ajuda'),
    termos: document.getElementById('tela-termos'),
    privacidade: document.getElementById('tela-privacidade')
  };

  document.querySelectorAll('[data-toggle-senha]').forEach((botao) => {
    const container = botao.closest('.campo-senha');
    const input = container ? container.querySelector('input') : null;
    if (!input) return;

    const alternar = () => {
      const oculto = input.type === 'password';
      input.type = oculto ? 'text' : 'password';
      botao.setAttribute('data-visivel', String(oculto));
      botao.setAttribute('aria-label', oculto ? 'Ocultar senha' : 'Mostrar senha');
      botao.title = oculto ? 'Ocultar senha' : 'Mostrar senha';
      botao.style.color = oculto ? 'var(--primary)' : 'var(--text-secondary)';
      input.focus();
    };

    botao.setAttribute('data-visivel', 'false');

    botao.addEventListener('click', alternar);
  });

  // Dá um "pulinho" visual no botão ao ser clicado (reinicia a animação CSS a cada clique).
  function animarCliqueBotao(botao) {
    if (!(botao instanceof HTMLElement)) return;
    botao.classList.remove('botao-clique');
    void botao.offsetWidth;
    botao.classList.add('botao-clique');
    clearTimeout(botao._tempoAnimacaoClique);
    botao._tempoAnimacaoClique = setTimeout(() => botao.classList.remove('botao-clique'), 180);
  }

  document.querySelectorAll('.botao-primario, .botao-secundario, .botao-perigo').forEach((botao) => {
    botao.addEventListener('click', () => animarCliqueBotao(botao));
  });

  const btnSair = document.getElementById('btn-sair');
  const btnConfig = document.getElementById('btn-config');
  const linkAdmin = document.getElementById('link-admin');
  const formConfig = document.getElementById('form-configuracoes');
  const btnConfigCancel = document.getElementById('btn-config-cancel');
  const campoCategoriaConfig = document.getElementById('campo-categoria-config');
  const campoRaioConfig = document.getElementById('campo-raio-config');
  // Troca de senha: pede a senha atual e só aparece se a conta TEM senha
  // (contas criadas pelo Google não têm — ver "temSenha" em paraPublico, no servidor).
  const campoSenhaAtualConfig = document.getElementById('campo-senha-atual-config');
  const campoSenhaNovaConfig = document.getElementById('campo-senha-nova-config');
  const avisoSemSenhaConfig = document.getElementById('aviso-sem-senha-config');
  let categoriaConfigAtual = null;
  let usuarioTipoAtual = null;
  let ultimoUsuario = null;

  // Mostra só a tela pedida, escondendo as demais (classe "oculta" vem
  // do CSS com "display: none !important"). Sair/Configurações/link de
  // admin dependem de quem está logado (usuarioTipoAtual), não do nome
  // da tela — assim continuam corretos mesmo em telas "de passagem"
  // como Sobre/Ajuda, que podem ser abertas tanto logado quanto não.
  function mostrarTela(nome) {
    Object.entries(telas).forEach(([chave, el]) => el.classList.toggle('oculta', chave !== nome));
    const logado = !!usuarioTipoAtual;
    btnSair.classList.toggle('oculto', !logado);
    if (btnConfig) btnConfig.classList.toggle('oculto', usuarioTipoAtual !== 'cliente' && usuarioTipoAtual !== 'prestador');
    if (notificacoesEl) notificacoesEl.classList.toggle('oculto', usuarioTipoAtual !== 'cliente' && usuarioTipoAtual !== 'prestador');
    if (linkAdmin) linkAdmin.classList.toggle('oculto', logado);
  }

  // Volta para o painel de quem estiver logado (cliente/prestador/admin)
  // ou para a tela de login, se ninguém estiver — usado pelo clique no
  // logo e por todos os botões "Voltar" das telas institucionais/admin.
  function voltarTelaPrincipal() {
    if (usuarioTipoAtual === 'cliente') irParaTela('cliente');
    else if (usuarioTipoAtual === 'prestador') irParaTela('prestador');
    else if (usuarioTipoAtual === 'admin') irParaTela('admin');
    else irParaTela('auth');
  }

  // Versão animada de mostrarTela: a tela atual some suavemente (150ms) e
  // então a nova entra (a entrada é o CSS de .tela / .tela-aux). Usada nas
  // trocas iniciadas pelo usuário; fluxos que precisam da tela visível na
  // hora (ex.: iniciar painéis com mapa) continuam chamando mostrarTela.
  let trocaDeTelaId = 0;
  // Troca de tela com animação: a tela atual some suavemente e só então a nova
  // aparece. O contador evita que cliques rápidos mostrem telas fora de ordem.
  async function irParaTela(nome) {
    const id = ++trocaDeTelaId;
    const atual = Object.values(telas).find((el) => !el.classList.contains('oculta'));
    if (atual && atual !== telas[nome]) await Anim.sair(atual);
    if (id === trocaDeTelaId) mostrarTela(nome);
  }

  // Para tudo o que roda em segundo plano: o polling periódico e o acompanhamento
  // de GPS. Chamada no logout e quando a sessão expira.
  function pararAtualizacaoAutomatica() {
    if (intervaloAtualizacao) clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = null;
    if (watchIdCliente !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdCliente);
      watchIdCliente = null;
    }
    if (watchIdPrestador !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdPrestador);
      watchIdPrestador = null;
    }
  }

  // Roda "atualizar" agora e depois a cada "intervaloMs" (o polling que
  // mantém os painéis em dia). Diferente de um setInterval solto:
  //  - não empilha requisições: se a anterior ainda não terminou (rede
  //    lenta), o tique é pulado;
  //  - erros não viram "unhandled rejection": avisa com um toast na
  //    primeira falha e fica quieto até a conexão voltar, em vez de
  //    repetir o aviso a cada 3 segundos.
  function iniciarAtualizacaoAutomatica(atualizar, intervaloMs) {
    let emAndamento = false;
    let avisouFalha = false;
    const tique = async () => {
      if (emAndamento) return;
      emAndamento = true;
      try {
        await atualizar();
        // A Central de Notificações viaja no MESMO ciclo (nenhum timer/conexão a mais).
        if (usuarioTipoAtual === 'cliente' || usuarioTipoAtual === 'prestador') {
          await atualizarNotificacoes().catch(() => {});
        }
        avisouFalha = false;
      } catch (err) {
        // Sessão expirada: o evento "sessao-expirada" já cuidou de tudo.
        if (usuarioTipoAtual && !avisouFalha) {
          avisouFalha = true;
          toast(err.message);
        }
      } finally {
        emAndamento = false;
      }
    };
    tique();
    intervaloAtualizacao = setInterval(tique, intervaloMs);
  }

  // Traduz o status técnico (igual ao salvo no banco) para um texto
  // amigável de mostrar na tela.
  function rotuloStatus(status) {
    return (
      {
        aberto: 'Aberto',
        aceito: 'Aceito · a caminho',
        // O prestador chega ao local e toca em "Cheguei ao local" — é esse
        // clique que leva o chamado a "em_andamento".
        em_andamento: 'Prestador chegou ao local',
        concluido: 'Concluído',
        cancelado: 'Cancelado'
      }[status] || status
    );
  }

  // Data ISO -> texto no formato brasileiro curto (ex.: 18/09/26 15:01).
  function formatarData(iso) {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  // Distância em linha reta entre dois pontos {latitude, longitude}, em km
  // (fórmula de Haversine; mesma lógica de server/utils/distancia.js).
  function calcularDistanciaKm(origem, destino) {
    const toRad = (valor) => (valor * Math.PI) / 180;
    const lat1 = toRad(origem.latitude);
    const lat2 = toRad(destino.latitude);
    const dLat = toRad(destino.latitude - origem.latitude);
    const dLng = toRad(destino.longitude - origem.longitude);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  // Formata minutos para leitura humana: 45 -> "45 min", 135 -> "2h 15min".
  function formatarTempoEstimado(minutos) {
    const totalMinutos = Math.max(1, Math.round(minutos));
    if (totalMinutos < 60) return `${totalMinutos} min`;
    const horas = Math.floor(totalMinutos / 60);
    const minsRestantes = totalMinutos % 60;
    return minsRestantes ? `${horas}h ${minsRestantes}min` : `${horas}h`;
  }

  // Estimativa simples de tempo de chegada a partir da distância, supondo 32 km/h
  // de média na cidade (mínimo de 3 min). É só uma estimativa, não uma rota real.
  function tempoMedioChegada(distanciaKm) {
    if (typeof distanciaKm !== 'number' || !Number.isFinite(distanciaKm)) return 'Tempo não disponível';
    const minutos = Math.max(3, (distanciaKm / 32) * 60);
    return formatarTempoEstimado(minutos);
  }

  // Reduz um endereço longo (do Nominatim) a poucas partes, para caber nos cards.
  function resumirEndereco(endereco) {
    const texto = String(endereco ?? '').trim();
    if (!texto) return 'Endereço não informado';

    const partes = texto
      .split(',')
      .map((parte) => parte.trim())
      .filter(Boolean);

    if (!partes.length) return 'Endereço não informado';

    const rua = partes.find((parte) => /(rua|avenida|alameda|travessa|praça|rodovia|logradouro|bairro)/i.test(parte)) || partes[0];
    const cidade = partes.find((parte) => !/(rua|avenida|alameda|travessa|praça|rodovia|logradouro|bairro|pais|brasil|estado|cep|numero|n\.?\s*\d+)/i.test(parte)) || partes[partes.length - 1];

    if (!cidade || cidade === rua) return rua;
    return `${rua}, ${cidade}`;
  }

  // Descrição do chamado, ou "Sem descrição" quando o cliente não escreveu nada.
  function textoDescricao(chamado) {
    const descricao = String(chamado?.descricao ?? '').trim();
    return descricao || 'Sem descrição';
  }

  // Escapa caracteres especiais de HTML antes de inserir texto vindo da
  // API (nome, endereço, descrição etc.) dentro de innerHTML. Sem isso,
  // alguém poderia cadastrar um nome como "<img src=x onerror=...>" e
  // esse código rodaria no navegador de qualquer outro usuário que visse
  // esse nome na tela (XSS armazenado).
  function escaparHtml(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  // ---------------- Acompanhamento do atendimento (textos e linha do tempo) ----------------
  // Como cada status do banco aparece para o cliente. "aceito" já significa que
  // o prestador está a caminho, e "em_andamento" que ele chegou e atende.
  const ESTADOS_ATENDIMENTO = {
    aberto: { titulo: '🔎 Chamado solicitado', sub: 'Aguardando um prestador aceitar.' },
    aceito: { titulo: '🚗 Prestador a caminho', sub: 'O prestador aceitou seu chamado.' },
    em_andamento: { titulo: '📍 Prestador chegou ao local', sub: '🔧 Atendimento em andamento' },
    concluido: { titulo: '✅ Atendimento concluído', sub: '' },
    cancelado: { titulo: '⚠️ Atendimento cancelado', sub: '' }
  };

  // Hora do evento; quando cai em outro dia que o de referência, inclui a data.
  function formatarHoraEvento(iso, referencia) {
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return '';
    const mesmoDia = referencia && new Date(referencia).toDateString() === data.toDateString();
    return mesmoDia
      ? data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // Desenha "18:32 — Prestador aceitou o chamado" para cada evento do chamado.
  // Só redesenha quando a lista muda (o painel do cliente é atualizado a cada
  // 3 s) e anima apenas os eventos que acabaram de chegar.
  function renderizarLinhaTempo(elemento, chamado) {
    const eventos = chamado.eventos || [];
    const assinatura = `${chamado.id}|${eventos.map((e) => e.id).join(',')}`;
    if (elemento.dataset.assinatura === assinatura) return;
    const mesmoChamado = elemento.dataset.assinatura && elemento.dataset.assinatura.startsWith(`${chamado.id}|`);
    const jaExibidos = mesmoChamado ? Number(elemento.dataset.quantidade || 0) : eventos.length;
    elemento.dataset.assinatura = assinatura;
    elemento.dataset.quantidade = String(eventos.length);
    elemento.innerHTML = eventos
      .map(
        (e, i) => `
      <li class="evento-${escaparHtml(e.tipo)}${i >= jaExibidos ? ' evento-novo' : ''}">
        <time datetime="${escaparHtml(e.data)}">${escaparHtml(formatarHoraEvento(e.data, chamado.dataAbertura))}</time> — ${escaparHtml(e.descricao)}${
          e.detalhe ? `<span class="evento-detalhe">Motivo: ${escaparHtml(e.detalhe)}</span>` : ''
        }
      </li>`
      )
      .join('');
  }

  // Complemento da linha do histórico quando o chamado foi cancelado:
  // " · Cancelado pelo prestador — Cliente não estava no local".
  function textoCancelamento(chamado) {
    if (chamado.status !== 'cancelado' || !chamado.canceladoPor) return '';
    const quem = { prestador: 'pelo prestador', cliente: 'pelo cliente', admin: 'pela administração' }[chamado.canceladoPor];
    if (!quem) return '';
    return ` · Cancelado ${quem}${chamado.motivoCancelamentoTexto ? ` — ${chamado.motivoCancelamentoTexto}` : ''}`;
  }

  // Mensagem para uma ação que falhou. Erros "esperados" (4xx: estado inválido,
  // motivo faltando...) já trazem uma frase clara do servidor; falha de conexão
  // também. Qualquer outra coisa (5xx, erro inesperado) vira o aviso padrão.
  function mensagemErroAcao(erro) {
    if (erro && (erro.status === 0 || (erro.status >= 400 && erro.status < 500))) return erro.message;
    return 'Não foi possível atualizar o atendimento. Tente novamente.';
  }

  // ---------------- Notificações (toast) e confirmação ----------------
  // Substituem alert()/confirm() nativos do navegador por componentes
  // próprios (ver #toast-container e #modal-confirmar no index.html e
  // os estilos em style.css), para manter a aparência consistente com
  // o resto do produto.
  const toastContainer = document.getElementById('toast-container');
  const modalConfirmar = document.getElementById('modal-confirmar');
  const modalConfirmarTexto = document.getElementById('modal-confirmar-texto');
  const modalConfirmarOk = document.getElementById('modal-confirmar-ok');
  const modalConfirmarCancelar = document.getElementById('modal-confirmar-cancelar');
  const modalConfirmarChamado = document.getElementById('modal-confirmar-chamado');
  const modalChamadoDetalhes = document.getElementById('modal-chamado-detalhes');
  const modalChamadoAceitar = document.getElementById('modal-chamado-aceitar');
  const modalChamadoCancelar = document.getElementById('modal-chamado-cancelar');

  // Mostra um aviso rápido (toast) no canto da tela por 5 s, no máximo 3 ao mesmo
  // tempo. tipo = 'erro' | 'sucesso'.
  function toast(mensagem, tipo = 'erro') {
    const notificacoes = toastContainer.querySelectorAll('.toast');
    if (notificacoes.length >= 3) notificacoes[0].remove();
    const el = document.createElement('div');
    el.className = `toast toast-${tipo}`;
    el.textContent = mensagem; // textContent nunca interpreta HTML, sem risco de XSS
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // Mostra o modal de confirmação e devolve uma Promise que resolve
  // "true" (confirmou) ou "false" (cancelou), no lugar do confirm()
  // nativo do navegador.
  function confirmar(mensagem) {
    modalConfirmarTexto.textContent = mensagem;
    modalConfirmar.classList.remove('oculto');
    return new Promise((resolve) => {
      // Fecha o modal de confirmação e entrega a resposta; remove os listeners para não
      // acumular cliques de uma confirmação para outra.
      function limpar(resultado) {
        Anim.sair(modalConfirmar, 'saindo', 160).then(() => modalConfirmar.classList.add('oculto'));
        modalConfirmarOk.removeEventListener('click', aoConfirmar);
        modalConfirmarCancelar.removeEventListener('click', aoCancelar);
        resolve(resultado);
      }
      // Clicou em confirmar.
      function aoConfirmar() {
        limpar(true);
      }
      // Clicou em cancelar.
      function aoCancelar() {
        limpar(false);
      }
      modalConfirmarOk.addEventListener('click', aoConfirmar);
      modalConfirmarCancelar.addEventListener('click', aoCancelar);
    });
  }

  // Modal de confirmação do prestador ao aceitar um chamado: mostra cliente, local,
  // distância e tempo estimado. Devolve Promise<boolean> (aceitou ou não).
  function confirmarChamado(chamado) {
    const localizacaoCliente =
      typeof chamado.latitude === 'number' && typeof chamado.longitude === 'number'
        ? `${chamado.latitude.toFixed(5)}, ${chamado.longitude.toFixed(5)}`
        : 'Localização não disponível';
    const distanciaInfo = typeof chamado.distanciaKm === 'number' ? `${Number(chamado.distanciaKm).toFixed(1)} km` : 'Distância não disponível';
    const tempoInfo = typeof chamado.distanciaKm === 'number' ? tempoMedioChegada(chamado.distanciaKm) : 'Tempo não disponível';

    modalChamadoDetalhes.innerHTML = `
      <dt>Status</dt><dd>${rotuloStatus(chamado.status)}</dd>
      <dt>Categoria</dt><dd>${escaparHtml(chamado.categoriaNome) || '—'}</dd>
      <dt>Endereço</dt><dd>${escaparHtml(resumirEndereco(chamado.endereco))}</dd>
      <dt>Descrição</dt><dd>${escaparHtml(textoDescricao(chamado))}</dd>
      <dt>Localização do cliente</dt><dd>${escaparHtml(localizacaoCliente)}</dd>
      <dt>Solicitado em</dt><dd>${formatarData(chamado.dataAbertura)}</dd>
      <dt>Distância</dt><dd>${escaparHtml(distanciaInfo)}</dd>
      <dt>Tempo médio</dt><dd>${escaparHtml(tempoInfo)}</dd>
    `;
    modalConfirmarChamado.classList.remove('oculto');
    return new Promise((resolve) => {
      // Fecha o modal e entrega a resposta (aceitou/cancelou), removendo os listeners.
      function limpar(resultado) {
        Anim.sair(modalConfirmarChamado, 'saindo', 160).then(() => modalConfirmarChamado.classList.add('oculto'));
        modalChamadoAceitar.removeEventListener('click', aoAceitar);
        modalChamadoCancelar.removeEventListener('click', aoCancelar);
        resolve(resultado);
      }
      // Clicou em aceitar.
      function aoAceitar() { limpar(true); }
      // Clicou em cancelar.
      function aoCancelar() { limpar(false); }
      modalChamadoAceitar.addEventListener('click', aoAceitar);
      modalChamadoCancelar.addEventListener('click', aoCancelar);
    });
  }

  // Desabilita um botão e troca seu texto durante uma operação
  // assíncrona (ex.: enviar um formulário), restaurando tudo ao final.
  // Evita duplo clique e dá feedback visual de que algo está
  // acontecendo, em vez de a tela simplesmente "não reagir" por um instante.
  async function comCarregamento(botao, textoCarregando, fn) {
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = textoCarregando;
    try {
      await fn();
    } finally {
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }

  // Registra o service worker (public/sw.js), que permite o app ser
  // instalado (PWA) e funcionar de forma básica offline para quem já o
  // visitou antes. Puramente incremental: se o navegador não suportar
  // ou o registro falhar, o app continua funcionando normalmente.
  function registrarServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  // ---------------- Boot ----------------
  // Roda uma única vez, assim que a página carrega (chamada lá no final
  // do arquivo). Decide qual tela mostrar primeiro.
  async function iniciar() {
  registrarServiceWorker();

  // Verifica imediatamente se o usuário veio pelo
  // link de redefinição enviado por e-mail
  // O token vem no FRAGMENTO da URL (#redefinir=1&tipo=...&token=...): o
  // fragmento não é enviado ao servidor nem no Referer. Ele é lido uma vez e
  // apagado da barra de endereço na hora, antes de qualquer outra coisa.
  const parametros = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = parametros.get('redefinir') === '1' ? parametros.get('token') : null;
  const tipoRedefinicao = parametros.get('tipo');
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  if (token && tipoRedefinicao) {
    tokenRedefinicaoAtual = token;

    // Abre diretamente a tela para criar a nova senha
    mostrarTela('redefinirSenha');

    return;
  }

  // Se não for redefinição de senha, carrega normalmente
  try {
    await carregarCategorias();
  } catch (err) {
    mostrarTela('auth');
    toast(`Não foi possível carregar a aplicação: ${err.message}`);
    return;
  }

  // Verifica se existe uma sessão salva
  if (API.obterToken()) {
    try {
      const { tipo, usuario } = await API.quemSouEu();

      entrarComoUsuario(tipo, usuario);

      return;
    } catch {
      API.definirToken(null);
    }
  }

  // Caso normal: abre a tela de login
  mostrarTela('auth');
}
  // Busca as categorias de serviço na API e preenche os dois <select>
  // que dependem delas: o de cadastro de prestador e o de abertura de
  // chamado (que só existe depois do login como cliente, mas já
  // deixamos pronto).
  async function carregarCategorias() {
    const categorias = await API.categorias();
    const opcoesHtml = categorias.map((c) => `<option value="${c.id}">${escaparHtml(c.nome)}</option>`).join('');
    const seletores = [
      document.querySelector('#form-cadastro select[name="categoriaId"]'),
      document.getElementById('chamado-categoria')
    ];
    seletores.forEach((select) => {
      if (select) {
        select.innerHTML = opcoesHtml;
        renderizarCardsCategoria(select);
      }
    });
  }

  // ---- Seleção de categoria em cards (visual) ----------------------
  // Cada categoria fixa tem um ícone e uma cor de destaque próprios,
  // usados nos cards. O nome vem do servidor (ver server/db.js); aqui
  // só cuidamos da aparência. Categorias não mapeadas caem no ícone
  // genérico (ferramenta) sem quebrar nada.
  const CATEGORIA_INFO = {
    'Mecânico': {
      cor: '#64748B',
      descricao: 'Serviços mecânicos em geral.',
      icone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L2 19l3 3 7.3-7.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8z"/></svg>'
    },
    'Borracheiro': {
      cor: '#64748B',
      descricao: 'Reparos em pneus.',
      icone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6"/></svg>'
    },
    'Auto Elétrica': {
      cor: '#64748B',
      descricao: 'Serviços elétricos em geral.',
      icone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>'
    },
    'Guincho': {
      cor: '#64748B',
      descricao: 'Reboque e transporte do veículo.',
      icone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h1a2 2 0 0 0 4 0h7a2 2 0 0 0 4 0h1"/><path d="M3 17V8l4-1 3 4h4l3-3 4 2v7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>'
    }
  };
  const CATEGORIA_PADRAO = {
    cor: '#64748B',
    descricao: 'Serviço de assistência automotiva.',
    icone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L2 19l3 3 7.3-7.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8z"/></svg>'
  };

  // Constrói (ou atualiza) o grid de cards logo abaixo de um <select>
  // de categoria, mantendo o próprio <select> como fonte da verdade —
  // os cards só refletem e escrevem nele, então nenhum outro trecho
  // de app.js precisa saber que os cards existem.
  function renderizarCardsCategoria(select) {
    if (!select) return;
    let container = select.nextElementSibling;
    if (!container || !container.classList.contains('categoria-cards')) {
      container = document.createElement('div');
      container.className = 'categoria-cards';
      select.insertAdjacentElement('afterend', container);
    }

    const valorAtual = select.value;
    container.innerHTML = [...select.options].map((opcao) => {
      const info = CATEGORIA_INFO[opcao.textContent] || CATEGORIA_PADRAO;
      const ativa = String(opcao.value) === String(valorAtual);
      return `
        <button type="button" class="categoria-card${ativa ? ' ativa' : ''}" data-categoria-id="${opcao.value}" style="--categoria-cor: ${info.cor}" aria-pressed="${ativa}">
          <span class="categoria-card-check" aria-hidden="true">✓</span>
          <span class="categoria-card-icone" aria-hidden="true">${info.icone}</span>
          <span class="categoria-card-nome">${escaparHtml(opcao.textContent)}</span>
          <span class="categoria-card-desc">${info.descricao}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.categoria-card').forEach((card) => {
      card.addEventListener('click', () => {
        select.value = card.dataset.categoriaId;
        container.querySelectorAll('.categoria-card').forEach((c) => {
          const estaAtiva = c === card;
          c.classList.toggle('ativa', estaAtiva);
          c.setAttribute('aria-pressed', String(estaAtiva));
        });
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  // Depois de login/cadastro bem-sucedido, decide qual painel abrir, de
  // acordo com o tipo de usuário.
  function entrarComoUsuario(tipo, usuario) {
    usuarioTipoAtual = tipo;
    ultimoUsuario = usuario;
    if (tipo === 'cliente') iniciarPainelCliente(usuario);
    else if (tipo === 'prestador') iniciarPainelPrestador(usuario);
    else if (tipo === 'admin') iniciarPainelAdmin();
  }

  // =================================================================
  // Tela de autenticação (login / cadastro, cliente / prestador)
  // =================================================================
  const segPerfil = document.getElementById('seg-perfil'); // abas "Sou cliente" / "Sou prestador"
  const segModo = document.getElementById('seg-modo'); // abas "Entrar" / "Criar conta"
  const campoCategoria = document.getElementById('campo-categoria'); // só aparece para prestador
  const formLogin = document.getElementById('form-login');
  const formCadastro = document.getElementById('form-cadastro');
  const authErro = document.getElementById('auth-erro');

  const cartaoAuth = segModo.closest('.cartao-auth');
  // Índice de cada campo, usado no atraso em cascata da entrada (CSS: --i).
  [formLogin, formCadastro].forEach((f) => [...f.children].forEach((c, i) => c.style.setProperty('--i', i)));
  let perfilSelecionado = 'cliente'; // guarda a aba ativa (cliente/prestador) fora do DOM

  // Clique nas abas "Sou cliente" / "Sou prestador": marca visualmente a
  // aba escolhida e mostra/esconde o campo de categoria, que só faz
  // sentido para prestador.
  segPerfil.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-perfil]');
    if (!botao) return;
    perfilSelecionado = botao.dataset.perfil;
    [...segPerfil.children].forEach((b) => b.classList.toggle('ativo', b === botao));
    const ehPrestador = perfilSelecionado === 'prestador';
    campoCategoria.querySelector('select').required = ehPrestador;
    // O campo de categoria muda a altura do card de cadastro: anima.
    Anim.altura(cartaoAuth, () => campoCategoria.classList.toggle('oculto', !ehPrestador), {
      sai: ehPrestador || formCadastro.classList.contains('oculto') ? null : campoCategoria,
      entra: ehPrestador && !formCadastro.classList.contains('oculto') ? campoCategoria : null
    });
  });

  // Clique nas abas "Entrar" / "Criar conta": alterna qual dos dois
  // formulários fica visível.
  segModo.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-modo]');
    if (!botao) return;
    const modo = botao.dataset.modo;
    if (botao.classList.contains('ativo')) return;
    [...segModo.children].forEach((b) => b.classList.toggle('ativo', b === botao));
    // O card cresce/encolhe (Anim.altura): o formulário antigo some, a altura
    // anima e os campos novos entram em cascata. Card segue centralizado.
    cartaoAuth.classList.add('trocando');
    setTimeout(() => cartaoAuth.classList.remove('trocando'), 560);
    Anim.altura(cartaoAuth, () => {
      formLogin.classList.toggle('oculto', modo !== 'login');
      formCadastro.classList.toggle('oculto', modo !== 'cadastro');
      esconderErro();
    }, {
      sai: modo === 'cadastro' ? formLogin : formCadastro,
      entra: modo === 'cadastro' ? formCadastro : formLogin
    });
  });

  // Mostra a mensagem de erro no cartão de login/cadastro, animando a altura do cartão.
  function mostrarErro(mensagem) {
    Anim.altura(cartaoAuth, () => {
      authErro.textContent = mensagem;
      authErro.classList.remove('oculto');
    }, { entra: authErro });
  }
  // Esconde a mensagem de erro do cartão de login/cadastro.
  function esconderErro() {
    authErro.classList.add('oculto');
  }

  // Envio do formulário de login. "FormData" + "Object.fromEntries" lê
  // todos os campos do formulário de uma vez (pelo atributo "name" de
  // cada <input>), sem precisar pegar um por um.
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault(); // impede o navegador de recarregar a página (comportamento padrão de <form>)
    esconderErro();
    const dados = Object.fromEntries(new FormData(formLogin));
    await comCarregamento(formLogin.querySelector('button[type="submit"]'), 'Entrando...', async () => {
      try {
        const { token, usuario } = await API.login({ tipo: perfilSelecionado, ...dados });
        API.definirToken(token);
        formLogin.reset();
        entrarComoUsuario(perfilSelecionado, usuario);
      } catch (err) {
        mostrarErro(err.message);
      }
    });
  });

  // Envio do formulário de cadastro — mesma lógica do login, chamando
  // API.registrar em vez de API.login.
  formCadastro.addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro();
    const dados = Object.fromEntries(new FormData(formCadastro));
    await comCarregamento(formCadastro.querySelector('button[type="submit"]'), 'Criando conta...', async () => {
      try {
        const resposta = await API.registrar({ tipo: perfilSelecionado, ...dados });
        formCadastro.reset();

        if (perfilSelecionado === 'prestador' && resposta && resposta.mensagem) {
          mostrarErro(resposta.mensagem);
          return;
        }

        const { token, usuario } = resposta;
        API.definirToken(token);
        entrarComoUsuario(perfilSelecionado, usuario);
      } catch (err) {
        mostrarErro(err.message);
      }
    });
  });

  // =================================================================
  // Popup "Complete seu cadastro" (CPF/telefone)
  //
  // Contas criadas pelo Google navegam livremente, mas só fazem pedido
  // (cliente) ou aceitam chamado (prestador) depois de informar CPF e
  // telefone. A regra de verdade está no servidor (403 PERFIL_INCOMPLETO);
  // aqui o popup só deixa o caminho suave e retoma a ação depois de salvar.
  // =================================================================
  const modalPerfil = document.getElementById('modal-perfil');
  const formPerfil = document.getElementById('form-perfil');
  const perfilErro = document.getElementById('perfil-erro');
  const perfilCampoCpf = document.getElementById('perfil-campo-cpf');
  const perfilCampoTelefone = document.getElementById('perfil-campo-telefone');
  const perfilCancelar = document.getElementById('perfil-cancelar');
  let perfilEmAberto = null; // evita abrir o popup duas vezes ao mesmo tempo

  // Quais dados ainda faltam no perfil do usuário logado (['cpf', 'telefone']).
  // Vem do servidor (campo "pendencias"); lista vazia = perfil completo.
  function pendenciasDoPerfil() {
    return ultimoUsuario && Array.isArray(ultimoUsuario.pendencias) ? ultimoUsuario.pendencias : [];
  }

  // Abre o popup e devolve uma Promise: true = perfil salvo, false = desistiu.
  function pedirCompletarPerfil(faltam) {
    if (perfilEmAberto) return perfilEmAberto;
    perfilCampoCpf.classList.toggle('oculto', !faltam.includes('cpf'));
    perfilCampoTelefone.classList.toggle('oculto', !faltam.includes('telefone'));
    formPerfil.reset();
    perfilErro.classList.add('oculto');
    modalPerfil.classList.remove('oculto');
    const primeiro = formPerfil.querySelector('label:not(.oculto) input');
    if (primeiro) primeiro.focus();

    perfilEmAberto = new Promise((resolve) => {
      // Fecha o popup e entrega o resultado (true = salvou, false = desistiu).
      function encerrar(resultado) {
        formPerfil.removeEventListener('submit', aoEnviar);
        perfilCancelar.removeEventListener('click', aoCancelar);
        document.removeEventListener('keydown', aoTecla);
        Anim.sair(modalPerfil, 'saindo', 160).then(() => modalPerfil.classList.add('oculto'));
        perfilEmAberto = null;
        resolve(resultado);
      }
      // Envio do formulário do popup: manda ao servidor só os campos que faltam.
      async function aoEnviar(e) {
        e.preventDefault();
        perfilErro.classList.add('oculto');
        const dados = {};
        if (faltam.includes('cpf')) dados.cpf = formPerfil.elements.cpf.value;
        if (faltam.includes('telefone')) dados.telefone = formPerfil.elements.telefone.value;
        await comCarregamento(formPerfil.querySelector('button[type="submit"]'), 'Salvando...', async () => {
          try {
            const { usuario } = await API.completarPerfil(dados);
            ultimoUsuario = { ...(ultimoUsuario || {}), ...usuario };
            encerrar(true);
          } catch (err) {
            perfilErro.textContent = err.message;
            perfilErro.classList.remove('oculto');
          }
        });
      }
      // Botão "agora não".
      function aoCancelar() { encerrar(false); }
      // Tecla Esc também fecha o popup.
      function aoTecla(ev) { if (ev.key === 'Escape') encerrar(false); }
      formPerfil.addEventListener('submit', aoEnviar);
      perfilCancelar.addEventListener('click', aoCancelar);
      document.addEventListener('keydown', aoTecla);
    });
    return perfilEmAberto;
  }

  // Antes de fazer pedido / aceitar chamado: true = pode seguir.
  async function garantirPerfilCompleto() {
    const faltam = pendenciasDoPerfil();
    return faltam.length === 0 ? true : pedirCompletarPerfil(faltam);
  }

  // O servidor recusou por perfil incompleto (dado local desatualizado): abre o popup.
  function tratarPerfilIncompleto(err) {
    if (!err || err.codigo !== 'PERFIL_INCOMPLETO') return false;
    ultimoUsuario = { ...(ultimoUsuario || {}), pendencias: err.faltam || ['cpf', 'telefone'] };
    pedirCompletarPerfil(ultimoUsuario.pendencias).then((salvou) => {
      if (salvou) toast('Cadastro completo. Agora é só repetir a ação.', 'sucesso');
    });
    return true;
  }

  // =================================================================
  // Login com Google (Google Identity Services)
  //
  // O botão só aparece se o servidor tiver GOOGLE_CLIENT_ID. O Google devolve
  // um ID token; quem o valida é o SERVIDOR (POST /api/auth/google). O script
  // do Google só é carregado quando o recurso está ligado.
  //
  // NONCE (anti-replay): antes de mostrar o botão pedimos ao servidor um nonce
  // de uso único e o entregamos ao Google (initialize). O Google o grava dentro
  // do token assinado; o servidor confere e gasta esse nonce no login. Como cada
  // nonce só funciona uma vez, depois de TODA tentativa pedimos um novo e
  // reconfiguramos o botão (prepararBotaoGoogle).
  // =================================================================
  const googleArea = document.getElementById('google-area');
  const googleBotao = document.getElementById('google-botao');
  let googleClientId = null; // preenchido por iniciarGoogle(); null = recurso desligado
  let googlePreparando = false; // evita duas preparações simultâneas do botão

  // Monta o corpo e chama POST /api/auth/google. "confirmarVinculo" só vai
  // como true depois que o usuário aceitou o aviso de vínculo de conta.
  function enviarCredencialGoogle(credential, confirmarVinculo) {
    const categoriaId = formCadastro.elements.categoriaId ? formCadastro.elements.categoriaId.value : '';
    const corpo = { credential, tipo: perfilSelecionado };
    if (perfilSelecionado === 'prestador' && categoriaId) corpo.categoriaId = Number(categoriaId);
    if (confirmarVinculo) corpo.confirmarVinculo = true;
    return API.loginGoogle(corpo);
  }

  // Chamada pelo Google quando o usuário escolhe uma conta.
  async function aoReceberCredencialGoogle(resposta) {
    esconderErro();
    try {
      let resultado;
      try {
        resultado = await enviarCredencialGoogle(resposta.credential, false);
      } catch (err) {
        if (err.codigo !== 'CONFIRMAR_VINCULO') throw err;
        // Já existe uma conta com senha neste e-mail: vincular ao Google remove a
        // senha. O servidor não altera nada até o usuário confirmar aqui; se
        // confirmar, reenviamos o MESMO token (o nonce ainda não foi gasto).
        const aceitou = await confirmar(err.message);
        if (!aceitou) return;
        resultado = await enviarCredencialGoogle(resposta.credential, true);
      }

      if (resultado.pendente) {
        mostrarErro(resultado.mensagem || 'Cadastro enviado para aprovação do administrador.');
        return;
      }
      API.definirToken(resultado.token);
      entrarComoUsuario(perfilSelecionado, resultado.usuario);
      if (resultado.vinculada) {
        toast('Conta vinculada ao Google. Para voltar a entrar com senha, use "Esqueceu sua senha?".', 'sucesso');
      }
    } catch (err) {
      if (err.codigo === 'CATEGORIA_OBRIGATORIA') {
        // Prestador novo precisa escolher a categoria na aba "Criar conta".
        segModo.querySelector('[data-modo="cadastro"]').click();
      }
      mostrarErro(err.message);
    } finally {
      // O nonce desta tentativa já foi usado (ou descartado): prepara outro.
      // Se o login deu certo (usuarioTipoAtual definido) não há botão visível;
      // o botão é preparado de novo no logout (ver encerrarSessaoLocal).
      if (!usuarioTipoAtual) prepararBotaoGoogle();
    }
  }

  // Pede um nonce novo, reconfigura o Google e redesenha o botão. É chamada no
  // início, depois de cada tentativa, a cada 10 min (o nonce vale 15) e quando
  // a aba volta a ficar visível (pode ter passado muito tempo escondida).
  async function prepararBotaoGoogle() {
    if (!googleClientId || googlePreparando) return;
    if (!window.google || !window.google.accounts) return;
    googlePreparando = true;
    try {
      const { nonce } = await API.googleNonce();
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: aoReceberCredencialGoogle,
        nonce
      });
      // A área precisa estar visível ANTES de redesenhar: se estiver escondida,
      // clientWidth vale 0 e o botão sairia sempre com a largura padrão.
      googleArea.classList.remove('oculto');
      window.google.accounts.id.renderButton(googleBotao, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        locale: 'pt-BR',
        width: Math.min(360, Math.max(200, googleBotao.clientWidth || 300))
      });

      const iframeGoogle = googleBotao.querySelector('iframe');
      if (iframeGoogle) {
        iframeGoogle.style.borderRadius = '999px';
        iframeGoogle.style.overflow = 'hidden';
      }
    } catch {
      // Sem nonce não há como logar com Google com segurança: esconde o botão.
      // O login por e-mail e senha segue funcionando normalmente.
      googleArea.classList.add('oculto');
    } finally {
      googlePreparando = false;
    }
  }

  // Ponto de partida do login com Google: pergunta ao servidor se o recurso está
  // ligado (GOOGLE_CLIENT_ID) e, se estiver, carrega o script do Google e agenda a
  // renovação do nonce. Qualquer falha só esconde o botão; o login por senha continua.
  async function iniciarGoogle() {
    if (!googleArea || !googleBotao) return;
    let clientId = null;
    try {
      ({ clientId } = await API.googleConfig());
    } catch {
      return; // sem servidor/Google: o login por e-mail e senha segue normal
    }
    if (!clientId) return;
    googleClientId = clientId;

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = prepararBotaoGoogle;
    // Se o script do Google não carregar (bloqueador, sem internet), o botão simplesmente não aparece.
    document.head.appendChild(script);

    // Renova o nonce antes de vencer e quando a aba volta a ser vista.
    setInterval(() => {
      if (!usuarioTipoAtual && !document.hidden) prepararBotaoGoogle();
    }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !usuarioTipoAtual) prepararBotaoGoogle();
    });
  }
  iniciarGoogle();

  // Botão "Sair": avisa a API (para invalidar o token no servidor),
  // apaga o token local e volta para a tela de login. Funciona para
  // cliente, prestador OU admin — o backend só olha o token, não o tipo.
  btnSair.addEventListener('click', async () => {
    // A tela atual some suavemente ainda preenchida; só então limpamos tudo.
    const atual = Object.values(telas).find((el) => !el.classList.contains('oculta'));
    await Anim.sair(atual);
    const pedido = API.logout().catch(() => {
      // Mesmo que o logout no servidor falhe (ex.: sessão já expirada),
      // seguimos limpando o token local e voltando para o login.
    });
    encerrarSessaoLocal();
    mostrarTela('auth'); // a tela de login entra com a animação padrão
    await pedido;
    API.definirToken(null);
  });

  // Zera tudo o que a interface guardava de quem estava logado: para o
  // polling e o GPS, esquece o usuário e limpa as listas da tela (para a
  // próxima pessoa que entrar neste navegador não ver, nem por um instante,
  // o histórico da anterior). Usada no "Sair" e quando a sessão expira.
  function encerrarSessaoLocal() {
    // Pede ao Google para não "relogar" sozinho a mesma conta (auto-select do One
    // Tap): sem isso, depois de sair, o Google poderia entrar de novo sem o
    // usuário clicar em nada. Seguro mesmo se o Google não estiver carregado.
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    pararAtualizacaoAutomatica();
    reiniciarNotificacoes();
    usuarioTipoAtual = null;
    ultimoUsuario = null;
    chamadoEmFoco = null;
    [
      clienteHistoricoEl,
      prestadorHistoricoEl,
      listaDisponiveisEl,
      prestadorListaAvaliacoesEl,
      detalhesEl,
      prestadorChamadoDetalhesEl,
      linhaTempoClienteEl,
      prestadorLinhaTempoEl
    ].forEach((el) => {
      el.innerHTML = '';
      delete el.dataset.assinatura;
    });
    // Estado do atendimento do prestador (ver "Painel do prestador").
    prestadorVendoFinal = false;
    acaoPrestadorEmCurso = false;
    prestadorComChamadoEl.classList.add('oculto');
    modalCancelarAtendimento.classList.add('oculto');
    statusBannerChave = null;
    // O painel admin esconde o formulário de login ao entrar; sem restaurar,
    // o próximo "Acesso administrativo" abriria o painel vazio, sem pedir senha.
    adminLoginEl.classList.remove('oculta');
    adminPainelEl.classList.add('oculta');
    // O nonce da última entrada com Google foi gasto: prepara o botão de novo.
    prepararBotaoGoogle();
  }

  // api.js dispara este evento quando o servidor recusa o token (sessão de
  // 24 h vencida ou servidor reiniciado). Levamos o usuário ao login em vez
  // de deixar o painel falhando em silêncio a cada atualização.
  window.addEventListener('sessao-expirada', () => {
    if (!usuarioTipoAtual) return; // não estava logado: nada a fazer
    encerrarSessaoLocal();
    mostrarTela('auth');
    toast('Sua sessão expirou. Faça login novamente.');
  });

  // Botão de Configurações: abre a tela de config preenchida com os dados do usuário
  if (btnConfig) {
    btnConfig.addEventListener('click', async () => {
      try {
        const { usuario } = await API.quemSouEu();
        // preenche o formulário
        formConfig.elements.nome.value = usuario.nome || '';
        formConfig.elements.telefone.value = usuario.telefone || '';
        campoCategoriaConfig.classList.toggle('oculto', usuarioTipoAtual !== 'prestador');
        campoRaioConfig.classList.toggle('oculto', usuarioTipoAtual !== 'prestador');
        if (usuarioTipoAtual === 'prestador') formConfig.elements.raioKm.value = usuario.raioKm != null ? usuario.raioKm : 15;
        if (usuarioTipoAtual === 'prestador') {
          const categorias = await API.categorias();
          formConfig.elements.categoriaId.innerHTML = categorias
            .map((categoria) => `<option value="${categoria.id}">${escaparHtml(categoria.nome)}</option>`)
            .join('');
          formConfig.elements.categoriaId.value = String(usuario.categoriaId);
          categoriaConfigAtual = String(usuario.categoriaId);
          renderizarCardsCategoria(formConfig.elements.categoriaId);
        }
        formConfig.elements.senha.value = '';
        formConfig.elements.senhaAtual.value = '';
        // Conta só-Google: não há senha para trocar. Esconde os campos e explica
        // o caminho (Esqueceu sua senha?), que prova o controle do e-mail.
        const temSenha = usuario.temSenha !== false;
        campoSenhaAtualConfig.classList.toggle('oculto', !temSenha);
        campoSenhaNovaConfig.classList.toggle('oculto', !temSenha);
        avisoSemSenhaConfig.classList.toggle('oculto', temSenha);
        mostrarTela('config');
      } catch (err) {
        toast('Não foi possível carregar seus dados: ' + err.message, 'erro');
      }
    });
  }

  // Envio do formulário de configurações: atualiza usuário via API
  if (formConfig) {
    formConfig.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dados = Object.fromEntries(new FormData(formConfig));
      // Sem nova senha, não envia nenhum dos dois campos de senha.
      if (!dados.senha) {
        delete dados.senha;
        delete dados.senhaAtual;
      }
      if (usuarioTipoAtual !== 'prestador') delete dados.categoriaId;
      // Raio só existe para prestador; o servidor revalida (1–100 km, número).
      if (usuarioTipoAtual !== 'prestador' || dados.raioKm === '') delete dados.raioKm;
      else dados.raioKm = Number(dados.raioKm);
      const trocouCategoria =
        usuarioTipoAtual === 'prestador' && dados.categoriaId !== categoriaConfigAtual;
      if (trocouCategoria && !(await confirmar('Trocar sua categoria de atendimento? Os próximos chamados serão dessa nova categoria.'))) {
        return;
      }
      await comCarregamento(formConfig.querySelector('button[type="submit"]'), 'Salvando...', async () => {
        try {
          await API.atualizarUsuario(dados);
          // lê os dados atualizados e reentra no painel apropriado
          const me = await API.quemSouEu();
          entrarComoUsuario(me.tipo, me.usuario);
          toast('Dados atualizados com sucesso.', 'sucesso');
        } catch (err) {
          toast(err.message, 'erro');
        }
      });
    });
  }

  if (btnConfigCancel) {
    btnConfigCancel.addEventListener('click', () => {
      if (usuarioTipoAtual && ultimoUsuario) entrarComoUsuario(usuarioTipoAtual, ultimoUsuario);
      else irParaTela('auth');
    });
  }

  // Clique no logo/marca: vai para a tela principal (painel do usuário
  // se estiver logado, ou tela de autenticação se não estiver).
  const marcaEl = document.querySelector('.marca');
  if (marcaEl) {
    marcaEl.addEventListener('click', voltarTelaPrincipal);
  }

  // Todo botão "Voltar" (telas institucionais, login de admin,
  // "esqueci minha senha") tem a mesma classe e o mesmo destino: volta
  // para o painel de quem estiver logado, ou para o login.
  document.querySelectorAll('.btn-voltar').forEach((botao) => {
    botao.addEventListener('click', voltarTelaPrincipal);
  });

  // Links do rodapé (Sobre/Ajuda/Termos/Privacidade/Acesso
  // administrativo) — delegação num único listener no <nav>, todos
  // usando o atributo "data-tela" com o nome da tela a abrir.
  const rodapeLinks = document.querySelector('.rodape-links');
  if (rodapeLinks) {
    rodapeLinks.addEventListener('click', (e) => {
      const link = e.target.closest('[data-tela]');
      if (!link) return;
      e.preventDefault();
      irParaTela(link.dataset.tela);
    });
  }

  // =================================================================
  // Esqueci minha senha / redefinir senha
  // =================================================================
  const btnEsqueciSenha = document.getElementById('btn-esqueci-senha');
  const formEsqueciSenha = document.getElementById('form-esqueci-senha');
  const esqueciSenhaSucesso = document.getElementById('esqueci-senha-sucesso');
  const formRedefinirSenha = document.getElementById('form-redefinir-senha');
  const redefinirSenhaErro = document.getElementById('redefinir-senha-erro');
  let tokenRedefinicaoAtual = null; // preenchido em iniciar() a partir da URL do link de e-mail

  if (btnEsqueciSenha) {
    btnEsqueciSenha.addEventListener('click', () => {
      formEsqueciSenha.reset();
      formEsqueciSenha.classList.remove('oculto');
      esqueciSenhaSucesso.classList.add('oculto');
      irParaTela('esqueciSenha');
    });
  }

  if (formEsqueciSenha) {
    formEsqueciSenha.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dados = Object.fromEntries(new FormData(formEsqueciSenha));
      await comCarregamento(formEsqueciSenha.querySelector('button[type="submit"]'), 'Enviando...', async () => {
        try {
          const resposta = await API.esqueciSenha(dados);
          // O servidor devolve sempre a mesma mensagem genérica; o link só existe no e-mail.
          esqueciSenhaSucesso.textContent = resposta.mensagem;
          esqueciSenhaSucesso.classList.remove('oculto');
          formEsqueciSenha.classList.add('oculto');
        } catch (err) {
          toast(err.message, 'erro');
        }
      });
    });
  }

  if (formRedefinirSenha) {
    formRedefinirSenha.addEventListener('submit', async (e) => {
      e.preventDefault();
      redefinirSenhaErro.classList.add('oculto');
      const dados = Object.fromEntries(new FormData(formRedefinirSenha));
      const novaSenha = String(dados.novaSenha ?? '').trim();

      if (!tokenRedefinicaoAtual) {
        redefinirSenhaErro.textContent = 'Link de redefinição inválido ou ausente.';
        redefinirSenhaErro.classList.remove('oculto');
        return;
      }

      if (novaSenha.length < 4 || novaSenha.length > 72) {
        redefinirSenhaErro.textContent = 'A nova senha deve ter entre 4 e 72 caracteres.';
        redefinirSenhaErro.classList.remove('oculto');
        return;
      }

await comCarregamento(
  formRedefinirSenha.querySelector('button[type="submit"]'),
  'Redefinindo...',
  async () => {
    try {
      await API.redefinirSenha({
        token: tokenRedefinicaoAtual,
        novaSenha
      });

      // Remove o token da URL
      window.history.replaceState({}, '', window.location.pathname);

      // Limpa o formulário
      formRedefinirSenha.reset();

      // Mostra mensagem de sucesso
      toast(
        'Senha redefinida com sucesso. Faça login com a nova senha.',
        'sucesso'
      );

      // Atualiza a página e volta para o login
      setTimeout(() => {
        window.location.replace('/');
      }, 1500);

    } catch (err) {
      console.error('[redefinir-senha] Erro:', err);

      redefinirSenhaErro.textContent =
        err.message || 'Não foi possível redefinir a senha.';

      redefinirSenhaErro.classList.remove('oculto');
        }
      });
    });
  }

  // =================================================================
  // Painel do cliente
  // =================================================================
  const clienteNomeEl = document.getElementById('cliente-nome');
  const semChamadoEl = document.getElementById('cliente-sem-chamado'); // formulário de "pedir socorro"
  const comChamadoEl = document.getElementById('cliente-com-chamado'); // acompanhamento do chamado atual
  const formChamado = document.getElementById('form-chamado');
  const btnUsarLocalizacao = document.getElementById('btn-usar-localizacao');
  const btnLocalizarEndereco = document.getElementById('btn-localizar-endereco');
  const localizacaoStatus = document.getElementById('localizacao-status');
  const progressoEl = document.getElementById('progresso-chamado'); // "trilha" com as 4 etapas do chamado
  const detalhesEl = document.getElementById('chamado-detalhes');
  const btnCancelarChamado = document.getElementById('btn-cancelar-chamado');
  const modalAvaliacao = document.getElementById('modal-avaliacao');
  const formAvaliacao = document.getElementById('form-avaliacao');
  const estrelasEl = document.getElementById('estrelas');
  const clienteHistoricoEl = document.getElementById('cliente-historico');
  const statusBannerEl = document.getElementById('chamado-status-banner');
  const statusTituloEl = document.getElementById('chamado-status-titulo');
  const statusSubEl = document.getElementById('chamado-status-sub');
  const linhaTempoClienteEl = document.getElementById('chamado-linha-tempo');
  const btnFecharCancelamento = document.getElementById('btn-fechar-cancelamento');

  // Centro de São Paulo, usado como localização de reserva apenas se o
  // cliente não conceder permissão de geolocalização — o pedido de
  // socorro não pode travar só porque o navegador negou o GPS.
  const LOCALIZACAO_RESERVA = { latitude: -23.55052, longitude: -46.633308 };

  let localizacaoCliente = null; // coordenadas obtidas pelo botão "Usar minha localização"
  let watchIdCliente = null;
  let notaSelecionada = 0; // nota (1-5) escolhida no componente de estrelas

  // Chamada uma vez, logo após o login/cadastro como cliente.
  function iniciarPainelCliente(usuario) {
    clienteNomeEl.textContent = usuario.nome;
    mostrarTela('cliente');
    montarEstrelas();
    pararAtualizacaoAutomatica();
    iniciarRastreamentoCliente();
    // Busca agora e depois a cada 3 segundos o chamado atual e o histórico —
    // é assim que a tela do cliente "percebe" quando um prestador aceita
    // o chamado, sem precisar de WebSockets.
    iniciarAtualizacaoAutomatica(atualizarPainelCliente, 3000);
  }

  // Mantém a posição do cliente atualizada para que o prestador veja seu
  // deslocamento no próprio mapa enquanto o chamado estiver ativo.
  function iniciarRastreamentoCliente() {
    if (!navigator.geolocation || !window.isSecureContext) return;
    if (watchIdCliente !== null) navigator.geolocation.clearWatch(watchIdCliente);
    watchIdCliente = navigator.geolocation.watchPosition(
      async (pos) => {
        const chamado = chamadoEmFoco;
        if (!chamado || !['aberto', 'aceito', 'em_andamento'].includes(chamado.status)) return;
        try {
          await API.atualizarLocalizacaoChamado(chamado.id, {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude
          });
        } catch {
          // A próxima posição tenta sincronizar novamente.
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
  }

  // Botão "Usar minha localização": pede ao navegador as coordenadas
  // GPS atuais (API nativa navigator.geolocation, que exibe o popup de
  // permissão do navegador).
  btnUsarLocalizacao.addEventListener('click', () => {
    if (!navigator.geolocation) {
      localizacaoStatus.textContent = 'Geolocalização não é suportada neste navegador.';
      return;
    }
    if (!window.isSecureContext) {
      localizacaoStatus.textContent =
        'O Chrome bloqueia a localização nesta rede sem HTTPS. Abra em localhost ou configure HTTPS no servidor.';
      return;
    }
    localizacaoStatus.textContent = 'Obtendo localização...';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        localizacaoCliente = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };

        try {
          const endereco = await API.reverseGeocodificar(localizacaoCliente.latitude, localizacaoCliente.longitude);
          const textoEndereco = endereco?.enderecoFormatado ||
            `Coordenadas: ${localizacaoCliente.latitude.toFixed(5)}, ${localizacaoCliente.longitude.toFixed(5)}`;
          formChamado.elements.endereco.value = textoEndereco;
          formChamado.elements.endereco.dispatchEvent(new Event('input', { bubbles: true }));
          localizacaoStatus.textContent = endereco?.enderecoFormatado
            ? 'Localização obtida e endereço preenchido automaticamente.'
            : `Localização obtida (${localizacaoCliente.latitude.toFixed(4)}, ${localizacaoCliente.longitude.toFixed(4)}).`;
        } catch {
          const textoFallback = `Coordenadas: ${localizacaoCliente.latitude.toFixed(5)}, ${localizacaoCliente.longitude.toFixed(5)}`;
          formChamado.elements.endereco.value = textoFallback;
          formChamado.elements.endereco.dispatchEvent(new Event('input', { bubbles: true }));
          localizacaoStatus.textContent = `Localização obtida (${localizacaoCliente.latitude.toFixed(4)}, ${localizacaoCliente.longitude.toFixed(4)}).`;
        }
      },
      () => {
        localizacaoStatus.textContent = 'Não foi possível obter sua localização. O endereço informado será usado.';
      }
    );
  });

  btnLocalizarEndereco.addEventListener('click', async () => {
    const endereco = new FormData(formChamado).get('endereco');
    if (typeof endereco !== 'string' || endereco.trim().length < 5) {
      localizacaoStatus.textContent = 'Informe o endereço antes de localizá-lo.';
      return;
    }

    localizacaoStatus.textContent = 'Localizando endereço...';
    try {
      const localizacao = await API.geocodificar(endereco);
      localizacaoCliente = localizacao;
      localizacaoStatus.textContent =
        `Endereço localizado (${localizacao.latitude.toFixed(5)}, ${localizacao.longitude.toFixed(5)}).`;
    } catch (err) {
      localizacaoStatus.textContent = err.message;
    }
  });

  // Envio do formulário "Precisa de socorro agora?": abre um novo
  // chamado. Usa a localização obtida por GPS se houver; senão, cai no
  // fallback fixo (LOCALIZACAO_RESERVA), já que o backend exige
  // latitude/longitude numéricas.
  formChamado.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(formChamado));
    // Conta nova (ex.: Google) ainda sem CPF/telefone: popup obrigatório antes do 1º pedido.
    if (!(await garantirPerfilCompleto())) return;
    await comCarregamento(formChamado.querySelector('button[type="submit"]'), 'Enviando...', async () => {
      try {
        let localizacao = localizacaoCliente;
        if (!localizacao && dados.endereco) {
          try {
            localizacao = await API.geocodificar(dados.endereco);
            localizacaoStatus.textContent =
              `Endereço localizado (${localizacao.latitude.toFixed(5)}, ${localizacao.longitude.toFixed(5)}).`;
          } catch {
            localizacao = LOCALIZACAO_RESERVA;
            localizacaoStatus.textContent = 'Endereço não localizado; usando posição de demonstração.';
          }
        }
        localizacao = localizacao || LOCALIZACAO_RESERVA;
        await API.abrirChamado({
          categoriaId: Number(dados.categoriaId),
          endereco: dados.endereco,
          descricao: dados.descricao,
          latitude: localizacao.latitude,
          longitude: localizacao.longitude
        });
        formChamado.reset();
        localizacaoCliente = null;
        localizacaoStatus.textContent = '';
        await atualizarPainelCliente(); // já troca a tela para "acompanhamento do chamado"
      } catch (err) {
        if (tratarPerfilIncompleto(err)) return;
        toast(err.message, 'erro');
      }
    });
  });

  btnCancelarChamado.addEventListener('click', async () => {
    if (!chamadoEmFoco || !(await confirmar('Cancelar este chamado?'))) return;
    try {
      await API.cancelarChamado(chamadoEmFoco.id);
      await atualizarPainelCliente();
    } catch (err) {
      toast(err.message, 'erro');
    }
  });

  // Cria as 5 estrelas clicáveis da avaliação. Cada uma guarda seu
  // próprio valor (1 a 5) em data-valor; ao clicar, marcamos como
  // "ativa" todas as estrelas até a clicada (efeito visual comum de
  // avaliação por estrelas).
  function montarEstrelas() {
    estrelasEl.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const span = document.createElement('span');
      span.className = 'estrela';
      span.textContent = '★';
      span.dataset.valor = i;
      span.addEventListener('click', () => {
        notaSelecionada = i;
        [...estrelasEl.children].forEach((el) => el.classList.toggle('ativa', Number(el.dataset.valor) <= i));
      });
      estrelasEl.appendChild(span);
    }
  }

  if (modalAvaliacao) {
    modalAvaliacao.addEventListener('click', (e) => {
      if (e.target === modalAvaliacao) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modalAvaliacao.classList.contains('oculto')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  formAvaliacao.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!notaSelecionada) {
      toast('Escolha uma nota de 1 a 5 estrelas.', 'erro');
      return;
    }
    const dados = Object.fromEntries(new FormData(formAvaliacao));
    await comCarregamento(formAvaliacao.querySelector('button[type="submit"]'), 'Enviando...', async () => {
      try {
        await API.avaliarChamado(chamadoEmFoco.id, { nota: notaSelecionada, comentario: dados.comentario });
        notaSelecionada = 0;
        formAvaliacao.reset();
        if (modalAvaliacao) modalAvaliacao.classList.add('oculto');
        await atualizarPainelCliente();
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
  });

  // Botão "Fazer novo pedido": o cliente viu que o atendimento foi cancelado
  // (pelo prestador ou pela administração) — libera o formulário de novo pedido.
  // O chamado continua no histórico.
  btnFecharCancelamento.addEventListener('click', async () => {
    if (!chamadoEmFoco) return;
    await comCarregamento(btnFecharCancelamento, 'Aguarde...', async () => {
      try {
        await API.cancelamentoVisto(chamadoEmFoco.id);
        await atualizarPainelCliente();
      } catch (err) {
        toast(mensagemErroAcao(err), 'erro');
      }
    });
  });

  // "3,4 km" (vírgula decimal).
  function formatarKm(km) {
    const n = Number(km);
    if (!Number.isFinite(n)) return '';
    return `${(Math.round(n * 10) / 10).toString().replace('.', ',')} km`;
  }

  // =================================================================
  // Central de Notificações
  //
  // O servidor guarda as notificações (com estado lido/não lido) e devolve o
  // total de não lidas; o contador do sino vem sempre dele, por isso continua
  // certo ao recarregar a página ou sair e entrar. A atualização usa o mesmo
  // polling dos painéis (ver iniciarAtualizacaoAutomatica) — sem timers extras.
  // =================================================================
  const notificacoesEl = document.getElementById('notificacoes');
  const btnNotificacoes = document.getElementById('btn-notificacoes');
  const contadorNotificacoesEl = document.getElementById('contador-notificacoes');
  const painelNotificacoesEl = document.getElementById('painel-notificacoes');
  const listaNotificacoesEl = document.getElementById('lista-notificacoes');
  const notificacoesVazioEl = document.getElementById('notificacoes-vazio');
  const btnMarcarTodasLidas = document.getElementById('btn-marcar-todas-lidas');

  let notificacoesAtuais = [];
  let notificacoesVistas = new Set(); // ids já conhecidos: só o que for novo vira alerta visual
  let notificacoesPrimeiraCarga = true; // a 1ª carga não gera alertas (só o contador)
  let notificacoesEmCurso = false;

  const TOAST_POR_TIPO = { concluido: 'sucesso', cancelado: 'erro', cancelado_cliente: 'erro' };

  // Tempo decorrido em texto curto: "agora", "há 5 min", "há 2 h", "há 3 d".
  function tempoRelativo(iso) {
    const seg = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (!Number.isFinite(seg)) return '';
    if (seg < 60) return 'agora';
    if (seg < 3600) return `há ${Math.floor(seg / 60)} min`;
    if (seg < 86400) return `há ${Math.floor(seg / 3600)} h`;
    return `há ${Math.floor(seg / 86400)} d`;
  }

  // Redesenha o sino de notificações: contador de não lidas (99+ no máximo), estado
  // dos botões e a lista, só se algo mudou (evita piscar a cada atualização).
  function desenharNotificacoes(naoLidas) {
    contadorNotificacoesEl.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
    contadorNotificacoesEl.classList.toggle('oculto', naoLidas === 0);
    btnNotificacoes.setAttribute('aria-label', naoLidas ? `Notificações, ${naoLidas} não lidas` : 'Notificações');
    btnMarcarTodasLidas.disabled = naoLidas === 0;
    notificacoesVazioEl.classList.toggle('oculto', notificacoesAtuais.length > 0);
    // Redesenha só se algo mudou (evita piscar a lista a cada tique do polling).
    const assinatura = notificacoesAtuais.map((n) => `${n.id}:${n.lida ? 1 : 0}`).join('|');
    if (listaNotificacoesEl.dataset.assinatura === assinatura) return;
    listaNotificacoesEl.dataset.assinatura = assinatura;
    listaNotificacoesEl.replaceChildren(
      ...notificacoesAtuais.map((n) => {
        const li = document.createElement('li');
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.className = `item-notificacao${n.lida ? '' : ' nao-lida'}`;
        botao.dataset.notificacaoId = n.id;
        const texto = document.createElement('span');
        texto.className = 'item-notificacao-texto';
        texto.textContent = n.mensagem; // textContent: nunca interpreta HTML
        const hora = document.createElement('small');
        hora.textContent = tempoRelativo(n.dataCriacao);
        botao.append(texto, hora);
        li.appendChild(botao);
        return li;
      })
    );
  }

  // Busca as notificações no servidor (chamada a cada tique do polling). Depois da
  // primeira carga, mostra um toast para cada notificação NOVA.
  async function atualizarNotificacoes() {
    if (notificacoesEmCurso || !notificacoesEl) return;
    notificacoesEmCurso = true;
    try {
      const { naoLidas, notificacoes } = await API.notificacoes();
      if (!notificacoesPrimeiraCarga) {
        notificacoes
          .filter((n) => !n.lida && !notificacoesVistas.has(n.id))
          .forEach((n) => toast(n.mensagem, TOAST_POR_TIPO[n.tipo] || 'info'));
      }
      notificacoes.forEach((n) => notificacoesVistas.add(n.id));
      notificacoesPrimeiraCarga = false;
      notificacoesAtuais = notificacoes;
      desenharNotificacoes(naoLidas);
    } finally {
      notificacoesEmCurso = false;
    }
  }

  // Zera o estado das notificações (logout / sessão expirada) para a próxima pessoa
  // que entrar neste navegador não ver as da anterior.
  function reiniciarNotificacoes() {
    notificacoesAtuais = [];
    notificacoesVistas = new Set();
    notificacoesPrimeiraCarga = true;
    if (!notificacoesEl) return;
    fecharPainelNotificacoes();
    listaNotificacoesEl.replaceChildren();
    delete listaNotificacoesEl.dataset.assinatura;
    contadorNotificacoesEl.classList.add('oculto');
  }

  // Fecha o painel dropdown de notificações.
  function fecharPainelNotificacoes() {
    painelNotificacoesEl.classList.add('oculto');
    btnNotificacoes.setAttribute('aria-expanded', 'false');
  }

  if (btnNotificacoes) {
    btnNotificacoes.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!painelNotificacoesEl.classList.contains('oculto')) return fecharPainelNotificacoes();
      painelNotificacoesEl.classList.remove('oculto');
      btnNotificacoes.setAttribute('aria-expanded', 'true');
      atualizarNotificacoes().catch(() => {}); // abre já com o que existe e atualiza em seguida
    });
    document.addEventListener('click', (e) => {
      if (!notificacoesEl.contains(e.target)) fecharPainelNotificacoes();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') fecharPainelNotificacoes();
    });

    // Abrir uma notificação = marcá-la como lida (o servidor devolve o total certo).
    listaNotificacoesEl.addEventListener('click', async (e) => {
      const botao = e.target.closest('[data-notificacao-id]');
      if (!botao) return;
      const notificacao = notificacoesAtuais.find((n) => n.id === botao.dataset.notificacaoId);
      fecharPainelNotificacoes();
      if (!notificacao || notificacao.lida) return;
      try {
        await API.marcarNotificacaoLida(notificacao.id);
        await atualizarNotificacoes();
      } catch (err) {
        toast(err.message, 'erro');
      }
    });

    btnMarcarTodasLidas.addEventListener('click', async () => {
      try {
        await API.marcarTodasNotificacoesLidas();
        await atualizarNotificacoes();
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
  }

  // ---- Ordenação dos chamados disponíveis (prestador) ----
  // Feita pelo servidor, com a distância e as datas reais do banco.
  let ordenacaoChamados = 'proximos';
  const ordenarChamadosEl = document.getElementById('ordenar-chamados');
  if (ordenarChamadosEl) {
    ordenarChamadosEl.addEventListener('change', async () => {
      ordenacaoChamados = ordenarChamadosEl.value;
      try {
        // Só a lista é pedida de novo; a página não recarrega.
        if (!chamadoEmFoco) renderizarDisponiveis(await API.chamadosDisponiveis(ordenacaoChamados));
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
  }

  // ---- Notificações do cliente ----
  // Cada evento do chamado que tem "mensagem" é uma notificação para o cliente
  // (o servidor decide o texto). Aqui elas aparecem no toast que já existia.
  // O navegador lembra quantos eventos do chamado atual já foram mostrados
  // (localStorage), para: (1) não repetir avisos a cada atualização de 3 s ou
  // ao recarregar a página; (2) mostrar os que chegaram enquanto a página
  // esteve fechada; (3) não "reprisar" o passado quando o cliente entra pela
  // primeira vez neste navegador com um chamado já em andamento.
  const CHAVE_EVENTOS_VISTOS = 'sos-car-eventos-vistos';

  // Lê do localStorage quantos eventos do chamado o usuário já viu (null se não há registro).
  function lerEventosVistos(chamadoId) {
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE_EVENTOS_VISTOS) || 'null');
      return salvo && salvo.id === chamadoId && Number.isInteger(salvo.n) ? salvo.n : null;
    } catch {
      return null;
    }
  }
  // Guarda no localStorage quantos eventos do chamado já foram vistos.
  function gravarEventosVistos(chamadoId, quantidade) {
    try {
      localStorage.setItem(CHAVE_EVENTOS_VISTOS, JSON.stringify({ id: chamadoId, n: quantidade }));
    } catch {
      // Sem armazenamento: os avisos valem só enquanto a aba estiver aberta.
    }
  }
  // Sem localStorage, cai para a memória da aba.
  let eventosVistosMemoria = { id: null, n: 0 };

  // Compara os eventos do chamado com os já vistos e registra os novos. Os avisos em
  // si (toast e contador) vêm da Central de Notificações do servidor.
  function notificarNovosEventos(chamado) {
    const eventos = chamado.eventos || [];
    let vistos = lerEventosVistos(chamado.id);
    if (vistos === null && eventosVistosMemoria.id === chamado.id) vistos = eventosVistosMemoria.n;
    if (vistos !== null) {
      // Os avisos em si (toast + contador) vêm da Central de Notificações, que o
      // servidor alimenta com estes mesmos eventos; aqui não se avisa de novo,
      // para o cliente não receber a mesma mensagem duas vezes.
    }
    if (vistos !== eventos.length) {
      gravarEventosVistos(chamado.id, eventos.length);
      eventosVistosMemoria = { id: chamado.id, n: eventos.length };
    }
  }

  // Estado em destaque no topo do card do cliente. O texto muda na hora e, quando
  // o status muda de verdade (não na primeira exibição), ganha uma pequena transição.
  let statusBannerChave = null;
  // Atualiza o banner de status do acompanhamento (título e subtítulo conforme o
  // status do chamado) e anima só quando o status realmente mudou.
  function atualizarBannerStatus(chamado) {
    const estado = ESTADOS_ATENDIMENTO[chamado.status] || { titulo: rotuloStatus(chamado.status), sub: '' };
    let sub = estado.sub;
    if (chamado.status === 'concluido') {
      sub = chamado.avaliacao ? 'Obrigado pela avaliação.' : 'Avalie o atendimento abaixo.';
    } else if (chamado.status === 'cancelado') {
      const quem = { prestador: 'Cancelado pelo prestador.', admin: 'Cancelado pela administração.', cliente: 'Você cancelou este chamado.' }[chamado.canceladoPor];
      sub = [quem, chamado.motivoCancelamentoTexto ? `Motivo: ${chamado.motivoCancelamentoTexto}` : ''].filter(Boolean).join(' ');
    }
    statusTituloEl.textContent = estado.titulo;
    statusSubEl.textContent = sub;
    statusBannerEl.dataset.estado = chamado.status;
    const chave = `${chamado.id}:${chamado.status}`;
    if (statusBannerChave !== null && statusBannerChave !== chave) {
      statusBannerEl.classList.remove('status-troca');
      void statusBannerEl.offsetWidth; // reinicia a animação
      statusBannerEl.classList.add('status-troca');
    }
    statusBannerChave = chave;
  }

  // Busca o chamado atual (se houver) e o histórico, e redesenha a tela
  // do cliente de acordo. Chamada tanto na entrada do painel quanto a
  // cada "tick" do polling (setInterval acima).
  function renderizarMapaLocalizacaoCliente(latitude, longitude, titulo = 'Sua localização') {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
    Mapa.criarOuAtualizar('mapa-cliente', latitude, longitude, titulo, 'padrao');
    Mapa.removerPrestador('mapa-cliente');
  }

  // Atualiza o painel do cliente: busca o chamado atual e o histórico e mostra o
  // formulário de pedir socorro OU o acompanhamento. Roda na entrada do painel e a
  // cada tique do polling.
  async function atualizarPainelCliente() {
    const [atual, historico] = await Promise.all([API.chamadoAtual(), API.historico()]);
    chamadoEmFoco = atual;
    if (atual) notificarNovosEventos(atual);
    else statusBannerChave = null; // o próximo chamado não deve "animar" como se tivesse mudado de status

    // Mostra OU o formulário de pedir socorro, OU o acompanhamento do
    // chamado — nunca os dois ao mesmo tempo.
    semChamadoEl.classList.toggle('oculta', !!atual);
    comChamadoEl.classList.toggle('oculta', !atual);

    if (atual) {
      renderizarChamadoCliente(atual);
    } else if (navigator.geolocation && window.isSecureContext) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          renderizarMapaLocalizacaoCliente(pos.coords.latitude, pos.coords.longitude, 'Sua localização');
        },
        () => {
          renderizarMapaLocalizacaoCliente(LOCALIZACAO_RESERVA.latitude, LOCALIZACAO_RESERVA.longitude, 'Localização de demonstração');
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
      );
    } else {
      renderizarMapaLocalizacaoCliente(LOCALIZACAO_RESERVA.latitude, LOCALIZACAO_RESERVA.longitude, 'Localização de demonstração');
    }

    renderizarHistorico(clienteHistoricoEl, historico, (c) => c.categoriaNome);
  }

  // Desenha a "trilha" de progresso (Aberto -> Aceito -> A caminho ->
  // Concluído), os detalhes do chamado e decide se mostra o botão de
  // cancelar e/ou o formulário de avaliação.
  function renderizarChamadoCliente(chamado) {
    const passos = ['aberto', 'aceito', 'em_andamento', 'concluido'];
    const indiceAtual = passos.indexOf(chamado.status);

    [...progressoEl.children].forEach((li, i) => {
      li.classList.remove('concluido', 'atual', 'cancelado');
      if (chamado.status === 'cancelado') {
        li.classList.add('cancelado'); // troca a trilha inteira por um "x" (ver CSS)
        return;
      }
      if (i < indiceAtual) li.classList.add('concluido'); // etapas já passadas
      if (i === indiceAtual) li.classList.add('atual'); // etapa em que o chamado está agora
    });

    const notaPrestadorHtml =
      chamado.prestadorTotalAvaliacoes > 0
        ? ` · ★ ${chamado.prestadorNotaMedia.toFixed(1)} (${chamado.prestadorTotalAvaliacoes})`
        : '';
    atualizarBannerStatus(chamado);
    detalhesEl.innerHTML = `
      <dt>Status</dt><dd>${rotuloStatus(chamado.status)}</dd>
      <dt>Solicitado em</dt><dd>${formatarData(chamado.dataAbertura)}</dd>
      <dt>Categoria</dt><dd>${escaparHtml(chamado.categoriaNome) || '—'}</dd>
      <dt>Endereço</dt><dd>${escaparHtml(resumirEndereco(chamado.endereco))}</dd>
      <dt>Descrição</dt><dd>${escaparHtml(textoDescricao(chamado))}</dd>
      ${chamado.prestadorNome ? `<dt>Prestador</dt><dd>${escaparHtml(chamado.prestadorNome)} · ${escaparHtml(chamado.prestadorTelefone) || 'sem telefone'}${notaPrestadorHtml}</dd>` : ''}
    `;
    renderizarLinhaTempo(linhaTempoClienteEl, chamado);

    Mapa.criarOuAtualizar('mapa-cliente', chamado.latitude, chamado.longitude, 'Local do chamado', 'padrao');
    const prestadorAceito = ['aceito', 'em_andamento'].includes(chamado.status) && !!chamado.prestadorId;
    const prestadorTemLocalizacao =
      typeof chamado.prestadorLatitude === 'number' && typeof chamado.prestadorLongitude === 'number';

    if (prestadorAceito) {
      const categoriaPrestador = chamado.categoriaNome || 'Mecânico';
      const latitudePrestador = prestadorTemLocalizacao ? chamado.prestadorLatitude : chamado.latitude;
      const longitudePrestador = prestadorTemLocalizacao ? chamado.prestadorLongitude : chamado.longitude;

      Mapa.criarOuAtualizarPrestador(
        'mapa-cliente',
        latitudePrestador,
        longitudePrestador,
        `Prestador: ${escaparHtml(chamado.prestadorNome)}`,
        categoriaPrestador
      );

      if (prestadorTemLocalizacao) {
        Mapa.criarOuAtualizarRota(
          'mapa-cliente',
          [chamado.latitude, chamado.longitude],
          [chamado.prestadorLatitude, chamado.prestadorLongitude]
        );
      }
    } else {
      Mapa.removerPrestador('mapa-cliente');
    }

    // Cliente pode cancelar enquanto ninguém aceitou, ou dentro de 1
    // minuto após o aceite. Depois disso, o botão some.
    let podeCancelarCliente = false;
    if (chamado.status === 'aberto') {
      podeCancelarCliente = true;
    } else if (chamado.status === 'aceito' && chamado.dataAceite) {
      const diff = Date.now() - new Date(chamado.dataAceite).getTime();
      if (!Number.isNaN(diff) && diff <= 60 * 1000) podeCancelarCliente = true;
    }
    btnCancelarChamado.classList.toggle('oculto', !podeCancelarCliente);
    btnFecharCancelamento.classList.toggle('oculto', chamado.status !== 'cancelado');

    const avaliacaoObrigatoria = chamado.status === 'concluido' && !chamado.avaliacao;
    if (modalAvaliacao) {
      modalAvaliacao.classList.toggle('oculto', !avaliacaoObrigatoria);
      if (avaliacaoObrigatoria) {
        modalAvaliacao.setAttribute('aria-hidden', 'false');
      } else {
        modalAvaliacao.setAttribute('aria-hidden', 'true');
      }
    }
  }

  // =================================================================
  // Painel do prestador
  // =================================================================
  const prestadorNomeEl = document.getElementById('prestador-nome');
  const prestadorCategoriaEl = document.getElementById('prestador-categoria');
  const chkDisponivel = document.getElementById('chk-disponivel'); // interruptor de disponibilidade
  const disponivelTexto = document.getElementById('disponivel-texto');
  const prestadorLocalizacaoStatus = document.getElementById('prestador-localizacao-status');
  const prestadorSemChamadoEl = document.getElementById('prestador-sem-chamado'); // lista de chamados disponíveis
  const prestadorComChamadoEl = document.getElementById('prestador-com-chamado'); // atendimento em andamento
  const listaDisponiveisEl = document.getElementById('lista-disponiveis');
  const semChamadosMsg = document.getElementById('sem-chamados-msg');
  const semChamadosTexto = document.getElementById('sem-chamados-texto');
  const prestadorChamadoDetalhesEl = document.getElementById('prestador-chamado-detalhes');
  const btnIniciar = document.getElementById('btn-iniciar');
  const btnConcluir = document.getElementById('btn-concluir');
  const btnCancelarPrestador = document.getElementById('btn-cancelar-prestador');
  const btnVoltarPedidos = document.getElementById('btn-voltar-pedidos');
  const prestadorLinhaTempoEl = document.getElementById('prestador-linha-tempo');
  const prestadorAcaoErroEl = document.getElementById('prestador-acao-erro');
  const prestadorEstadoFinalEl = document.getElementById('prestador-estado-final');
  const modalAtendimentoTitulo = document.getElementById('modal-atendimento-titulo');
  // Modal de cancelamento (confirmação + motivo)
  const modalCancelarAtendimento = document.getElementById('modal-cancelar-atendimento');
  const modalCancelarErro = document.getElementById('modal-cancelar-erro');
  const modalCancelarVoltar = document.getElementById('modal-cancelar-voltar');
  const modalCancelarConfirmar = document.getElementById('modal-cancelar-confirmar');
  const motivoDetalheEl = document.getElementById('motivo-cancelamento-detalhe');
  const motivoRadios = [...document.querySelectorAll('input[name="motivo-cancelamento"]')];
  const prestadorHistoricoEl = document.getElementById('prestador-historico');
  const prestadorHistoricoCompletoEl = document.getElementById('prestador-historico-completo');
  const prestadorAvaliacaoResumoEl = document.getElementById('prestador-avaliacao-resumo');
  const prestadorListaAvaliacoesEl = document.getElementById('prestador-lista-avaliacoes');
  const btnAtualizarChamados = document.getElementById('btn-atualizar-chamados');
  const btnVerAvaliacoes = document.getElementById('btn-ver-avaliacoes');
  const btnVerHistorico = document.getElementById('btn-ver-historico');
  const modalAvaliacoes = document.getElementById('modal-avaliacoes');
  const modalHistorico = document.getElementById('modal-historico');
  const botoesFecharModal = document.querySelectorAll('.modal-fechar');

  // Atualiza texto e cor do badge "Disponível"/"Indisponível" juntos,
  // nos três pontos do código que precisam disso (entrada no painel e
  // troca do interruptor, inclusive quando a troca é desfeita por erro).
  function atualizarBadgeDisponivel(disponivel) {
    disponivelTexto.textContent = disponivel ? 'Disponível' : 'Indisponível';
    disponivelTexto.classList.toggle('status-badge-ativo', disponivel);
  }

  let localizacaoPrestador = null;
  let watchIdPrestador = null;
  let chamadosDisponiveisAtuais = [];
  // true enquanto uma ação (Cheguei / Concluir / Cancelar) está a caminho do
  // servidor: trava novos cliques e faz a atualização automática ignorar
  // respostas que podem ter ficado velhas.
  let acaoPrestadorEmCurso = false;
  // true depois de concluir/cancelar: o card fica na tela com o estado final
  // ("Atendimento concluído/cancelado") até o prestador voltar aos pedidos.
  let prestadorVendoFinal = false;

  // Chamada uma vez, logo após o login/cadastro como prestador.
  async function sincronizarPainelPrestador() {
    if (acaoPrestadorEmCurso) return;
    if (prestadorVendoFinal) return;

    if (chamadoEmFoco) {
      await sincronizarAtendimentoPrestador();
      return;
    }

    await atualizarPainelPrestador();
  }

  // Prepara o painel do prestador ao entrar: nome, categoria, interruptor de
  // disponibilidade, card do raio e as atualizações periódicas.
  function iniciarPainelPrestador(usuario) {
    prestadorNomeEl.textContent = usuario.nome;
    prestadorCategoriaEl.textContent = `Categoria: ${usuario.categoriaNome}`;
    chkDisponivel.checked = !!usuario.disponivel;
    atualizarBadgeDisponivel(!!usuario.disponivel);

    // Card informativo (componente reutilizável) com o raio atual; dispensável.
    CartaoInfo.montar(document.getElementById('prestador-cartao-info'), {
      id: 'raio-prestador',
      icone: 'pin',
      titulo: 'Chamados dentro do seu raio',
      descricao: `Você vê chamados a até ${formatarKm(usuario.raioKm || 15)} de você, do mais próximo ao mais distante.`,
      complemento: 'A distância é medida em linha reta, pela localização do aparelho.',
      acao: { rotulo: 'Ajustar raio', aoClicar: () => btnConfig && btnConfig.click() },
      dispensavel: true
    });

    mostrarTela('prestador');
    pararAtualizacaoAutomatica();
    obterLocalizacaoPrestador();
    atualizarPainelPrestador().catch((err) => toast(err.message, 'erro'));
    // Mantém a lista de pedidos e o atendimento ativo sincronizados em segundo plano,
    // sem exigir clique em "Atualizar" sempre que um cliente abrir um novo pedido.
    iniciarAtualizacaoAutomatica(sincronizarPainelPrestador, 4000);
  }

  // Pede a localização GPS do prestador assim que o painel abre, e já
  // manda para a API — é essa localização que alimenta o cálculo de
  // distância usado para filtrar/ordenar os chamados disponíveis.
  function obterLocalizacaoPrestador() {
    if (!navigator.geolocation) return;
    if (!window.isSecureContext) {
      prestadorLocalizacaoStatus.textContent =
        'O Chrome bloqueia a localização nesta rede sem HTTPS. Abra em localhost ou configure HTTPS no servidor.';
      return;
    }
    if (watchIdPrestador !== null) navigator.geolocation.clearWatch(watchIdPrestador);
    watchIdPrestador = navigator.geolocation.watchPosition(
      async (pos) => {
        localizacaoPrestador = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        prestadorLocalizacaoStatus.textContent = 'Localização atualizada.';
        try {
          await API.atualizarDisponibilidade({ ...localizacaoPrestador });
        } catch {
          // Falha silenciosa: a próxima posição tenta sincronizar novamente.
        }
      },
      () => {
        prestadorLocalizacaoStatus.textContent =
          'Não foi possível obter sua localização; o cliente não verá seu deslocamento.';
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
  }

  // Interruptor "Disponível" / "Indisponível": avisa a API a cada
  // mudança (junto com a última localização conhecida, se houver).
  chkDisponivel.addEventListener('change', async () => {
    atualizarBadgeDisponivel(chkDisponivel.checked);
    try {
      await API.atualizarDisponibilidade({ disponivel: chkDisponivel.checked, ...(localizacaoPrestador || {}) });
    } catch (err) {
      // Não salvou no servidor: desfaz o interruptor para a tela não
      // mostrar "Disponível" enquanto o servidor ainda diz "Indisponível".
      chkDisponivel.checked = !chkDisponivel.checked;
      atualizarBadgeDisponivel(chkDisponivel.checked);
      toast(err.message, 'erro');
      return;
    }
    // A lista permanece como está até o prestador pedir uma atualização.
  });

  // Importante: NÃO usar comCarregamento() aqui — ela troca
  // botao.textContent, o que apagaria o ícone SVG (o botão não tem texto,
  // só o ícone) e o destruiria permanentemente após o primeiro clique.
  // Em vez disso, só desabilita o botão e gira o ícone via CSS.
  btnAtualizarChamados.addEventListener('click', async () => {
    if (btnAtualizarChamados.disabled) return;
    btnAtualizarChamados.disabled = true;
    btnAtualizarChamados.classList.add('carregando');
    try {
      await atualizarPainelPrestador();
      toast('Pedidos atualizados.', 'sucesso');
    } catch (err) {
      toast(err.message, 'erro');
    } finally {
      btnAtualizarChamados.disabled = false;
      btnAtualizarChamados.classList.remove('carregando');
    }
  });

  // Delegação de evento: em vez de um listener por botão do pedido (que
  // teria que ser recriado toda vez que a lista é redesenhada), ouvimos
  // o clique no <ul> inteiro e conferimos se o alvo tem o atributo
  // "data-visualizar-pedido" (ver renderizarDisponiveis, mais abaixo).
  listaDisponiveisEl.addEventListener('click', async (e) => {
    const botao = e.target.closest('[data-visualizar-pedido]');
    if (!botao) return;
    botao.disabled = true; // evita duplo clique enquanto o pedido está em voo
    try {
      const selecionado = chamadosDisponiveisAtuais.find((item) => item.id === botao.dataset.visualizarPedido);
      if (!selecionado) return;
      // Conta nova (ex.: Google) sem CPF/telefone: popup obrigatório antes de aceitar o 1º chamado.
      if (!(await garantirPerfilCompleto())) return;
      if (!(await confirmarChamado(selecionado))) return;
      await API.aceitarChamado(selecionado.id);
    } catch (err) {
      if (tratarPerfilIncompleto(err)) return;
      // Erro mais comum aqui: outro prestador aceitou primeiro (409) —
      // a mensagem já vem pronta da API.
      toast(err.message, 'erro');
    } finally {
      botao.disabled = false;
    }
    await atualizarPainelPrestador().catch(() => {}); // atualiza a lista de qualquer forma (com ou sem sucesso)
  });

  // ---- Ações do atendimento (Cheguei ao local / Concluir / Cancelar) ----
  function mostrarErroAcaoPrestador(mensagem) {
    prestadorAcaoErroEl.textContent = mensagem || '';
    prestadorAcaoErroEl.classList.toggle('oculto', !mensagem);
  }

  // Executa UMA ação do prestador com todas as proteções:
  //  - ignora cliques enquanto outra ação está em andamento (duplo clique);
  //  - desabilita os três botões e troca o texto do clicado (estado de carregamento);
  //  - só devolve a resposta se o servidor confirmou — a tela nunca mostra um
  //    status que o banco ainda não tem;
  //  - se falhar, mostra a mensagem no próprio modal; em 404/409 (o chamado mudou
  //    no servidor, ex.: o cliente cancelou) alinha a tela com o servidor.
  async function executarAcaoPrestador(botao, textoCarregando, acao) {
    if (acaoPrestadorEmCurso || !chamadoEmFoco) return null;
    acaoPrestadorEmCurso = true;
    mostrarErroAcaoPrestador('');
    const botoes = [btnIniciar, btnConcluir, btnCancelarPrestador];
    botoes.forEach((b) => (b.disabled = true));
    const textoOriginal = botao.textContent;
    botao.textContent = textoCarregando;
    let resposta = null;
    let erro = null;
    try {
      resposta = await acao(chamadoEmFoco.id);
    } catch (err) {
      erro = err;
    } finally {
      botao.textContent = textoOriginal;
      botoes.forEach((b) => (b.disabled = false));
      acaoPrestadorEmCurso = false;
    }
    if (erro) {
      mostrarErroAcaoPrestador(mensagemErroAcao(erro));
      if (erro.status === 404 || erro.status === 409) sincronizarAtendimentoPrestador().catch(() => {});
      return null;
    }
    return resposta;
  }

  // Aplica na tela o chamado confirmado pelo servidor. Em estado final
  // (concluído/cancelado) o card permanece, com o rótulo do estado, e o
  // histórico/avaliações são atualizados por trás.
  function aplicarChamadoPrestador(chamado) {
    chamadoEmFoco = chamado;
    prestadorVendoFinal = ['concluido', 'cancelado'].includes(chamado.status);
    prestadorComChamadoEl.classList.remove('oculto');
    renderizarChamadoPrestador(chamado);
    if (prestadorVendoFinal) atualizarHistoricoPrestador().catch(() => {});
  }

  btnIniciar.addEventListener('click', async () => {
    const chamado = await executarAcaoPrestador(btnIniciar, 'Registrando chegada...', (id) => API.iniciarAtendimento(id));
    if (chamado) aplicarChamadoPrestador(chamado);
  });

  btnConcluir.addEventListener('click', async () => {
    const chamado = await executarAcaoPrestador(btnConcluir, 'Concluindo...', (id) => API.concluirAtendimento(id));
    if (chamado) aplicarChamadoPrestador(chamado);
  });

  btnVoltarPedidos.addEventListener('click', async () => {
    prestadorVendoFinal = false;
    try {
      await atualizarPainelPrestador();
    } catch (err) {
      toast(mensagemErroAcao(err), 'erro');
    }
  });

  // "Cancelar atendimento" nunca cancela direto: abre a confirmação com o
  // motivo. Só "Confirmar cancelamento" chama a API.
  btnCancelarPrestador.addEventListener('click', () => {
    if (acaoPrestadorEmCurso || !chamadoEmFoco) return;
    motivoRadios.forEach((r) => (r.checked = false));
    motivoDetalheEl.value = '';
    motivoDetalheEl.classList.add('oculto');
    modalCancelarErro.classList.add('oculto');
    modalCancelarAtendimento.classList.remove('oculto');
  });

  // Fecha o modal de cancelamento do atendimento (com animação).
  function fecharModalCancelamento() {
    return Anim.sair(modalCancelarAtendimento, 'saindo', 160).then(() => modalCancelarAtendimento.classList.add('oculto'));
  }
  // Mostra uma mensagem de erro dentro do modal de cancelamento.
  function mostrarErroModalCancelamento(mensagem) {
    modalCancelarErro.textContent = mensagem;
    modalCancelarErro.classList.remove('oculto');
  }

  modalCancelarVoltar.addEventListener('click', () => {
    if (acaoPrestadorEmCurso) return; // não fecha no meio do envio
    fecharModalCancelamento();
  });

  // "Outro" pede uma descrição.
  motivoRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const outro = motivoRadios.some((r) => r.checked && r.value === 'outro');
      motivoDetalheEl.classList.toggle('oculto', !outro);
      modalCancelarErro.classList.add('oculto');
      if (outro) motivoDetalheEl.focus();
    });
  });

  modalCancelarConfirmar.addEventListener('click', async () => {
    if (acaoPrestadorEmCurso || !chamadoEmFoco) return;
    const motivo = motivoRadios.find((r) => r.checked)?.value;
    const detalhe = motivoDetalheEl.value.trim();
    if (!motivo) return mostrarErroModalCancelamento('Selecione o motivo do cancelamento.');
    if (motivo === 'outro' && detalhe.length < 3) return mostrarErroModalCancelamento('Descreva o motivo do cancelamento.');

    acaoPrestadorEmCurso = true;
    modalCancelarErro.classList.add('oculto');
    modalCancelarConfirmar.disabled = modalCancelarVoltar.disabled = true;
    const textoOriginal = modalCancelarConfirmar.textContent;
    modalCancelarConfirmar.textContent = 'Cancelando...';
    let chamado = null;
    let erro = null;
    try {
      chamado = await API.cancelarPorPrestador(chamadoEmFoco.id, motivo === 'outro' ? { motivo, detalhe } : { motivo });
    } catch (err) {
      erro = err;
    } finally {
      modalCancelarConfirmar.textContent = textoOriginal;
      modalCancelarConfirmar.disabled = modalCancelarVoltar.disabled = false;
      acaoPrestadorEmCurso = false;
    }

    if (!erro) {
      await fecharModalCancelamento();
      aplicarChamadoPrestador(chamado);
    } else if (erro.status === 404 || erro.status === 409) {
      // O chamado mudou no servidor (ex.: o cliente já cancelou): fecha a
      // confirmação, explica e alinha a tela com o servidor.
      await fecharModalCancelamento();
      mostrarErroAcaoPrestador(mensagemErroAcao(erro));
      sincronizarAtendimentoPrestador().catch(() => {});
    } else {
      // Falha passageira (conexão, 5xx) ou dados inválidos: mantém a
      // confirmação aberta para o prestador tentar de novo.
      mostrarErroModalCancelamento(mensagemErroAcao(erro));
    }
  });

  // Atualização automática do prestador (a cada 4 s, só com atendimento ativo).
  async function sincronizarAtendimentoPrestador() {
    if (acaoPrestadorEmCurso || prestadorVendoFinal || !chamadoEmFoco) return;
    const atual = await API.chamadoAtual();
    // Uma ação pode ter começado enquanto a consulta viajava: a resposta pode estar velha.
    if (acaoPrestadorEmCurso || prestadorVendoFinal) return;
    if (!atual) {
      // O chamado deixou de estar ativo sem uma ação do prestador (o cliente ou
      // a administração cancelou). Volta para a lista de pedidos.
      toast('Este atendimento foi encerrado e não está mais ativo.', 'erro');
      await atualizarPainelPrestador();
      return;
    }
    if (atual.id !== chamadoEmFoco.id || atual.status !== chamadoEmFoco.status) {
      chamadoEmFoco = atual;
      renderizarChamadoPrestador(atual);
    }
  }

  // Busca o chamado ativo do prestador (se houver) e redesenha a tela:
  // OU a lista de chamados disponíveis, OU o card de atendimento em
  // andamento — mais o histórico, que aparece sempre.
  async function atualizarPainelPrestador() {
    const atual = await API.chamadoAtual();
    chamadoEmFoco = atual;

    prestadorSemChamadoEl.classList.toggle('oculta', !!atual);
    // O card do atendimento é um modal que nasce com a classe "oculto" (não
    // "oculta"): alternar só "oculta" o deixava escondido para sempre, e os
    // botões do atendimento nunca apareciam.
    prestadorComChamadoEl.classList.toggle('oculto', !atual);

    if (atual) {
      prestadorVendoFinal = false;
      // A lista de pedidos não deve continuar aparecendo (com o chamado que
      // acabou de ser aceito) por trás do card do atendimento.
      chamadosDisponiveisAtuais = [];
      listaDisponiveisEl.classList.add('oculta');
      renderizarChamadoPrestador(atual);
    } else {
      mostrarErroAcaoPrestador('');
      renderizarDisponiveis(await API.chamadosDisponiveis(ordenacaoChamados));
    }

    await atualizarHistoricoPrestador();
  }

  // Histórico + avaliações do painel (também usado depois de concluir/cancelar,
  // enquanto o card do atendimento ainda está na tela).
  async function atualizarHistoricoPrestador() {
    renderizarHistorico(prestadorHistoricoEl, await API.historico(), (c) => c.clienteNome);
    await atualizarAvaliacoesPrestador();
  }

  // Abre um modal (remove a classe que o esconde).
  function abrirModal(modal) {
    if (!modal) return;
    modal.classList.remove('oculto');
  }

  // Fecha um modal (adiciona a classe que o esconde).
  function fecharModal(modal) {
    if (!modal) return;
    modal.classList.add('oculto');
  }

  // Preenche o card "Minhas avaliações": nota média + total no topo, e
  // a lista de comentários recebidos logo abaixo (mais recente primeiro).
  async function atualizarAvaliacoesPrestador() {
    const { media, total, avaliacoes } = await API.minhasAvaliacoes();

    prestadorAvaliacaoResumoEl.innerHTML =
      total > 0
        ? `<strong>★ ${media.toFixed(1)}</strong><span class="texto-auxiliar">de 5 · ${total} avaliaç${total === 1 ? 'ão' : 'ões'}</span>`
        : '<span class="texto-auxiliar">Você ainda não recebeu nenhuma avaliação.</span>';

    prestadorListaAvaliacoesEl.innerHTML = avaliacoes.length
      ? avaliacoes
          .map(
            (a) => `
          <li class="item-historico">
            <div>
              <strong>${'★'.repeat(a.nota)}${'☆'.repeat(5 - a.nota)}</strong>
              <div class="texto-auxiliar">${escaparHtml(a.clienteNome)} · ${formatarData(a.data)}</div>
              <div class="texto-auxiliar avaliacao-comentario">${escaparHtml(a.comentario) || 'Sem comentário'}</div>
            </div>
          </li>`
          )
          .join('')
      : '<li class="estado-vazio">Ainda não há avaliações para mostrar.</li>';
  }

  btnVerAvaliacoes.addEventListener('click', async () => {
    try {
      await atualizarAvaliacoesPrestador();
      abrirModal(modalAvaliacoes);
    } catch (err) {
      toast(err.message || 'Não foi possível carregar as avaliações.', 'erro');
    }
  });

  btnVerHistorico.addEventListener('click', async () => {
    try {
      const historico = await API.historico();
      renderizarHistorico(prestadorHistoricoCompletoEl, historico, (c) => c.clienteNome);
      abrirModal(modalHistorico);
    } catch (err) {
      toast(err.message || 'Não foi possível carregar o histórico.', 'erro');
    }
  });

  botoesFecharModal.forEach((botao) => {
    botao.addEventListener('click', () => {
      const modal = botao.closest('.modal');
      fecharModal(modal);
    });
  });

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) fecharModal(modal);
    });
  });

  // Desenha a lista de chamados disponíveis para aceitar. Cada item
  // carrega o id do chamado no atributo "data-aceitar" do botão, lido
  // pelo listener de delegação configurado acima.
  function renderizarDisponiveis(lista) {
    // A ordem vem do servidor (?ordenar=); não reordenar aqui.
    const listaOrdenada = [...lista];
    chamadosDisponiveisAtuais = listaOrdenada;
    const temChamados = listaOrdenada.length > 0;
    semChamadosMsg.classList.toggle('oculto', temChamados);
    prestadorSemChamadoEl.classList.toggle('oculta', temChamados);
    listaDisponiveisEl.classList.toggle('oculta', !temChamados);
    // Com o interruptor desligado o servidor não devolve chamados; sem esta
    // explicação, "Nenhum chamado disponível" pareceria falta de demanda.
    semChamadosTexto.textContent = !chkDisponivel.checked
      ? 'Você está indisponível. Ative a opção "Disponível" para receber chamados.'
      : !localizacaoPrestador
        ? 'Permita a localização do aparelho para ver os chamados dentro do seu raio de atendimento.'
        : 'Nenhum chamado dentro do seu raio no momento.';

    listaDisponiveisEl.innerHTML = listaOrdenada
      .map((c) => {
        const enderecoFormatado = resumirEndereco(c.endereco);
        const descricaoFormatada = textoDescricao(c);
        const localizacaoCliente =
          typeof c.latitude === 'number' && typeof c.longitude === 'number'
            ? `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`
            : 'Localização não disponível';
        // Só mostra distância real (calculada com coordenadas pelo servidor); nunca inventa valor.
        const distanciaTexto = c.distanciaKm != null ? `📍 ${formatarKm(c.distanciaKm)} de distância` : 'Distância não disponível';
        const tempoTexto = c.distanciaKm != null ? tempoMedioChegada(c.distanciaKm) : 'Tempo não disponível';

        return `
      <li class="item-chamado">
        <div class="item-chamado-info">
          <strong>${escaparHtml(enderecoFormatado) || 'Endereço não informado'}</strong>
          <div class="item-chamado-categoria">${escaparHtml(c.categoriaNome) || 'Categoria'}</div>
          <div class="item-chamado-descricao">${escaparHtml(descricaoFormatada) || 'Sem descrição'}</div>
          <div class="item-chamado-meta">
            <span>${escaparHtml(distanciaTexto)}</span>
            <span>•</span>
            <span>${escaparHtml(tempoTexto)}</span>
            <span>•</span>
            <span>Cliente: ${escaparHtml(localizacaoCliente)}</span>
          </div>
        </div>
        <button class="botao-primario" data-visualizar-pedido="${c.id}">Visualizar pedido</button>
      </li>`;
      })
      .join('');
  }

  // Desenha o card do chamado que o prestador já aceitou, com os dados
  // de contato do cliente (só aparecem aqui, depois do aceite — ver
  // comentário sobre privacidade em server.js) e os botões de ação
  // certos para a etapa atual.
  // Título do modal e texto do "Status" para o prestador, por status.
  const TITULOS_ATENDIMENTO_PRESTADOR = {
    aceito: 'A caminho',
    em_andamento: 'Atendimento em andamento',
    concluido: 'Atendimento concluído',
    cancelado: 'Atendimento cancelado'
  };
  let prestadorStatusChave = null;

  // Mostra o atendimento em andamento do prestador: título conforme o status, dados
  // do cliente, mapa com a rota e os botões das ações permitidas naquele status.
  function renderizarChamadoPrestador(chamado) {
    const titulo = TITULOS_ATENDIMENTO_PRESTADOR[chamado.status] || 'Atendimento';
    const chave = `${chamado.id}:${chamado.status}`;
    modalAtendimentoTitulo.textContent = titulo;
    if (prestadorStatusChave !== null && prestadorStatusChave !== chave) {
      modalAtendimentoTitulo.classList.remove('status-troca');
      void modalAtendimentoTitulo.offsetWidth; // reinicia a animação
      modalAtendimentoTitulo.classList.add('status-troca');
    }
    prestadorStatusChave = chave;

    prestadorChamadoDetalhesEl.innerHTML = `
      <dt>Cliente</dt><dd>${escaparHtml(chamado.clienteNome)}</dd>
      <dt>Endereço</dt><dd>${escaparHtml(resumirEndereco(chamado.endereco))}</dd>
      <dt>Número do cliente</dt><dd>${escaparHtml(chamado.clienteTelefone) || 'sem telefone'}</dd>
      <dt>Status</dt><dd>${escaparHtml(titulo)}</dd>
    `;
    renderizarLinhaTempo(prestadorLinhaTempoEl, chamado);
    Mapa.criarOuAtualizar('mapa-prestador', chamado.latitude, chamado.longitude, escaparHtml(chamado.clienteNome), chamado.categoriaNome || 'Mecânico');
    if (
      typeof localizacaoPrestador?.latitude === 'number' &&
      typeof localizacaoPrestador?.longitude === 'number'
    ) {
      Mapa.criarOuAtualizarPrestador(
        'mapa-prestador',
        localizacaoPrestador.latitude,
        localizacaoPrestador.longitude,
        'Sua localização',
        chamado.categoriaNome || 'Mecânico'
      );
      Mapa.criarOuAtualizarRota(
        'mapa-prestador',
        [chamado.latitude, chamado.longitude],
        [localizacaoPrestador.latitude, localizacaoPrestador.longitude]
      );
    } else {
      Mapa.removerPrestador('mapa-prestador');
    }
    // Só os botões do estado atual: a caminho -> Cheguei/Cancelar; no local ->
    // Concluir/Cancelar; estado final -> só o rótulo (e "Voltar aos pedidos").
    const final = chamado.status === 'concluido' || chamado.status === 'cancelado';
    btnIniciar.classList.toggle('oculto', chamado.status !== 'aceito');
    btnConcluir.classList.toggle('oculto', chamado.status !== 'em_andamento');
    btnCancelarPrestador.classList.toggle('oculto', !['aceito', 'em_andamento'].includes(chamado.status));
    prestadorEstadoFinalEl.classList.toggle('oculto', !final);
    prestadorEstadoFinalEl.classList.toggle('estado-final-cancelado', chamado.status === 'cancelado');
    prestadorEstadoFinalEl.textContent = chamado.status === 'cancelado' ? '✕ Atendimento cancelado' : '✓ Atendimento concluído';
    btnVoltarPedidos.classList.toggle('oculto', !final);
  }

  // ---------------- Histórico (compartilhado entre os dois painéis) ----------------
  // "obterTitulo" é uma função passada por quem chama: no painel do
  // cliente mostra a categoria do chamado, no painel do prestador mostra
  // o nome do cliente atendido — o resto do card é igual nos dois casos.
  function renderizarHistorico(elemento, lista, obterTitulo) {
    const listaOrdenada = [...lista].sort((a, b) => new Date(b.dataAbertura || 0) - new Date(a.dataAbertura || 0));

    elemento.innerHTML = listaOrdenada.length
      ? listaOrdenada
          .map(
            (c) => `
        <li class="item-historico">
          <div>
            <strong>${escaparHtml(obterTitulo(c))}</strong>
            <div class="texto-auxiliar">${escaparHtml(resumirEndereco(c.endereco))} · ${formatarData(c.dataAbertura)}${escaparHtml(textoCancelamento(c))}</div>
          </div>
          <span class="selo ${c.status === 'cancelado' ? 'selo-cancelado' : 'selo-concluido'}">${rotuloStatus(c.status)}</span>
        </li>`
          )
          .join('')
      : `<li class="estado-vazio">
          <svg class="estado-vazio-icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v6l-3 3H7l-3-3V4z"/><path d="M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9"/></svg>
          Nada por aqui ainda.
        </li>`;
  }

  // =================================================================
  // Painel administrativo
  // Sem cadastro público — só a conta fixa definida no servidor (ver
  // ADMIN_EMAIL/ADMIN_SENHA em server/server.js). O acesso é feito pelo
  // link discreto "Acesso administrativo" no rodapé (ver seção de links
  // do rodapé, mais acima).
  // =================================================================
  const formAdminLogin = document.getElementById('form-admin-login');
  const adminLoginErro = document.getElementById('admin-login-erro');
  const adminLoginEl = document.getElementById('admin-login');
  const adminPainelEl = document.getElementById('admin-painel');
  const statClientes = document.getElementById('stat-clientes');
  const statPrestadores = document.getElementById('stat-prestadores');
  const statChamados = document.getElementById('stat-chamados');
  const statChamadosAbertos = document.getElementById('stat-chamados-abertos');
  const adminListaCategorias = document.getElementById('admin-lista-categorias');
  const adminFiltroStatus = document.getElementById('admin-filtro-status');
  const adminTabelaChamados = document.querySelector('#admin-tabela-chamados tbody');
  const adminTabelaUsuarios = document.querySelector('#admin-tabela-usuarios tbody');

  if (formAdminLogin) {
    formAdminLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      adminLoginErro.classList.add('oculto');
      const dados = Object.fromEntries(new FormData(formAdminLogin));
      await comCarregamento(formAdminLogin.querySelector('button[type="submit"]'), 'Entrando...', async () => {
        try {
          const { token, usuario } = await API.loginAdmin(dados);
          API.definirToken(token);
          formAdminLogin.reset();
          usuarioTipoAtual = 'admin';
          ultimoUsuario = usuario;
          iniciarPainelAdmin();
        } catch (err) {
          adminLoginErro.textContent = err.message;
          adminLoginErro.classList.remove('oculto');
        }
      });
    });
  }

  // Chamada uma vez, logo após o login como admin.
  function iniciarPainelAdmin() {
    adminLoginEl.classList.add('oculta');
    adminPainelEl.classList.remove('oculta');
    mostrarTela('admin');
    pararAtualizacaoAutomatica();
    iniciarAtualizacaoAutomatica(atualizarPainelAdmin, 8000);
  }

  // Atualiza o painel do administrador: estatísticas, categorias e usuários.
  async function atualizarPainelAdmin() {
    const [estatisticas, categorias, usuarios] = await Promise.all([
      API.adminEstatisticas(),
      API.adminCategorias(),
      API.adminUsuarios()
    ]);

    statClientes.textContent = estatisticas.totalClientes;
    statPrestadores.textContent = estatisticas.totalPrestadores;
    statChamados.textContent = estatisticas.totalChamados;
    statChamadosAbertos.textContent = ['aberto', 'aceito', 'em_andamento'].reduce(
      (soma, status) => soma + (estatisticas.chamadosPorStatus[status] || 0),
      0
    );

    // Não redesenha a lista enquanto o admin está digitando um novo nome —
    // a cada 8 s isso apagaria o que ele acabou de escrever.
    if (!adminListaCategorias.querySelector('.categoria-input')) renderizarCategoriasAdmin(categorias);
    renderizarUsuariosAdmin(usuarios);
    await renderizarChamadosAdmin();
  }

  // Lista as categorias no painel admin, cada uma com o botão "Renomear".
  function renderizarCategoriasAdmin(categorias) {
    adminListaCategorias.innerHTML = categorias
      .map(
        (c) => `
      <li class="item-categoria" data-categoria="${c.id}">
        <span class="categoria-nome">${escaparHtml(c.nome)}</span>
        <button type="button" class="botao-secundario botao-pequeno" data-editar-categoria="${c.id}">Renomear</button>
      </li>`
      )
      .join('');
  }

  // Um único listener de delegação cobre os três estados do "renomear
  // categoria" (clicar em Renomear -> vira input; Salvar; Cancelar) —
  // um miniformulário inline no lugar de usar prompt() nativo, para
  // manter a mesma linha visual do resto do produto.
  if (adminListaCategorias) {
    adminListaCategorias.addEventListener('click', async (e) => {
      const btnEditar = e.target.closest('[data-editar-categoria]');
      if (btnEditar) {
        const item = btnEditar.closest('.item-categoria');
        const nomeAtual = item.querySelector('.categoria-nome').textContent;
        item.innerHTML = `
          <input type="text" class="categoria-input" value="${escaparHtml(nomeAtual)}" />
          <div class="acoes">
            <button type="button" class="botao-primario botao-pequeno" data-salvar-categoria="${btnEditar.dataset.editarCategoria}">Salvar</button>
            <button type="button" class="botao-secundario botao-pequeno" data-cancelar-categoria>Cancelar</button>
          </div>`;
        item.querySelector('.categoria-input').focus();
        return;
      }

      if (e.target.closest('[data-cancelar-categoria]')) {
        renderizarCategoriasAdmin(await API.adminCategorias());
        return;
      }

      const btnSalvar = e.target.closest('[data-salvar-categoria]');
      if (btnSalvar) {
        const item = btnSalvar.closest('.item-categoria');
        const novoNome = item.querySelector('.categoria-input').value.trim();
        if (novoNome) {
          try {
            await API.adminRenomearCategoria(btnSalvar.dataset.salvarCategoria, novoNome);
            await carregarCategorias(); // atualiza também os <select> de cadastro/chamado
            toast('Categoria renomeada.', 'sucesso');
          } catch (err) {
            toast(err.message, 'erro');
          }
        }
        renderizarCategoriasAdmin(await API.adminCategorias());
      }
    });
  }

  // Tabela de usuários do painel admin (clientes e prestadores), com status e o
  // botão "Aprovar" para prestadores pendentes. Todo texto passa por escaparHtml.
  function renderizarUsuariosAdmin({ clientes, prestadores }) {
    const linhas = [
      ...clientes.map((c) => ({ ...c, tipo: 'Cliente' })),
      ...prestadores.map((p) => ({ ...p, tipo: 'Prestador' }))
    ];
    adminTabelaUsuarios.innerHTML = linhas.length
      ? linhas
          .map((u) => {
            const statusTexto = u.tipo === 'Prestador'
              ? (u.aprovado === true ? 'Aprovado' : 'Pendente')
              : 'Ativo';
            // Conta criada pelo Google ainda sem CPF/telefone: o admin enxerga na tabela.
            const perfilIncompleto = Array.isArray(u.pendencias) && u.pendencias.length > 0;
            const botaoAprovar = u.tipo === 'Prestador' && u.aprovado !== true
              ? `<button type="button" class="botao-primario botao-pequeno" data-aprovar-prestador="${u.id}">Aprovar</button>`
              : '';

            return `
        <tr>
          <td>${escaparHtml(u.nome)}</td>
          <td>${escaparHtml(u.email)}</td>
          <td>${u.tipo}</td>
          <td>${escaparHtml(u.categoriaNome) || '—'}</td>
          <td>${statusTexto}${perfilIncompleto ? ' <span class="texto-auxiliar">(sem CPF/telefone)</span>' : ''}</td>
          <td>${botaoAprovar}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="texto-auxiliar">Nenhum usuário cadastrado.</td></tr>';
  }

  if (adminTabelaUsuarios) {
    adminTabelaUsuarios.addEventListener('click', async (e) => {
      const botao = e.target.closest('[data-aprovar-prestador]');
      if (!botao) return;
      const id = botao.dataset.aprovarPrestador;
      try {
        try {
          await API.adminAprovarPrestador(id);
        } catch (err) {
          // Prestador criado pelo Google, sem CPF/telefone: o servidor pede
          // confirmação explícita do admin antes de aprovar.
          if (err.codigo !== 'PERFIL_INCOMPLETO') throw err;
          const aprovar = await confirmar(
            'Este prestador entrou pelo Google e ainda não informou CPF e/ou telefone. Aprovar mesmo assim?'
          );
          if (!aprovar) return;
          await API.adminAprovarPrestador(id, { confirmarSemPerfil: true });
        }
        await atualizarPainelAdmin();
        toast('Prestador aprovado com sucesso.', 'sucesso');
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
  }

  // Tabela de chamados do painel admin, com filtro por status e botão de cancelar
  // para os que ainda estão em andamento.
  async function renderizarChamadosAdmin() {
    const lista = await API.adminChamados(adminFiltroStatus.value);
    adminTabelaChamados.innerHTML = lista.length
      ? lista
          .map((c) => {
            const podeCancelar = ['aberto', 'aceito', 'em_andamento'].includes(c.status);
            return `
        <tr>
          <td>${escaparHtml(c.clienteNome)}</td>
          <td>${escaparHtml(c.prestadorNome) || '—'}</td>
          <td>${escaparHtml(c.categoriaNome)}</td>
          <td><span class="selo ${c.status === 'cancelado' ? 'selo-cancelado' : c.status === 'concluido' ? 'selo-concluido' : ''}">${rotuloStatus(c.status)}</span></td>
          <td>${formatarData(c.dataAbertura)}</td>
          <td>${podeCancelar ? `<button type="button" class="botao-perigo botao-pequeno" data-admin-cancelar="${c.id}">Cancelar</button>` : ''}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="texto-auxiliar">Nenhum chamado encontrado.</td></tr>';
  }

  if (adminFiltroStatus) {
    adminFiltroStatus.addEventListener('change', renderizarChamadosAdmin);
  }

  if (adminTabelaChamados) {
    adminTabelaChamados.addEventListener('click', async (e) => {
      const botao = e.target.closest('[data-admin-cancelar]');
      if (!botao) return;
      if (!(await confirmar('Cancelar este chamado por moderação?'))) return;
      try {
        await API.adminCancelarChamado(botao.dataset.adminCancelar);
        toast('Chamado cancelado.', 'sucesso');
        await atualizarPainelAdmin();
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
  }

  iniciar(); // ponto de entrada: roda assim que este script é carregado
})();
