// =================================================================
// Validação de CPF (dígitos verificadores).
//
// Antes só se conferia se o CPF tinha 11 dígitos, então "111.111.111-11"
// ou "123.456.789-00" eram aceitos. Aqui aplicamos o algoritmo oficial da
// Receita Federal: os dois últimos dígitos do CPF são calculados a partir
// dos nove primeiros, então um CPF digitado errado (ou inventado) quase
// nunca passa.
//
// IMPORTANTE: isto valida a FORMA do número, não prova que o CPF existe
// nem que pertence a quem digitou — isso exigiria consultar a Receita.
// =================================================================

// Remove tudo que não for dígito ("529.982.247-25" -> "52998224725").
function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

// Calcula um dígito verificador: multiplica cada dígito por um peso
// decrescente (começando em "pesoInicial"), soma tudo e usa o resto da
// divisão por 11. Resto 0 ou 1 vira dígito 0; senão o dígito é 11 - resto.
function calcularDigito(digitos, pesoInicial) {
  let soma = 0;
  for (let i = 0; i < digitos.length; i += 1) {
    soma += Number(digitos[i]) * (pesoInicial - i);
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

// Devolve true se o texto é um CPF válido (com ou sem máscara).
function cpfValido(cpf) {
  const digitos = somenteDigitos(cpf);
  if (digitos.length !== 11) return false;

  // Sequências repetidas ("00000000000", "11111111111"...) passam na conta
  // dos dígitos verificadores, mas não são CPFs reais — recusamos.
  if (/^(\d)\1{10}$/.test(digitos)) return false;

  // 1º dígito verificador: usa os 9 primeiros dígitos (pesos 10..2).
  const d1 = calcularDigito(digitos.slice(0, 9), 10);
  // 2º dígito verificador: usa os 9 primeiros + o 1º verificador (pesos 11..2).
  const d2 = calcularDigito(digitos.slice(0, 10), 11);

  return d1 === Number(digitos[9]) && d2 === Number(digitos[10]);
}

module.exports = { cpfValido, somenteDigitos };
