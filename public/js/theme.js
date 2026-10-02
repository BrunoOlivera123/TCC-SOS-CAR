// =================================================================
// Alterna entre tema claro e escuro.
//
// A troca de cores em si é toda feita em CSS (ver style.css, variáveis
// dentro de :root[data-tema='escuro']) — este script só decide QUAL
// tema usar e escreve isso no atributo "data-tema" da tag <html>, que é
// o que o CSS usa para saber qual conjunto de cores aplicar.
// =================================================================
(function () {
  const CHAVE = 'sos-car-tema'; // nome usado para guardar a escolha no localStorage
  const botao = document.getElementById('btn-tema');
  const iconeLua = botao.querySelector('.icone-lua');
  const iconeSol = botao.querySelector('.icone-sol');

  // localStorage pode lançar erro (modo privado, dados de site bloqueados).
  // Sem o try/catch, este script inteiro quebrava e o botão de tema ficava
  // sem função.
  function lerTemaSalvo() {
    try {
      return localStorage.getItem(CHAVE);
    } catch {
      return null;
    }
  }
  function guardarTema(tema) {
    try {
      localStorage.setItem(CHAVE, tema);
    } catch {
      // Sem armazenamento: o tema vale só até recarregar a página.
    }
  }

  // Aplica um tema: atualiza o atributo em <html>, troca o ícone do
  // botão (lua = "clique para escurecer", sol = "clique para clarear")
  // e lembra a escolha para a próxima visita.
  function aplicar(tema) {
    document.documentElement.setAttribute('data-tema', tema);
    iconeLua.classList.toggle('oculto', tema === 'escuro');
    iconeSol.classList.toggle('oculto', tema !== 'escuro');
    guardarTema(tema);
  }

  // Ao carregar a página: usa o tema que o usuário já escolheu antes
  // (se houver) ou, na primeira visita, respeita a preferência do
  // sistema operacional (prefers-color-scheme).
  const salvo = lerTemaSalvo();
  const preferidoPeloSistema = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
  aplicar(salvo || preferidoPeloSistema);

  // Clique no botão: alterna entre os dois temas.
  botao.addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-tema');
    aplicar(atual === 'escuro' ? 'claro' : 'escuro');
  });
})();
