// =================================================================
// Envio de e-mail para recuperação de senha
// Gmail + Nodemailer
// =================================================================

const nodemailer = require('nodemailer');

// Escapa caracteres especiais para evitar problemas no HTML
function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Verifica se o SMTP está configurado
function smtpConfigurado() {
  return Boolean(
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

// Transportador do Gmail
let transportador;

// Cria o transportador do Nodemailer na primeira vez e o reutiliza depois (a
// conexão com o servidor de e-mail é reaproveitada entre os envios).
function obterTransportador() {
  if (!transportador) {
    transportador = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  return transportador;
}

// Só para desenvolvimento local: sem SMTP configurado não há como o link chegar
// ao usuário, então (e SOMENTE se MOSTRAR_LINK_REDEFINICAO_NO_CONSOLE=1 e o
// NODE_ENV não for "production") o link é impresso no terminal do servidor.
// Por padrão o token NUNCA vai para o log: quem lê logs (hospedagem, suporte,
// monitoramento) poderia redefinir a senha de qualquer conta.
function logDeLinkPermitido() {
  return process.env.MOSTRAR_LINK_REDEFINICAO_NO_CONSOLE === '1' && process.env.NODE_ENV !== 'production';
}

// Mascara o e-mail nos logs (ma***@dominio.com) — o log diz que algo foi
// enviado/falhou sem expor o endereço inteiro.
function mascararEmail(email) {
  const [local = '', dominio = ''] = String(email).split('@');
  return `${local.slice(0, 2)}***@${dominio}`;
}

// Monta o link de redefinição. O token vai no FRAGMENTO (#), não na query
// string: o fragmento nunca é enviado ao servidor, não vai no cabeçalho
// Referer para CDNs/fontes/mapas, não entra em log de acesso e não é
// guardado pelo service worker. O frontend lê e apaga o fragmento da barra de
// endereço assim que a página abre (ver public/js/app.js, iniciar()).
function montarLinkRedefinicao(baseUrl, tipo, token) {
  return `${baseUrl}/#redefinir=1&tipo=${encodeURIComponent(tipo)}&token=${encodeURIComponent(token)}`;
}

// Envia o e-mail de redefinição de senha.
// NÃO devolve o link: quem chama (a rota) nunca deve poder repassá-lo ao
// navegador. Devolve só { enviado: boolean }.
async function enviarEmailRedefinicao({
  paraEmail,
  nome,
  tipo,
  token,
  appUrl
}) {

  const baseUrl = (appUrl ||
                  process.env.APP_URL ||
                  'http://localhost:3000').replace(/\/+$/, '');

  const link = montarLinkRedefinicao(baseUrl, tipo, token);

  // Caso o Gmail não esteja configurado
  if (!smtpConfigurado()) {
    if (logDeLinkPermitido()) {
      console.warn(
        `[e-mail] SMTP não configurado (modo de desenvolvimento).\n` +
        `Link de redefinição para ${mascararEmail(paraEmail)}:\n` +
        `${link}`
      );
    } else {
      console.warn(
        `[e-mail] SMTP não configurado: o e-mail de redefinição para ${mascararEmail(paraEmail)} NÃO foi enviado. ` +
        `Configure SMTP_USER/SMTP_PASS (ou, só em desenvolvimento, MOSTRAR_LINK_REDEFINICAO_NO_CONSOLE=1).`
      );
    }
    return { enviado: false };
  }

  try {

    await obterTransportador().sendMail({

      from: process.env.SMTP_FROM || process.env.SMTP_USER,

      to: paraEmail,

      subject: 'SOS Car — Redefinição de senha',

      text:
        `Olá, ${nome}!\n\n` +
        `Recebemos um pedido para redefinir sua senha no SOS Car.\n\n` +
        `Acesse o link abaixo para escolher uma nova senha ` +
        `(válido por 1 hora e de uso único):\n\n` +
        `${link}\n\n` +
        `Se você não pediu isso, apenas ignore este e-mail.`,

      html:
        `<p>Olá, ${escaparHtml(nome)}!</p>` +

        `<p>` +
        `Recebemos um pedido para redefinir sua senha no SOS Car.` +
        `</p>` +

        `<p>` +
        `Clique no botão abaixo para escolher uma nova senha ` +
        `(válido por 1 hora e de uso único):` +
        `</p>` +

        `<p>` +
        `<a href="${escaparHtml(link)}" target="_self" ` +
        `style="display:inline-block;` +
        `padding:12px 20px;` +
        `background:#2563eb;` +
        `color:white;` +
        `text-decoration:none;` +
        `border-radius:8px;">` +
        `Redefinir minha senha` +
        `</a>` +
        `</p>` +

        `<p>` +
        `Se você não solicitou a redefinição, apenas ignore este e-mail.` +
        `</p>`
    });

    console.log(`[e-mail] E-mail de redefinição enviado para ${mascararEmail(paraEmail)}`);

    return { enviado: true };

  } catch (erro) {

    // Só o motivo genérico: a mensagem do nodemailer pode citar o destinatário
    // ou trechos do envio, e o link/token nunca é registrado.
    console.warn(
      `[e-mail] Falha ao enviar para ${mascararEmail(paraEmail)}:`,
      erro && erro.code ? erro.code : 'erro de envio'
    );

    return { enviado: false };
  }
}

module.exports = {
  enviarEmailRedefinicao
};
