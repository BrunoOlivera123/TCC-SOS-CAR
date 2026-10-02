// =================================================================
// Camada única de comunicação com a API (backend em server/server.js).
//
// Nenhuma outra parte do frontend usa "fetch" diretamente — todo mundo
// passa por aqui. Isso mantém num único lugar: o endereço base da API,
// como o token de sessão é anexado às requisições, e como os erros são
// tratados (transformados em uma mensagem de texto simples).
//
// "API" é um objeto só, criado por uma IIFE (Immediately Invoked
// Function Expression — uma função que é definida e já executada na
// hora, entre parênteses). Isso cria um "namespace" isolado: as
// variáveis internas (BASE, CHAVE_TOKEN, requisitar) não vazam para o
// resto do código, só o que é devolvido no "return" fica acessível.
// =================================================================
const API = (function () {
  const BASE = '/api';
  const CHAVE_TOKEN = 'sos-car-token'; // nome usado para guardar o token no localStorage

  // localStorage mantém os dados salvos mesmo depois de fechar a aba/
  // navegador — é assim que o usuário continua logado ao recarregar a
  // página (ver também app.js, função iniciar()).
  // O acesso ao localStorage é protegido por try/catch porque alguns
  // navegadores (modo privado, cookies/dados de site bloqueados) lançam
  // erro ao usá-lo — sem isso, o app inteiro deixaria de carregar.
  function obterToken() {
    try {
      return localStorage.getItem(CHAVE_TOKEN);
    } catch {
      return null;
    }
  }
  function definirToken(token) {
    try {
      if (token) localStorage.setItem(CHAVE_TOKEN, token);
      else localStorage.removeItem(CHAVE_TOKEN); // usado no logout
    } catch {
      // Sem armazenamento disponível: a sessão só vale até fechar a aba.
    }
  }

  // Função central: monta e envia a requisição HTTP, sempre anexando o
  // token de sessão (se existir) no cabeçalho Authorization, e traduz
  // respostas de erro num "throw" simples, para quem chamou poder usar
  // try/catch normalmente.
  async function requisitar(caminho, opcoes = {}) {
    const token = obterToken();
    const cabecalhos = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };
    if (token) cabecalhos.Authorization = `Bearer ${token}`;

    let resposta;
    try {
      resposta = await fetch(BASE + caminho, { cache: 'no-store', ...opcoes, headers: cabecalhos });
    } catch {
      // fetch só rejeita quando não chegou ao servidor (sem internet,
      // servidor fora do ar). Sem isto o usuário veria "Failed to fetch".
      const semConexao = new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
      semConexao.status = 0; // 0 = nem chegou ao servidor
      throw semConexao;
    }

    // Respostas 204 ("sem conteúdo", ex.: logout) não têm corpo JSON
    // para ler; nas demais, tentamos ler o JSON e, se falhar, seguimos
    // com null em vez de quebrar a aplicação.
    const corpo = resposta.status === 204 ? null : await resposta.json().catch(() => null);

    if (!resposta.ok) {
      // Token enviado e recusado (401): a sessão acabou — servidor
      // reiniciado ou 24 h passadas. Avisamos o app.js, que leva o usuário
      // de volta ao login em vez de deixar o painel falhando em silêncio.
      if (resposta.status === 401 && token) {
        definirToken(null);
        window.dispatchEvent(new CustomEvent('sessao-expirada'));
      }
      // O backend sempre manda { erro: "mensagem" } quando dá algo
      // errado (ver server.js) — usamos essa mensagem pronta para
      // mostrar direto na tela.
      const erro = new Error((corpo && corpo.erro) || 'Ocorreu um erro inesperado.');
      erro.status = resposta.status; // o app.js usa para decidir a mensagem (ver mensagemErroAcao)
      // Códigos opcionais do servidor (ex.: PERFIL_INCOMPLETO + lista "faltam").
      if (corpo && corpo.codigo) erro.codigo = corpo.codigo;
      if (corpo && Array.isArray(corpo.faltam)) erro.faltam = corpo.faltam;
      if (corpo && corpo.pendente) erro.pendente = true;
      throw erro;
    }
    return corpo;
  }

  // Uma função "de conveniência" para cada rota da API, para o resto do
  // código nunca precisar montar URL/método/corpo na mão.
  return {
    obterToken,
    definirToken,

    categorias: () => requisitar('/categorias'),
    geocodificar: (endereco) =>
      requisitar(`/localizacao/geocodificar?endereco=${encodeURIComponent(endereco)}`),
    reverseGeocodificar: (latitude, longitude) =>
      requisitar(`/localizacao/reverse?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`),

    registrar: (dados) => requisitar('/auth/registrar', { method: 'POST', body: JSON.stringify(dados) }),
    login: (dados) => requisitar('/auth/login', { method: 'POST', body: JSON.stringify(dados) }),
    logout: () => requisitar('/auth/logout', { method: 'POST' }),
    quemSouEu: () => requisitar('/auth/me'),
    esqueciSenha: (dados) => requisitar('/auth/esqueci-senha', { method: 'POST', body: JSON.stringify(dados) }),
    redefinirSenha: (dados) => requisitar('/auth/redefinir-senha', { method: 'POST', body: JSON.stringify(dados) }),
    googleConfig: () => requisitar('/auth/google/config'),
    // Pede um nonce de uso único; ele é entregue ao Google e volta DENTRO do ID token (anti-replay).
    googleNonce: () => requisitar('/auth/google/nonce'),
    // dados = { credential, tipo, categoriaId?, confirmarVinculo? } — "credential" é o ID token entregue pelo Google.
    loginGoogle: (dados) => requisitar('/auth/google', { method: 'POST', body: JSON.stringify(dados) }),
    // dados = { cpf?, telefone? } — só o que ainda falta no perfil.
    completarPerfil: (dados) => requisitar('/auth/completar-perfil', { method: 'POST', body: JSON.stringify(dados) }),
    loginAdmin: (dados) => requisitar('/auth/login-admin', { method: 'POST', body: JSON.stringify(dados) }),

    abrirChamado: (dados) => requisitar('/chamados', { method: 'POST', body: JSON.stringify(dados) }),
    chamadoAtual: () => requisitar('/chamados/atual'),
    atualizarLocalizacaoChamado: (id, dados) =>
      requisitar(`/chamados/${id}/localizacao`, { method: 'PATCH', body: JSON.stringify(dados) }),
    cancelarChamado: (id) => requisitar(`/chamados/${id}/cancelar`, { method: 'POST' }),
    avaliarChamado: (id, dados) =>
      requisitar(`/chamados/${id}/avaliacao`, { method: 'POST', body: JSON.stringify(dados) }),
    historico: () => requisitar('/chamados/historico'),

    atualizarDisponibilidade: (dados) =>
      requisitar('/prestador/disponibilidade', { method: 'PATCH', body: JSON.stringify(dados) }),
    // ordenar: 'proximos' (padrão) | 'recentes' | 'antigos'
    chamadosDisponiveis: (ordenar) =>
      requisitar('/chamados/disponiveis' + (ordenar ? `?ordenar=${encodeURIComponent(ordenar)}` : '')),

    // Central de Notificações (cliente e prestador)
    notificacoes: () => requisitar('/notificacoes'),
    marcarNotificacaoLida: (id) => requisitar(`/notificacoes/${encodeURIComponent(id)}/lida`, { method: 'POST' }),
    marcarTodasNotificacoesLidas: () => requisitar('/notificacoes/lidas', { method: 'POST' }),
    aceitarChamado: (id) => requisitar(`/chamados/${id}/aceitar`, { method: 'POST' }),
    iniciarAtendimento: (id) => requisitar(`/chamados/${id}/iniciar`, { method: 'POST' }),
    concluirAtendimento: (id) => requisitar(`/chamados/${id}/concluir`, { method: 'POST' }),
    // dados = { motivo, detalhe? } — o motivo é obrigatório (ver MOTIVOS_CANCELAMENTO no servidor).
    cancelarPorPrestador: (id, dados) =>
      requisitar(`/chamados/${id}/cancelar-prestador`, { method: 'POST', body: JSON.stringify(dados) }),
    // O cliente viu que o atendimento foi cancelado: libera o formulário de novo pedido.
    cancelamentoVisto: (id) => requisitar(`/chamados/${id}/cancelamento-visto`, { method: 'POST' }),
    atualizarUsuario: (dados) => requisitar('/auth/atualizar', { method: 'PATCH', body: JSON.stringify(dados) }),

    minhasAvaliacoes: () => requisitar('/prestador/me/avaliacoes'),

    adminEstatisticas: () => requisitar('/admin/estatisticas'),
    adminUsuarios: () => requisitar('/admin/usuarios'),
    // dados = { confirmarSemPerfil: true } quando o admin aceita aprovar um prestador sem CPF/telefone.
    adminAprovarPrestador: (id, dados) =>
      requisitar(`/admin/prestadores/${id}/aprovar`, { method: 'POST', body: JSON.stringify(dados || {}) }),
    adminChamados: (status) => requisitar('/admin/chamados' + (status ? `?status=${encodeURIComponent(status)}` : '')),
    adminCancelarChamado: (id) => requisitar(`/admin/chamados/${id}/cancelar`, { method: 'POST' }),
    adminCategorias: () => requisitar('/admin/categorias'),
    adminRenomearCategoria: (id, nome) =>
      requisitar(`/admin/categorias/${id}`, { method: 'PATCH', body: JSON.stringify({ nome }) })
  };
})();
