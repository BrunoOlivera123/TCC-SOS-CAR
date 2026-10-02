// =================================================================
// SOS Car — animações de tamanho e de troca de tela (sem dependências).
//
// Regra de ouro: só transform/opacity/height, 140–420ms, sem bounce.
// Respeita prefers-reduced-motion (nesse caso tudo acontece na hora): quem
// configurou o sistema para reduzir movimento não vê animação nenhuma.
//
// Expõe um único objeto global, "Anim", usado pelo app.js:
//   Anim.altura(el, mutar, opcoes)  - anima a altura de um card ao trocar conteúdo
//   Anim.sair(el, classe, ms)       - faz uma tela/modal sumir suavemente
//   Anim.reduzir()                  - true se o usuário prefere menos movimento
// =================================================================
(function () {
  // O usuário pediu menos animação no sistema operacional/navegador?
  const reduzir = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Promise que resolve depois de "ms" milissegundos (permite usar await).
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const DUR_SAIDA = 150;   // conteúdo antigo some
  const DUR_ALTURA = 380;  // card cresce/encolhe
  // Guarda a animação em andamento de cada elemento (sem impedir que o
  // navegador libere o elemento da memória: é um WeakMap).
  const estado = new WeakMap();

  // Anima a altura de `el` (ex.: o card de login) enquanto `mutar()` troca o
  // conteúdo. `sai` = elemento que desaparece antes; `entra` = o que aparece
  // depois (recebe a classe .entrando, ver CSS). `mutar` deve ser idempotente
  // (definir o estado final), pois cliques rápidos cancelam a animação anterior.
  async function altura(el, mutar, { sai = null, entra = null } = {}) {
    // Sem elemento, com movimento reduzido ou escondido (altura 0): troca direto.
    if (!el || reduzir() || !el.offsetHeight) { mutar(); return; }

    // Se já havia uma animação neste elemento (clique rápido), cancela-a e
    // limpa as classes que ela tinha deixado.
    const anterior = estado.get(el);
    if (anterior) {
      anterior.cancelado = true;
      if (anterior.sai) anterior.sai.classList.remove('saindo-campo');
      if (anterior.entra) anterior.entra.classList.remove('entrando');
    }
    const token = { cancelado: false, sai, entra };
    estado.set(el, token);

    // Passo 1: congela o card na altura atual, sem transição, e esconde o que
    // transbordar (senão o conteúdo novo apareceria "vazando" durante a animação).
    const de = el.offsetHeight; // congela na altura atual (mesmo no meio de outra animação)
    el.style.transition = 'none';
    el.style.height = de + 'px';
    el.style.overflow = 'hidden';

    // Passo 2: o elemento antigo some (fade) antes da troca.
    if (sai) {
      sai.classList.add('saindo-campo');
      await espera(DUR_SAIDA);
      if (token.cancelado) return; // outra animação assumiu: para por aqui
      sai.classList.remove('saindo-campo');
    }

    // Passo 3: troca o conteúdo de verdade e dispara a entrada do novo.
    mutar();
    if (entra) {
      entra.classList.remove('entrando');
      void entra.offsetWidth; // força o navegador a "reiniciar" a animação CSS
      entra.classList.add('entrando');
    }

    // Passo 4: mede a altura natural do novo conteúdo e anima da altura antiga
    // até ela. ("void el.offsetHeight" força o navegador a aplicar o estilo
    // anterior antes de ligar a transição.)
    el.style.height = 'auto';
    const para = el.offsetHeight; // altura natural do novo conteúdo
    el.style.height = de + 'px';
    void el.offsetHeight;
    el.style.transition = `height ${DUR_ALTURA}ms var(--ease-suave)`;
    el.style.height = para + 'px';

    // Passo 5: ao terminar, devolve o controle da altura ao CSS normal.
    await espera(DUR_ALTURA + 40);
    if (token.cancelado) return;
    el.style.transition = el.style.height = el.style.overflow = '';
    if (entra) entra.classList.remove('entrando');
    estado.delete(el);
  }

  // Faz `el` (uma .tela ou .modal) sumir suavemente e devolve a Promise.
  // Quem chama esconde o elemento de vez (classe oculta) quando ela resolve.
  function sair(el, classe = 'saindo', ms = DUR_SAIDA) {
    if (!el || reduzir() || el.classList.contains('oculta') || el.classList.contains('oculto')) return Promise.resolve();
    el.classList.add(classe);
    return espera(ms).then(() => el.classList.remove(classe));
  }

  // <details> com abertura/fechamento animados (FAQ da Ajuda). O <details>
  // nativo abre e fecha de uma vez; aqui interceptamos o clique no <summary>
  // e animamos a altura com a Web Animations API.
  function detalhes(d) {
    const resumo = d.querySelector('summary');
    resumo.addEventListener('click', (e) => {
      if (reduzir()) return; // sem animação: deixa o comportamento nativo agir
      e.preventDefault(); // assumimos o controle de abrir/fechar
      if (d._anim) d._anim.cancel(); // clique durante a animação: recomeça
      const abrindo = !d.open;
      const h0 = d.offsetHeight; // altura de partida
      if (abrindo) d.open = true; // abre antes de medir a altura final
      // Fechando: a altura final é a do título (+ margem). Abrindo: a altura já aberta.
      const h1 = abrindo ? d.offsetHeight : resumo.offsetHeight + 24;
      d.style.overflow = 'hidden';
      d._anim = d.animate({ height: [h0 + 'px', h1 + 'px'] }, { duration: 300, easing: 'cubic-bezier(.22,.8,.24,1)' });
      // Ao terminar: se estava fechando, só agora fecha de verdade o <details>.
      d._anim.onfinish = () => { if (!abrindo) d.open = false; d.style.overflow = ''; d._anim = null; };
      d._anim.oncancel = () => { d.style.overflow = ''; };
    });
  }
  document.querySelectorAll('.faq-item').forEach(detalhes);

  // API pública usada pelo app.js.
  window.Anim = { altura, sair, reduzir };
})();
