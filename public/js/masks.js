// =================================================================
// Máscaras de digitação para CPF e telefone.
//
// Enquanto a pessoa digita só números, o campo vai se formatando sozinho:
//   CPF:      52998224725   ->  529.982.247-25
//   Telefone: 18999990000   ->  (18) 99999-0000
//
// A máscara é só VISUAL. A validação de verdade (CPF com dígitos
// verificadores, telefone com DDD) é feita no servidor — o front nunca é a
// barreira de segurança.
//
// Os campos são encontrados pelo atributo "name" ("cpf" e "telefone"), então
// qualquer formulário novo com esses nomes ganha a máscara automaticamente.
// =================================================================
(function () {
  // Remove tudo que não for dígito ("(18) 9999" -> "189999").
  function apenasNumeros(s) {
    return (s || '').replace(/\D+/g, '');
  }

  // Formata como CPF: 000.000.000-00 (no máximo 11 dígitos).
  // Cada .replace insere um separador assim que o trecho anterior está
  // completo, então a formatação funciona também com o CPF pela metade.
  function mascaraCPF(valor) {
    const v = apenasNumeros(valor).slice(0, 11);
    return v
      .replace(/(\d{3})(\d)/, '$1.$2') // 1º ponto, depois dos 3 primeiros dígitos
      .replace(/(\d{3})(\d)/, '$1.$2') // 2º ponto, depois dos 6 primeiros
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2'); // hífen antes dos 2 últimos
  }

  // Formata como telefone brasileiro, com ou sem o 9 na frente.
  function mascaraTelefone(valor) {
    const v = apenasNumeros(valor);
    // aceita 10 ou 11 dígitos (com ou sem 9)
    if (v.length <= 10) {
      // Fixo / celular antigo: (00) 0000-0000
      return v
        .replace(/(\d{2})(\d)/, '($1) $2')
        .replace(/(\d{4})(\d)/, '$1-$2')
        .slice(0, 15);
    }
    // Celular com 9 dígitos: (00) 00000-0000
    return v
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{5})(\d)/, '$1-$2')
      .slice(0, 16);
  }

  // Reformata o campo de CPF mantendo o cursor no lugar certo. Sem esse
  // cuidado, editar um dígito no meio do número faria o cursor pular para o
  // final a cada tecla (porque trocar o .value reposiciona o cursor).
  function aplicarMascaraCPF(el) {
    // calcula quantos dígitos existem ANTES da posição atual do cursor
    const cursorNow = el.selectionStart || 0;
    const digitsBefore = apenasNumeros(el.value.slice(0, cursorNow)).length;
    const newFormatted = mascaraCPF(el.value);
    el.value = newFormatted;
    // recoloca o cursor logo depois do mesmo dígito, já no texto formatado
    const newPos = indexForDigitCount(newFormatted, digitsBefore);
    try { el.setSelectionRange(newPos, newPos); } catch (e) {
      // alguns tipos de campo não permitem mexer no cursor: tudo bem, ignora
    }
  }

  // Mesma lógica do CPF, para o telefone.
  function aplicarMascaraTelefone(el) {
    const cursorNow = el.selectionStart || 0;
    const digitsBefore = apenasNumeros(el.value.slice(0, cursorNow)).length;
    const newFormatted = mascaraTelefone(el.value);
    el.value = newFormatted;
    const newPos = indexForDigitCount(newFormatted, digitsBefore);
    try { el.setSelectionRange(newPos, newPos); } catch (e) {
      // ignora: <input type="tel"> normalmente aceita, mas não é garantido
    }
  }

  // Retorna a posição (índice) no string formatado onde se encontra o
  // dígito número `count` (quantos dígitos ficam antes). Ex.: se
  // count=3 retorna índice logo após o 3º dígito.
  function indexForDigitCount(formatted, count) {
    if (count <= 0) return 0;
    let digits = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) digits++;
      if (digits === count) return i + 1; // posição logo após este dígito
    }
    return formatted.length; // não achou: cursor no fim
  }

  // Liga as máscaras a todos os campos de CPF e telefone da página.
  function ligarMascaras() {
    const cpfs = document.querySelectorAll('input[name="cpf"]');
    const phones = document.querySelectorAll('input[name="telefone"]');

    cpfs.forEach((el) => {
      el.addEventListener('input', (e) => aplicarMascaraCPF(el)); // a cada tecla
      el.addEventListener('blur', () => (el.value = mascaraCPF(el.value))); // ao sair do campo (cobre colar/autopreencher)
    });

    phones.forEach((el) => {
      el.addEventListener('input', (e) => aplicarMascaraTelefone(el));
      el.addEventListener('blur', () => (el.value = mascaraTelefone(el.value)));
    });
  }

  // roda após DOM pronto
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligarMascaras);
  else ligarMascaras();
})();
