// =================================================================
// Card informativo — componente reutilizável.
//
// Mostra uma informação importante de forma discreta, sem tirar o usuário do
// que está fazendo (não é modal, não cobre a tela). Usa só as variáveis de cor
// e de borda do tema (ver .cartao-info em css/style.css), então acompanha o
// tema claro/escuro sozinho.
//
// Uso:
//   CartaoInfo.montar(elementoContainer, {
//     id: 'raio-prestador',            // identifica o card (para lembrar que foi fechado)
//     titulo: 'Chamados dentro do seu raio',
//     descricao: 'Você recebe chamados a até 15 km de você.',
//     complemento: 'Altere em Configurações.',   // opcional, texto menor
//     icone: 'info' | 'pin' | 'alerta',           // padrão: 'info'
//     tipo: 'info' | 'aviso',                     // padrão: 'info' (muda só a cor do destaque)
//     acao: { rotulo: 'Ajustar raio', aoClicar: () => {} },  // opcional
//     dispensavel: true,               // mostra o "×" e o botão de fechar
//     rotuloFechar: 'Entendi',         // texto do botão de fechar (padrão: 'Entendi')
//     aoFechar: () => {}               // opcional
//   });
//
// Um card dispensável que o usuário fechou fica fechado neste navegador
// (localStorage); montar() devolve null e não desenha nada nas próximas vezes.
// Todo texto entra com textContent — nenhum HTML vindo de fora é interpretado.
// =================================================================
const CartaoInfo = (function () {
  const CHAVE = 'sos-car-cartoes-dispensados';

  const ICONES = {
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    alerta: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
  };

  function lerDispensados() {
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE) || '{}');
      return salvo && typeof salvo === 'object' ? salvo : {};
    } catch {
      return {};
    }
  }

  // Sem localStorage (modo privado etc.) o card só não "lembra" o fechamento.
  const dispensadosNaSessao = new Set();

  function foiDispensado(id) {
    return dispensadosNaSessao.has(id) || lerDispensados()[id] === true;
  }

  function dispensar(id) {
    dispensadosNaSessao.add(id);
    try {
      const todos = lerDispensados();
      todos[id] = true;
      localStorage.setItem(CHAVE, JSON.stringify(todos));
    } catch {
      // Sem armazenamento: vale só enquanto a aba estiver aberta.
    }
  }

  function criarIcone(nome) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONES[nome] || ICONES.info; // constante interna, nunca texto do usuário
    return svg;
  }

  function texto(tag, classe, conteudo) {
    const el = document.createElement(tag);
    el.className = classe;
    el.textContent = conteudo;
    return el;
  }

  // Monta o elemento do card (sem inseri-lo na página).
  function criar(opcoes) {
    const { id, titulo, descricao, complemento, icone = 'info', tipo = 'info', acao, dispensavel = false, rotuloFechar = 'Entendi', aoFechar } = opcoes;

    const card = document.createElement('div');
    card.className = `cartao-info cartao-info-${tipo === 'aviso' ? 'aviso' : 'info'}`;
    card.setAttribute('role', 'status');
    if (id) card.dataset.cartaoId = id;

    const iconeEl = document.createElement('span');
    iconeEl.className = 'cartao-info-icone';
    iconeEl.appendChild(criarIcone(icone));
    card.appendChild(iconeEl);

    const corpo = document.createElement('div');
    corpo.className = 'cartao-info-corpo';
    if (titulo) corpo.appendChild(texto('strong', 'cartao-info-titulo', titulo));
    if (descricao) corpo.appendChild(texto('p', 'cartao-info-descricao', descricao));
    if (complemento) corpo.appendChild(texto('small', 'cartao-info-complemento', complemento));

    const temAcoes = (acao && acao.rotulo) || dispensavel;
    if (temAcoes) {
      const acoes = document.createElement('div');
      acoes.className = 'cartao-info-acoes';
      if (acao && acao.rotulo) {
        const botaoAcao = texto('button', 'botao-secundario botao-pequeno', acao.rotulo);
        botaoAcao.type = 'button';
        botaoAcao.addEventListener('click', () => {
          if (typeof acao.aoClicar === 'function') acao.aoClicar();
        });
        acoes.appendChild(botaoAcao);
      }
      if (dispensavel && rotuloFechar) {
        const botaoFechar = texto('button', 'botao-link', rotuloFechar);
        botaoFechar.type = 'button';
        botaoFechar.addEventListener('click', () => fechar(card, id, aoFechar));
        acoes.appendChild(botaoFechar);
      }
      corpo.appendChild(acoes);
    }
    card.appendChild(corpo);

    if (dispensavel) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'cartao-info-fechar';
      x.setAttribute('aria-label', 'Fechar aviso');
      x.textContent = '×';
      x.addEventListener('click', () => fechar(card, id, aoFechar));
      card.appendChild(x);
    }
    return card;
  }

  // Fecha com uma saída curta (respeita "reduzir movimento" via CSS) e lembra.
  function fechar(card, id, aoFechar) {
    if (card.dataset.fechando === '1') return;
    card.dataset.fechando = '1';
    if (id) dispensar(id);
    card.classList.add('cartao-info-saindo');
    setTimeout(() => {
      card.remove();
      if (typeof aoFechar === 'function') aoFechar();
    }, 180);
  }

  // Coloca o card em "container", no lugar de qualquer card anterior. Devolve
  // o elemento, ou null se ele for dispensável e já tiver sido fechado.
  function montar(container, opcoes) {
    if (!container) return null;
    container.replaceChildren();
    if (opcoes.dispensavel && opcoes.id && foiDispensado(opcoes.id)) return null;
    const card = criar(opcoes);
    container.appendChild(card);
    return card;
  }

  function remover(container) {
    if (container) container.replaceChildren();
  }

  return { criar, montar, remover, foiDispensado };
})();
